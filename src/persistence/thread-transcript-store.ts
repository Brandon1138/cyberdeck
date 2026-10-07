import { JsonlOffsetReader } from "./jsonl-offset-reader.js";
import { ThreadSegmentIndex, parseThreadEvent } from "./thread-segment-index.js";
import { claudeProjectSlug, candidateDayDirectories, readCodexMetadata, parseClaudeTurn, parseCodexTurn, compareNativeTurns, visitLines, ignoreMissing, readCompleteLinesFromOffset, type NativeTurn } from "./thread-transcript-lines.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  ThreadEventSchema,
  type ThreadEvent,
  type ThreadReadResult,
} from "../domain/thread.js";
import {
  parseClaudeTranscriptLine,
  parseCodexRolloutLine,
  PREVIEW_MESSAGE_WINDOW,
  type TranscriptMessage,
} from "../runtime/conversation-preview.js";
import type {
  AppendWorkerTurnTranscriptEvent as AppendThreadEvent,
  CaptureWorkerTurns as CaptureProviderTurns,
  WorkerTurnObservation,
  WorkerTurnTranscript,
  WorkerTurnTranscriptPort,
} from "../orchestration/session/worker-turn-ports.js";
import { ClaudeConversationBindingStore } from "./claude-conversation-bindings.js";
import { observedModelParser, type ObservedModel } from "../runtime/observed-model.js";
import { isClaudeClearFrame } from "../runtime/claude-clear-frame.js";
export { isClaudeClearFrame };
import {
  parseCodexBudgetTelemetryLine,
  type ParsedProviderBudgetTelemetry,
  type ProviderBudgetWindow,
} from "../runtime/provider-budget-telemetry.js";
import { openPrivateAppendFile } from "./private-files.js";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 3;
const MAX_REMEMBERED_TURN_IDS = 100_000;
const CODEX_SESSION_MATCH_WINDOW_MS = 30_000;

export type {
  AppendWorkerTurnTranscriptEvent as AppendThreadEvent,
  CaptureWorkerTurns as CaptureProviderTurns,
} from "../orchestration/session/worker-turn-ports.js";

export interface ThreadTranscriptStoreOptions {
  now?: () => string;
  idFactory?: () => string;
  maxBytes?: number;
  retainedFiles?: number;
  claudeProjectsDirectory?: string;
  codexSessionsDirectory?: string;
  claudeConversations?: ClaudeConversationBindingStore;
}


/**
 * Whether a Claude session's semantic capture is following a file, and why it is not.
 *
 * `bound` — a transcript is being read for this session.
 * `cleared-unbound` — the file it was following ends in `/clear`, and no binding names the file the
 *   conversation moved to. Capture is dark on purpose: guessing at the newest file in the project
 *   directory would attribute one worker's conversation to another when they share a worktree.
 * `foreign-cwd` — a binding exists but names a different working directory than the session's.
 * `attribution-conflict` — another session also claims the file this session resolved to, either
 *   through its own durable binding or by already being read from it here. Every claimant of a
 *   shared file is refused, not just the later one.
 */
export type ClaudeTranscriptStatus =
  | "bound"
  | "cleared-unbound"
  | "foreign-cwd"
  | "attribution-conflict";

/**
 * Where a session's model observation last left off.
 *
 * `offset` only ever advances past complete lines, so a read that lands mid-write of the transcript's
 * newest frame simply leaves the offset short until the next call — never past a line whose bytes
 * arrived incomplete.
 */
interface NativeProjection {
  reader: JsonlOffsetReader;
  messages: TranscriptMessage[];
  turns: Map<string, NativeTurn>;
  cleared: boolean;
}

interface ObservedModelCursor {
  path: string;
  offset: number;
  observation: ObservedModel | undefined;
}

interface ProviderBudgetTelemetryCursor {
  path: string;
  offset: number;
  telemetry: ParsedProviderBudgetTelemetry;
}

/**
 * Bounded semantic transcript.
 *
 * New events use semantic-transcript.jsonl so broker startup never opens or parses legacy
 * transcript.jsonl. Reads stream retained segments. Provider output is one native final response
 * per turn; Cursor and Antigravity use explicitly marked terminal-replay fallback turns.
 */
export class ThreadTranscriptStore implements WorkerTurnTranscriptPort {
  readonly path: string;
  readonly legacyPath: string;
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private writeTail = Promise.resolve();
  private nextCursor = 0;
  private readonly segments = new ThreadSegmentIndex();
  private readonly nativeProjections = new Map<string, NativeProjection>();
  private readonly semanticTurnIds = new Set<string>();
  private readonly nativePaths = new Map<string, string>();
  private readonly observedModelCursors = new Map<string, ObservedModelCursor>();
  private readonly providerBudgetTelemetryCursors = new Map<string, ProviderBudgetTelemetryCursor>();
  private readonly claimedCodexPaths = new Map<string, string>();
  private readonly claimedClaudePaths = new Map<string, string>();
  private readonly claudeStatuses = new Map<string, ClaudeTranscriptStatus>();
  private readonly claudeConversations: ClaudeConversationBindingStore;

  constructor(
    stateDirectory: string,
    private readonly options: ThreadTranscriptStoreOptions = {},
  ) {
    const threadsDirectory = join(stateDirectory, "threads");
    this.path = join(threadsDirectory, "semantic-transcript.jsonl");
    this.legacyPath = join(threadsDirectory, "transcript.jsonl");
    this.claudeConversations = options.claudeConversations
      ?? new ClaudeConversationBindingStore(stateDirectory);
  }

  /**
   * Why a Claude session is or is not capturing, for callers that must not report silence as health.
   */
  claudeTranscriptStatus(sessionId: string): ClaudeTranscriptStatus | undefined {
    return this.claudeStatuses.get(sessionId);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization !== undefined) return this.initialization;
    this.initialization = this.loadMetadata();
    await this.initialization;
    this.initialized = true;
  }

  append(input: AppendThreadEvent): Promise<ThreadEvent> {
    return this.enqueueWrite(async () => {
      await this.init();
      const event = this.createEvent(input);
      await this.persist(event);
      this.rememberSemanticTurn(event);
      return event;
    });
  }

  /** Read and prepare provider turns without mutating the semantic transcript. */
  async observeProviderTurns(input: CaptureProviderTurns): Promise<WorkerTurnObservation> {
    await this.init();
    const nativeTurns = input.provider === "claude"
      ? await this.readClaudeTurns(input)
      : input.provider === "codex"
        ? await this.readCodexTurns(input)
        : [];
    // Cursor and Antigravity have no native transcript at all, so a fallback is their only turn and
    // is always allowed. For Claude and Codex the caller controls it, and only permits one after the
    // native read has been retried and come back empty.
    const fallbackAllowed = input.allowFallback
      ?? (input.provider === "cursor" || input.provider === "antigravity");
    const turns = nativeTurns.length > 0
      ? nativeTurns
      : fallbackAllowed
        ? [{
            id: `fallback:${input.turnNumber}`,
            occurredAt: this.options.now?.() ?? new Date().toISOString(),
            text: input.fallbackText ?? "No useful provider output yet",
          }]
        : [];
    // A Claude session whose conversation moved and could not be re-identified still produces
    // fallback turns, but they are labelled with the reason so a reader can tell a quiet worker
    // from one whose semantic capture went dark.
    const claudeStatus = input.provider === "claude"
      ? this.claudeStatuses.get(input.sessionId)
      : undefined;
    const unseenTurns = turns.filter((turn) => !this.semanticTurnIds.has(this.semanticKey(
      input.sessionId,
      `${input.provider}:${turn.id}`,
    )));
    return {
      sessionId: input.sessionId,
      provider: input.provider,
      turnNumber: input.turnNumber,
      turns: unseenTurns.map((turn) => ({
        providerTurnId: turn.id,
        providerOccurredAt: turn.occurredAt,
        text: turn.text,
        transport: nativeTurns.length > 0
          ? "provider-native" as const
          : "terminal-replay-fallback" as const,
        ...(claudeStatus === undefined || claudeStatus === "bound"
          ? {}
          : { data: { claudeTranscriptStatus: claudeStatus } }),
      })),
    };
  }

  /** Serialize append-once dedupe while acknowledging every observed turn as durably owned. */
  commitProviderTurns(observation: WorkerTurnObservation): Promise<WorkerTurnTranscript[]> {
    return this.enqueueWrite(async () => {
      await this.init();
      const receipts: WorkerTurnTranscript[] = [];
      for (const [index, turn] of observation.turns.entries()) {
        const semanticTurnId = `${observation.provider}:${turn.providerTurnId}`;
        const turnNumber = observation.turnNumber + index;
        const receipt = this.providerTurnReceipt(observation, turn, turnNumber);
        if (this.semanticTurnIds.has(this.semanticKey(observation.sessionId, semanticTurnId))) {
          receipts.push(receipt);
          continue;
        }
        const event = this.createEvent({
          sessionId: observation.sessionId,
          kind: "turn",
          source: "provider",
          text: receipt.text,
          data: receipt.data,
        });
        await this.persist(event);
        this.rememberSemanticTurn(event);
        receipts.push(event);
      }
      return receipts;
    });
  }

  /** Compatibility path for callers that have not yet adopted explicit observation ownership. */
  async captureProviderTurns(input: CaptureProviderTurns): Promise<WorkerTurnTranscript[]> {
    const observation = await this.observeProviderTurns(input);
    return this.commitProviderTurns(observation);
  }

  /**
   * Provider-native conversation messages for preview extraction.
   *
   * Distinct from `captureProviderTurns`, which only recognises a *completed* turn and therefore
   * has nothing to offer while a session is mid-turn, blocked on approval, or interrupted — exactly
   * the states the fleet view spends most of its time showing. This read accepts any assistant
   * message carrying text, so the preview never has to fall back to a pane scrape just because the
   * turn has not ended. Only the trailing window is retained; these files reach tens of megabytes.
   */
  async readTranscriptMessages(input: CaptureProviderTurns): Promise<TranscriptMessage[]> {
    await this.init();
    const parse = input.provider === "claude"
      ? parseClaudeTranscriptLine
      : input.provider === "codex"
        ? parseCodexRolloutLine
        : undefined;
    if (parse === undefined) return [];
    const path = input.provider === "claude"
      ? await this.resolveClaudeTranscript(input)
      : this.nativePaths.get(input.sessionId) ?? await this.findCodexTranscript(input);
    if (path === undefined) return [];
    const projection = await this.nativeProjection(input, path, "preview");
    return projection.cleared ? [] : [...projection.messages];
  }

  /**
   * The model this session is running now, read from the provider's own transcript.
   *
   * The last frame that names a model wins, because that is the one the provider wrote most
   * recently — an in-session switch is a later frame, never an edit to an earlier one. A provider
   * that keeps no native transcript answers nothing, and the caller is expected to say so rather
   * than pass the launch value off as an observation.
   *
   * Every completed turn calls this, and these files grow to tens of megabytes, so a full reread each
   * time is quadratic over a session's life. A byte-offset cursor per session lets each call scan only
   * what was appended since the last one. The cursor resets — offset back to zero, prior observation
   * discarded — whenever the resolved path changes (a rebind to a new native file) or the file is
   * now smaller than the cursor (truncation or rotation): either means the bytes the offset pointed
   * into no longer mean what they meant last time.
   */
  async readObservedModel(input: CaptureProviderTurns): Promise<ObservedModel | undefined> {
    await this.init();
    const parse = observedModelParser(input.provider);
    if (parse === undefined) return undefined;
    const path = input.provider === "claude"
      ? await this.resolveClaudeTranscript(input)
      : this.nativePaths.get(input.sessionId) ?? await this.findCodexTranscript(input);
    if (path === undefined) return undefined;

    const cached = this.observedModelCursors.get(input.sessionId);
    let cursor: ObservedModelCursor = cached !== undefined && cached.path === path
      ? cached
      : { path, offset: 0, observation: undefined };

    const size = await stat(path).then(
      (info) => info.size,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (size === undefined) return cursor.observation;
    if (size < cursor.offset) cursor = { path, offset: 0, observation: undefined };

    const { lines, nextOffset } = await readCompleteLinesFromOffset(path, cursor.offset);
    let observation = cursor.observation;
    for (const line of lines) {
      if (line.trim() === "") continue;
      observation = parse(line) ?? observation;
    }
    cursor = { path, offset: nextOffset, observation };
    this.observedModelCursors.set(input.sessionId, cursor);
    if (observation !== undefined) this.nativePaths.set(input.sessionId, path);
    return observation;
  }

  /**
   * Read provider-authored usage without promoting absence to zero.
   *
   * Codex currently supplies cumulative tokens and, in supported CLI frames, primary/secondary
   * allowance windows. Other interactive adapters expose no provider-wide usage contract yet and
   * therefore return an empty observation. Byte cursors keep repeated budget checks linear in new
   * transcript data rather than file size.
   */
  async readProviderBudgetTelemetry(
    input: CaptureProviderTurns,
    window: ProviderBudgetWindow,
  ): Promise<ParsedProviderBudgetTelemetry> {
    await this.init();
    if (input.provider !== "codex") return {};
    const path = this.nativePaths.get(input.sessionId) ?? await this.findCodexTranscript(input);
    if (path === undefined) return {};
    this.nativePaths.set(input.sessionId, path);
    this.claimedCodexPaths.set(path, input.sessionId);
    const key = `${input.sessionId}\0${window}`;
    const cached = this.providerBudgetTelemetryCursors.get(key);
    let cursor: ProviderBudgetTelemetryCursor = cached !== undefined && cached.path === path
      ? cached
      : { path, offset: 0, telemetry: {} };
    const size = await stat(path).then(
      (info) => info.size,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (size === undefined) return cursor.telemetry;
    if (size < cursor.offset) cursor = { path, offset: 0, telemetry: {} };
    const { lines, nextOffset } = await readCompleteLinesFromOffset(path, cursor.offset);
    let telemetry = cursor.telemetry;
    for (const line of lines) {
      const parsed = parseCodexBudgetTelemetryLine(line, window);
      if (parsed === undefined) continue;
      telemetry = {
        ...(parsed.totalTokens === undefined
          ? telemetry.totalTokens === undefined
            ? {}
            : { totalTokens: telemetry.totalTokens, tokenObservedAt: telemetry.tokenObservedAt }
          : { totalTokens: parsed.totalTokens, tokenObservedAt: parsed.tokenObservedAt }),
        ...(parsed.providerUsage === undefined
          ? telemetry.providerUsage === undefined ? {} : { providerUsage: telemetry.providerUsage }
          : { providerUsage: parsed.providerUsage }),
      };
    }
    cursor = { path, offset: nextOffset, telemetry };
    this.providerBudgetTelemetryCursors.set(key, cursor);
    return {
      ...(telemetry.totalTokens === undefined
        ? {}
        : { totalTokens: telemetry.totalTokens, tokenObservedAt: telemetry.tokenObservedAt }),
      ...(telemetry.providerUsage === undefined ? {} : { providerUsage: { ...telemetry.providerUsage } }),
    };
  }

  async read(sessionId: string, afterCursor = 0, limit = 200): Promise<ThreadReadResult> {
    await this.init();
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    return this.enqueueWrite(() => this.segments.read(this.segmentPathsOldestFirst(), afterCursor, boundedLimit, sessionId));
  }

  async changes(afterCursor = 0, limit = 500): Promise<ThreadReadResult> {
    await this.init();
    return this.enqueueWrite(() => this.segments.read(this.segmentPathsOldestFirst(), afterCursor, Math.max(1, Math.min(limit, 2_000))));
  }

  private async loadMetadata(): Promise<void> {
    for (const path of this.segmentPathsOldestFirst()) {
      await visitLines(path, (line) => {
        const event = parseThreadEvent(line);
        if (event === undefined) return true;
        this.nextCursor = Math.max(this.nextCursor, event.cursor);
        this.rememberSemanticTurn(event);
        return true;
      });
    }
  }

  private rememberSemanticTurn(event: ThreadEvent): void {
    const semanticTurnId = event.data.semanticTurnId;
    if (typeof semanticTurnId === "string") {
      const key = this.semanticKey(event.sessionId, semanticTurnId);
      this.semanticTurnIds.delete(key);
      this.semanticTurnIds.add(key);
      while (this.semanticTurnIds.size > MAX_REMEMBERED_TURN_IDS) {
        const oldest = this.semanticTurnIds.values().next().value;
        if (oldest === undefined) break;
        this.semanticTurnIds.delete(oldest);
      }
    }
  }

  private semanticKey(sessionId: string, semanticTurnId: string): string {
    return `${sessionId}:${semanticTurnId}`;
  }

  /** Reconstruct the exact bounded semantic payload acknowledged by an append or dedupe hit. */
  private providerTurnReceipt(
    observation: WorkerTurnObservation,
    turn: WorkerTurnObservation["turns"][number],
    turnNumber: number,
  ): { text: string; data: Record<string, unknown> } {
    const text = this.boundEventText(turn.text) ?? "";
    const data = {
      semantic: true,
      semanticTurnId: `${observation.provider}:${turn.providerTurnId}`,
      provider: observation.provider,
      transport: turn.transport,
      originalLength: turn.text.length,
      turnNumber,
      providerOccurredAt: turn.providerOccurredAt,
      ...(turn.data ?? {}),
    };
    return {
      text,
      data: text === turn.text ? data : { ...data, storageOriginalLength: turn.text.length },
    };
  }

  private createEvent(input: AppendThreadEvent): ThreadEvent {
    const text = this.boundEventText(input.text);
    return ThreadEventSchema.parse({
      id: this.options.idFactory?.() ?? randomUUID(),
      cursor: ++this.nextCursor,
      sessionId: input.sessionId,
      occurredAt: this.options.now?.() ?? new Date().toISOString(),
      kind: input.kind,
      source: input.source,
      ...(text === undefined ? {} : { text }),
      data: text === input.text
        ? input.data ?? {}
        : { ...input.data, storageOriginalLength: input.text?.length },
    });
  }

  /** Queue one complete stateful write operation while allowing the queue to recover after errors. */
  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(event: ThreadEvent): Promise<void> {
    const serialized = `${JSON.stringify(event)}\n`;
    await this.rotateIfNeeded(Buffer.byteLength(serialized));
    const handle = await openPrivateAppendFile(this.path);
    try {
      await handle.write(serialized, undefined, "utf8");
    } finally {
      await handle.close();
    }
  }

  private boundEventText(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    const maximumBytes = Math.max(256, this.maximumFileBytes() - 4_096);
    if (Buffer.byteLength(text) <= maximumBytes) return text;
    const marker = `\n\n[storage elision; original length: ${text.length} characters]`;
    const prefixBytes = maximumBytes - Buffer.byteLength(marker);
    const prefix = Buffer.from(text).subarray(0, prefixBytes).toString("utf8").replace(/\ufffd$/u, "");
    return `${prefix}${marker}`;
  }

  private async rotateIfNeeded(nextBytes: number): Promise<void> {
    const maximum = this.maximumFileBytes();
    if (nextBytes > maximum) {
      throw new Error(`Semantic transcript event exceeds ${maximum} byte segment limit`);
    }
    const current = await stat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (current === undefined || current.size === 0 || current.size + nextBytes <= maximum) return;
    const retained = Math.max(1, this.options.retainedFiles ?? DEFAULT_RETAINED_FILES);
    await unlink(this.rotatedPath(retained)).catch(ignoreMissing);
    for (let index = retained - 1; index >= 1; index -= 1) {
      await rename(this.rotatedPath(index), this.rotatedPath(index + 1)).catch(ignoreMissing);
    }
    await rename(this.path, this.rotatedPath(1));
  }

  private maximumFileBytes(): number {
    return Math.max(1_024, this.options.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  private segmentPathsOldestFirst(): string[] {
    const retained = Math.max(1, this.options.retainedFiles ?? DEFAULT_RETAINED_FILES);
    const paths: string[] = [];
    for (let index = retained; index >= 1; index -= 1) paths.push(this.rotatedPath(index));
    paths.push(this.path);
    return paths;
  }

  private rotatedPath(index: number): string {
    return join(this.path.replace(/\.jsonl$/u, `.${index}.jsonl`));
  }

  /**
   * The file Claude was launched against: `--session-id` is Cyberdeck's own session id, so before
   * any `/clear` the conversation is named by the session record alone and needs no signal at all.
   */
  private claudeLaunchTranscriptPath(input: CaptureProviderTurns): string {
    return join(
      this.options.claudeProjectsDirectory ?? join(homedir(), ".claude", "projects"),
      claudeProjectSlug(input.cwd),
      `${input.sessionId}.jsonl`,
    );
  }

  /**
   * Which file this session's Claude conversation is in right now.
   *
   * A `/clear` starts a new native conversation under a new id while the session record, PTY and
   * actor binding all stay alive, so the launch-derived path stops receiving turns without anything
   * failing. The authoritative answer comes from Claude itself: the SessionStart hook Cyberdeck
   * installs per session reports `transcript_path` for every `startup`, `resume`, `clear` and
   * `compact`, keyed by the Cyberdeck session id fixed in the hook's own command line.
   *
   * Everything else fails closed. There is deliberately no cwd-only and no newest-file search:
   * several workers can share one worktree, and the wrong worker's conversation recorded as this
   * one's is worse than no capture at all.
   */
  private async resolveClaudeTranscript(
    input: CaptureProviderTurns,
  ): Promise<string | undefined> {
    const binding = await this.claudeConversations.read(input.sessionId);
    if (binding !== undefined && binding.cwd !== input.cwd) {
      return this.refuseClaudeTranscript(input.sessionId, "foreign-cwd");
    }
    const path = binding?.transcriptPath ?? this.claudeLaunchTranscriptPath(input);
    // The durable bindings are the whole answer to "who else claims this file", and they are
    // consulted before anything in memory. An in-memory claim only exists for a session this
    // process has already read, so a restarted broker holding two bindings that name one file
    // would otherwise let whichever session read first capture it and refuse only the second —
    // attribution decided by read order. Every claimant of a shared path is refused instead,
    // including a session whose launch-derived path some other session's binding has named.
    const durableClaimants = await this.claudeConversations.sessionsBoundTo(path);
    if (durableClaimants.some((sessionId) => sessionId !== input.sessionId)) {
      return this.refuseClaudeTranscript(input.sessionId, "attribution-conflict");
    }
    const claimedBy = this.claimedClaudePaths.get(path);
    if (claimedBy !== undefined && claimedBy !== input.sessionId) {
      return this.refuseClaudeTranscript(input.sessionId, "attribution-conflict");
    }
    return path;
  }

  /**
   * Forget a retired session's Claude conversation, on disk and in memory alike.
   *
   * A session id is never reused, so a binding that outlives its thread is pure residue — and not
   * inert residue: it still counts as a claimant, so a stale binding can refuse capture for a live
   * session that legitimately holds the same path.
   */
  async dropClaudeBinding(sessionId: string): Promise<void> {
    await this.claudeConversations.remove(sessionId);
    this.claudeStatuses.delete(sessionId);
    for (const [path, owner] of this.claimedClaudePaths) {
      if (owner === sessionId) this.claimedClaudePaths.delete(path);
    }
  }

  private refuseClaudeTranscript(
    sessionId: string,
    status: ClaudeTranscriptStatus,
  ): undefined {
    this.claudeStatuses.set(sessionId, status);
    for (const [path, owner] of this.claimedClaudePaths) {
      if (owner === sessionId) this.claimedClaudePaths.delete(path);
    }
    return undefined;
  }

  private async nativeProjection(input: CaptureProviderTurns, path: string, purpose: "turns" | "preview"): Promise<NativeProjection> {
    const key = `${purpose}:${input.sessionId}`;
    let projection = this.nativeProjections.get(key);
    if (projection === undefined) {
      const messages: TranscriptMessage[] = [], turns = new Map<string, NativeTurn>();
      projection = { messages, turns, cleared: false, reader: undefined! };
      const value = projection;
      value.reader = new JsonlOffsetReader(() => { messages.length = 0; turns.clear(); value.cleared = false; });
    }
    this.nativeProjections.delete(key); this.nativeProjections.set(key, projection);
    // Eviction only forgets an acceleration; semantic receipt dedup remains authoritative.
    while (this.nativeProjections.size > 256) this.nativeProjections.delete(this.nativeProjections.keys().next().value!);
    const value = projection;
    for (const id of value.turns.keys()) {
      if (this.semanticTurnIds.has(this.semanticKey(input.sessionId, `${input.provider}:${id}`))) value.turns.delete(id);
    }
    await value.reader.scan(path, (line) => {
      if (input.provider === "claude" && isClaudeClearFrame(line)) { value.cleared = true; return; }
      if (purpose === "preview") {
        const message = input.provider === "claude" ? parseClaudeTranscriptLine(line) : parseCodexRolloutLine(line);
        if (message !== undefined) { value.messages.push(message); if (value.messages.length > PREVIEW_MESSAGE_WINDOW) value.messages.shift(); }
      } else {
        const turn = input.provider === "claude" ? parseClaudeTurn(line, this.options.now) : parseCodexTurn(line, this.options.now);
        if (turn !== undefined && !this.semanticTurnIds.has(this.semanticKey(input.sessionId, `${input.provider}:${turn.id}`))) value.turns.set(turn.id, turn);
      }
    });
    if (input.provider === "claude") {
      if (value.cleared) this.refuseClaudeTranscript(input.sessionId, "cleared-unbound");
      else { this.claimedClaudePaths.set(path, input.sessionId); this.claudeStatuses.set(input.sessionId, "bound"); }
    } else { this.nativePaths.set(input.sessionId, path); this.claimedCodexPaths.set(path, input.sessionId); }
    return value;
  }

  private async readClaudeTurns(input: CaptureProviderTurns): Promise<NativeTurn[]> {
    const path = await this.resolveClaudeTranscript(input);
    if (path === undefined) return [];
    const projection = await this.nativeProjection(input, path, "turns");
    return projection.cleared ? [] : [...projection.turns.values()].sort(compareNativeTurns);
  }

  private async readCodexTurns(input: CaptureProviderTurns): Promise<NativeTurn[]> {
    const path = this.nativePaths.get(input.sessionId) ?? await this.findCodexTranscript(input);
    if (path === undefined) return [];
    return [...(await this.nativeProjection(input, path, "turns")).turns.values()].sort(compareNativeTurns);
  }

  private async findCodexTranscript(input: CaptureProviderTurns): Promise<string | undefined> {
    const root = this.options.codexSessionsDirectory
      ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
    const createdAt = Date.parse(input.createdAt);
    const candidates: Array<{ path: string; distance: number; id: string }> = [];
    for (const directory of candidateDayDirectories(root, createdAt)) {
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const path = join(directory, entry.name);
        const claimedBy = this.claimedCodexPaths.get(path);
        if (claimedBy !== undefined && claimedBy !== input.sessionId) continue;
        const metadata = await readCodexMetadata(path);
        if (metadata === undefined || metadata.cwd !== input.cwd) continue;
        const distance = Math.abs(Date.parse(metadata.timestamp) - createdAt);
        if (distance <= CODEX_SESSION_MATCH_WINDOW_MS) {
          candidates.push({ path, distance, id: metadata.id });
        }
      }
    }
    candidates.sort((left, right) =>
      left.distance - right.distance || left.id.localeCompare(right.id)
    );
    return candidates[0]?.path;
  }
}

export async function pruneLegacyTranscript(
  stateDirectory: string,
  confirmed: boolean,
): Promise<{ path: string; removed: boolean }> {
  const path = join(stateDirectory, "threads", "transcript.jsonl");
  if (!confirmed) {
    throw new Error("Legacy transcript prune requires --confirm-delete-legacy-transcript");
  }
  try {
    await unlink(path);
    return { path, removed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, removed: false };
    throw error;
  }
}
