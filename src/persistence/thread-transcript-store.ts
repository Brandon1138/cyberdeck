import { providerTurnReceipt, WorkerLedgerStore, mergeWorkerLedgers } from "./worker-ledger-store.js";
import { syncPrivateFile } from "./atomic-private-file.js";
import { InstructionTargetIndex } from "./instruction-target-index.js";
import { JsonlOffsetReader } from "./jsonl-offset-reader.js";
import { ThreadSegmentIndex, parseThreadEvent } from "./thread-segment-index.js";
import { claudeProjectSlug, ClaudeTurnStops, parseCodexTurn, parseCodexAbort, parseNativeActivity, compareNativeTurns, visitLines, ignoreMissing, readCompleteLinesFromOffset, type NativeTurn } from "./thread-transcript-lines.js";
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
  WorkerTurnLedger,
  NativeSourceStatus,
} from "../orchestration/session/worker-turn-ports.js";
import { ClaudeConversationBindingStore } from "./claude-conversation-bindings.js";
import { CodexConversationBindingStore } from "./codex-conversation-bindings.js";
import { CodexConversationDiscovery } from "./codex-conversation-discovery.js";
import { nativeSourceFailure, validateNativeFrame } from "./native-source-observation.js";
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
  codexConversations?: CodexConversationBindingStore;
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
  | "attribution-conflict"
  | "source-error";

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
  claudeStops: ClaudeTurnStops;
  activity: "working" | "idle" | "unknown";
  activityEvidence?: WorkerTurnObservation["nativeActivityEvidence"];
  codexClosedThroughId?: string;
  codexClosedThroughOffset?: number;
}

interface NativeTurnRead { turns: NativeTurn[]; available: boolean; activityVersion?: string;
  nativeSessionId?: string; nativeActivity?: WorkerTurnObservation["nativeActivity"];
  nativeActivityEvidence?: WorkerTurnObservation["nativeActivityEvidence"];
  status?: NativeSourceStatus; reason?: string; }

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
  private readonly completionLedgers = new Map<string, WorkerTurnLedger>();
  private readonly instructionTargets = new InstructionTargetIndex();
  private readonly workerLedgers: WorkerLedgerStore;
  private readonly hydratedLedgers = new Map<string, Promise<void>>();
  private readonly retiredSessions = new Set<string>();
  private readonly nativeTurnOrdinals = new Set<string>();
  private readonly initialInstructions = new Map<string, { id: string; text?: string }>();
  private readonly observedModelCursors = new Map<string, ObservedModelCursor>();
  private readonly providerBudgetTelemetryCursors = new Map<string, ProviderBudgetTelemetryCursor>();
  private readonly claimedClaudePaths = new Map<string, string>();
  private readonly claudeStatuses = new Map<string, ClaudeTranscriptStatus>();
  private readonly codexStatuses = new Map<string, { status: NativeSourceStatus; reason?: string }>();
  private readonly claudeConversations: ClaudeConversationBindingStore;
  private readonly codexConversations: CodexConversationBindingStore;
  private readonly codexDiscovery: CodexConversationDiscovery;

  constructor(
    stateDirectory: string,
    private readonly options: ThreadTranscriptStoreOptions = {},
  ) {
    this.workerLedgers = new WorkerLedgerStore(stateDirectory);
    const threadsDirectory = join(stateDirectory, "threads");
    this.path = join(threadsDirectory, "semantic-transcript.jsonl");
    this.legacyPath = join(threadsDirectory, "transcript.jsonl");
    this.claudeConversations = options.claudeConversations
      ?? new ClaudeConversationBindingStore(stateDirectory);
    this.codexConversations = options.codexConversations ?? new CodexConversationBindingStore(stateDirectory);
    this.codexDiscovery = new CodexConversationDiscovery(this.codexConversations);
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
    this.initialization = this.loadMetadata().then(async () => {
      for (const sessionId of new Set([...this.completionLedgers.keys(), ...this.instructionTargets.sessionIds()])) await this.hydrateWorkerLedger(sessionId);
    });
    await this.initialization;
    this.initialized = true;
  }

  append(input: AppendThreadEvent): Promise<ThreadEvent> {
    return this.enqueueWrite(async () => {
      await this.init();
      if (this.retiredSessions.has(input.sessionId) && (input.kind === "turn" || input.kind === "instruction")) throw new Error("THREAD_RETIRED");
      await this.hydrateWorkerLedger(input.sessionId);
      const event = this.createEvent(input);
      await this.persist(event);
      this.rememberSemanticTurn(event);
      if (event.kind === "turn" || (event.kind === "instruction" && event.data.instructionState === "rendered")) await this.persistWorkerLedger(event.sessionId);
      return event;
    });
  }

  /** Read and prepare provider turns without mutating the semantic transcript. */
  async observeProviderTurns(input: CaptureProviderTurns): Promise<WorkerTurnObservation> {
    await this.init();
    await this.hydrateWorkerLedger(input.sessionId);
    let native: NativeTurnRead;
    try {
      native = input.provider === "claude" ? await this.readClaudeTurns(input)
        : input.provider === "codex" ? await this.readCodexTurns(input) : { turns: [], available: false };
    } catch (error) {
      const failure = nativeSourceFailure(error);
      native = { turns: [], available: false, status: failure.status, reason: failure.reason };
    }
    const { turns: nativeTurns, available: nativeAvailable, activityVersion } = native;
    // Cursor and Antigravity have no native transcript at all, so a fallback is their only turn and
    // is always allowed. For Claude and Codex the caller controls it, and only permits one after the
    // native read has been retried and come back empty.
    const nativeProvider = input.provider === "claude" || input.provider === "codex";
    const fallbackRequested = nativeProvider ? input.allowFallback === true && native.status === "missing"
      : input.allowFallback ?? (input.provider === "cursor" || input.provider === "antigravity");
    const nativeOrdinal = this.semanticKey(input.sessionId, `${input.provider}:${input.turnNumber}`);
    const fallbackAllowed = fallbackRequested && input.turnNumber > (this.completionLedgers.get(input.sessionId)?.completedTurns ?? 0)
      && !this.nativeTurnOrdinals.has(nativeOrdinal);
    const turns = nativeAvailable
      ? nativeTurns
      : fallbackAllowed
        ? [{
            id: `fallback:${input.turnNumber}`,
            occurredAt: this.options.now?.() ?? new Date().toISOString(),
            text: input.fallbackText ?? "No useful provider output yet",
          }]
        : [];
    // Unbound/conflicting/error evidence never authorizes a replay completion. Missing-source
    // fallback remains explicitly labelled and must have the caller's own-terminal authorization.
    const claudeStatus = input.provider === "claude"
      ? this.claudeStatuses.get(input.sessionId)
      : undefined;
    const committedThrough = this.completionLedgers.get(input.sessionId)?.providerOccurredThrough;
    const unseenTurns = turns.filter((turn) => !(input.provider === "claude" && nativeAvailable
      && committedThrough !== undefined && turn.occurredAt <= committedThrough)
      && !this.semanticTurnIds.has(this.semanticKey(
      input.sessionId,
      `${input.provider}:${turn.id}`,
    )));
    return {
      sessionId: input.sessionId,
      provider: input.provider,
      turnNumber: input.turnNumber,
      ...(activityVersion === undefined ? {} : { activityVersion }),
      ...(nativeProvider ? {
        nativeSourceAvailable: nativeAvailable,
        nativeSourceStatus: native.status ?? (nativeAvailable ? "available" : "unbound"),
        nativeFallbackAllowed: fallbackAllowed,
        ...(native.reason === undefined ? {} : { nativeSourceReason: native.reason }),
        nativeActivity: native.nativeActivity ?? "unknown",
        ...(native.nativeSessionId === undefined ? {} : { nativeSessionId: native.nativeSessionId }),
        ...(native.nativeActivityEvidence === undefined ? {} : { nativeActivityEvidence: native.nativeActivityEvidence }),
      } : {}),
      turns: unseenTurns.map((turn) => ({
        providerTurnId: turn.id,
        providerOccurredAt: turn.occurredAt,
        text: turn.text,
        transport: nativeAvailable
          ? "provider-native" as const
          : "terminal-replay-fallback" as const,
        ...(turn.data === undefined ? {} : { data: turn.data }),
        ...(claudeStatus === undefined || claudeStatus === "bound"
          ? {}
          : { data: { ...turn.data, claudeTranscriptStatus: claudeStatus } }),
        ...(native.nativeSessionId === undefined || !nativeAvailable ? {} : { data: {
          ...turn.data, nativeSessionId: native.nativeSessionId,
          ...(claudeStatus === undefined || claudeStatus === "bound" ? {} : { claudeTranscriptStatus: claudeStatus }),
        } }),
        ...(!nativeProvider || nativeAvailable ? {} : { data: {
          ...(claudeStatus === undefined ? {} : { claudeTranscriptStatus: claudeStatus }),
          nativeSourceStatus: native.status, nativeSourceReason: native.reason,
        } }),
      })),
    };
  }

  async readCompletionLedger(sessionId: string): Promise<WorkerTurnLedger> {
    await this.init();
    await this.hydrateWorkerLedger(sessionId);
    const ledger = this.completionLedgers.get(sessionId);
    return ledger === undefined ? { completedTurns: 0, canonicalTurns: 0, turns: [], instructionTargets: this.instructionTargets.read(sessionId) }
      : { ...ledger, turns: [...ledger.turns], instructionTargets: this.instructionTargets.read(sessionId) };
  }

  /** Serialize append-once dedupe while acknowledging every observed turn as durably owned. */
  commitProviderTurns(observation: WorkerTurnObservation): Promise<WorkerTurnTranscript[]> {
    return this.enqueueWrite(async () => {
      await this.init();
      if (this.retiredSessions.has(observation.sessionId)) throw new Error("THREAD_RETIRED");
      await this.hydrateWorkerLedger(observation.sessionId);
      const receipts: WorkerTurnTranscript[] = [];
      for (const [index, turn] of observation.turns.entries()) {
        const semanticTurnId = `${observation.provider}:${turn.providerTurnId}`;
        const turnNumber = observation.turnNumber + index;
        if (turn.transport === "terminal-replay-fallback"
          && this.nativeTurnOrdinals.has(this.semanticKey(observation.sessionId, `${observation.provider}:${turnNumber}`))) continue;
        const receipt = providerTurnReceipt(observation, turn, turnNumber, this.boundEventText(turn.text) ?? "",
          this.completionLedgers.get(observation.sessionId)?.canonicalTurns ?? 0);
        if (this.semanticTurnIds.has(this.semanticKey(observation.sessionId, semanticTurnId))) {
          // A repeated provider ID owns its original durable ordinal/outcome. Reconstructing it
          // with the caller's newer target can turn a late abort into a second closed turn.
          const original = await this.originalTurnReceipt(observation.sessionId, semanticTurnId);
          if (original !== undefined) receipts.push({ text: original.text, data: original.data });
          continue;
        }
        const event = this.createEvent({
          sessionId: observation.sessionId,
          kind: "turn",
          source: turn.transport === "broker-lifecycle" ? "broker" : "provider",
          text: receipt.text,
          data: receipt.data,
        });
        await this.persist(event);
        this.rememberSemanticTurn(event);
        await this.persistWorkerLedger(event.sessionId);
        receipts.push(event);
      }
      return receipts;
    });
  }

  private async originalTurnReceipt(sessionId: string, semanticTurnId: string): Promise<WorkerTurnTranscript | undefined> {
    const recent = this.completionLedgers.get(sessionId)?.turns.find((turn) => turn.data?.semanticTurnId === semanticTurnId);
    if (recent !== undefined) return recent;
    let cursor = 0;
    for (;;) {
      const page = await this.segments.read(this.segmentPathsOldestFirst(), cursor, 1_000, sessionId);
      const event = page.events.find((value) => value.kind === "turn" && value.data.semanticTurnId === semanticTurnId);
      if (event !== undefined) return event;
      if (page.events.length === 0 || page.nextCursor <= cursor) return undefined;
      cursor = page.nextCursor;
    }
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
      : await this.findCodexTranscript(input);
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
      : await this.findCodexTranscript(input);
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
    const path = await this.findCodexTranscript(input);
    if (path === undefined) return {};
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
    for (const sessionId of this.retiredSessions) await this.workerLedgers.remove(sessionId);
  }

  private rememberSemanticTurn(event: ThreadEvent): void {
    if (event.kind === "lifecycle" && event.data.turnLedgerRetired === true) {
      this.retiredSessions.add(event.sessionId);
      this.completionLedgers.delete(event.sessionId); this.instructionTargets.remove(event.sessionId);
      this.initialInstructions.delete(event.sessionId);
    }
    if (this.retiredSessions.has(event.sessionId)) return;
    this.instructionTargets.observe(event);
    if (event.kind === "prompt" && event.data.initial === true && typeof event.data.instructionId === "string") {
      this.initialInstructions.set(event.sessionId, { id: event.data.instructionId,
        ...(event.text === undefined || event.data.storageOriginalLength !== undefined ? {} : { text: event.text }) });
    }
    if (event.kind === "turn" && typeof event.data.turnNumber === "number"
      && typeof event.data.semanticTurnId === "string"
      && !this.semanticTurnIds.has(this.semanticKey(event.sessionId, event.data.semanticTurnId))) {
      const previous = this.completionLedgers.get(event.sessionId)
        ?? { completedTurns: 0, canonicalTurns: 0, turns: [] };
      const canonicalTurns = previous.canonicalTurns + (event.data.transport === "provider-native" ? 1 : 0);
      this.completionLedgers.set(event.sessionId, {
        completedTurns: Math.max(previous.completedTurns, event.data.turnNumber),
        canonicalTurns: Math.max(canonicalTurns,
          typeof event.data.canonicalTurns === "number" ? event.data.canonicalTurns : 0),
        ...(event.data.transport === "provider-native" && typeof event.data.providerOccurredAt === "string"
          ? { providerOccurredThrough: [previous.providerOccurredThrough ?? "", event.data.providerOccurredAt].sort().at(-1)! }
          : previous.providerOccurredThrough === undefined ? {} : { providerOccurredThrough: previous.providerOccurredThrough }),
        turns: [...previous.turns, event].slice(-64),
        ...(event.data.transport === "provider-native" ? { lastNativeTurn: event } : previous.lastNativeTurn === undefined ? {} : { lastNativeTurn: previous.lastNativeTurn }),
      });
    }
    if (event.data.transport === "provider-native" && typeof event.data.provider === "string"
      && typeof event.data.turnNumber === "number") {
      this.nativeTurnOrdinals.add(this.semanticKey(event.sessionId, `${event.data.provider}:${event.data.turnNumber}`));
      while (this.nativeTurnOrdinals.size > MAX_REMEMBERED_TURN_IDS) {
        this.nativeTurnOrdinals.delete(this.nativeTurnOrdinals.values().next().value!);
      }
    }
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

  private hydrateWorkerLedger(sessionId: string): Promise<void> {
    if (this.retiredSessions.has(sessionId)) return Promise.resolve();
    let pending = this.hydratedLedgers.get(sessionId);
    if (pending === undefined) {
      pending = this.workerLedgers.read(sessionId).then(async stored => {
        if (this.retiredSessions.has(sessionId)) return;
        const targets = this.instructionTargets.read(sessionId);
        this.instructionTargets.restore(sessionId, stored?.instructionTargets ?? []);
        this.instructionTargets.restore(sessionId, targets);
        const ledger = mergeWorkerLedgers(stored, this.completionLedgers.get(sessionId));
        this.completionLedgers.set(sessionId, ledger);
        for (const turn of [...ledger.turns, ...(ledger.lastNativeTurn === undefined ? [] : [ledger.lastNativeTurn])]) {
          if (typeof turn.data?.semanticTurnId === "string") this.semanticTurnIds.add(this.semanticKey(sessionId, turn.data.semanticTurnId));
        }
        const fences = this.instructionTargets.read(sessionId);
        const dirty = stored === undefined ? ledger.completedTurns > 0 || fences.length > 0
          : ledger.completedTurns !== stored.completedTurns || ledger.canonicalTurns !== stored.canonicalTurns
            || ledger.lastNativeTurn?.data?.semanticTurnId !== stored.lastNativeTurn?.data?.semanticTurnId
            || fences.some(target => !stored.instructionTargets?.some(old => old.expectedTurn === target.expectedTurn && old.instructionId === target.instructionId && old.renderedAt === target.renderedAt));
        if (dirty) await this.workerLedgers.write(sessionId, { ...ledger, instructionTargets: fences });
      });
      pending = pending.catch(error => { this.hydratedLedgers.delete(sessionId); throw error; });
      this.hydratedLedgers.set(sessionId, pending);
    }
    return pending;
  }

  private async persistWorkerLedger(sessionId: string): Promise<void> {
    const ledger = this.completionLedgers.get(sessionId) ?? { completedTurns: 0, canonicalTurns: 0, turns: [] };
    await this.workerLedgers.write(sessionId, { ...ledger, instructionTargets: this.instructionTargets.read(sessionId) });
  }

  dropTurnLedger(sessionId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.init();
      const event = this.createEvent({ sessionId, kind: "lifecycle", source: "broker",
        text: "turn ledger retired", data: { turnLedgerRetired: true } });
      await this.persist(event);
      await syncPrivateFile(this.path);
      this.rememberSemanticTurn(event);
      await this.workerLedgers.remove(sessionId);
      this.hydratedLedgers.delete(sessionId); this.completionLedgers.delete(sessionId); this.instructionTargets.remove(sessionId);
    });
  }

  private semanticKey(sessionId: string, semanticTurnId: string): string {
    return `${sessionId}:${semanticTurnId}`;
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
    if (binding === undefined && await this.claudeConversations.revision(input.sessionId) !== undefined) {
      return this.refuseClaudeTranscript(input.sessionId, "source-error");
    }
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

  /** A retired session must not remain a durable claimant of a native Codex conversation. */
  async dropCodexBinding(sessionId: string): Promise<void> {
    await this.codexConversations.remove(sessionId);
    this.codexStatuses.delete(sessionId);
    this.nativeProjections.delete(`turns:${sessionId}`);
    this.nativeProjections.delete(`preview:${sessionId}`);
    this.observedModelCursors.delete(sessionId);
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
      projection = { messages, turns, activity: "unknown", cleared: false, claudeStops: new ClaudeTurnStops(), reader: undefined! };
      const value = projection;
      value.reader = new JsonlOffsetReader(() => { messages.length = 0; turns.clear(); value.claudeStops.reset(); value.activity = "unknown"; value.activityEvidence = undefined; delete value.codexClosedThroughOffset; value.cleared = false; });
    }
    this.nativeProjections.delete(key); this.nativeProjections.set(key, projection);
    // Eviction only forgets an acceleration; semantic receipt dedup remains authoritative.
    while (this.nativeProjections.size > 256) this.nativeProjections.delete(this.nativeProjections.keys().next().value!);
    const value = projection;
    const codexIdentity = input.provider === "codex" ? (await this.codexConversations.read(input.sessionId))?.nativeSessionId : undefined;
    if (input.provider === "codex" && purpose === "turns") {
      const committedId = this.codexCommittedTurnId(input.sessionId);
      if (committedId !== value.codexClosedThroughId) {
        const offset = committedId === undefined ? undefined : value.turns.get(committedId)?.sourceOffset;
        if (committedId === undefined) delete value.codexClosedThroughId;
        else value.codexClosedThroughId = committedId;
        if (offset === undefined) delete value.codexClosedThroughOffset;
        else value.codexClosedThroughOffset = offset;
      }
    }
    for (const id of value.turns.keys()) {
      if (this.semanticTurnIds.has(this.semanticKey(input.sessionId, `${input.provider}:${id}`))) value.turns.delete(id);
    }
    await value.reader.scan(path, (line, offset, bytes) => {
      if (line.trim() === "") return;
      validateNativeFrame(input.provider, line, codexIdentity, input.cwd);
      if (input.provider === "claude" && isClaudeClearFrame(line)) { value.cleared = true; return; }
      if (purpose === "preview") {
        const message = input.provider === "claude" ? parseClaudeTranscriptLine(line) : parseCodexRolloutLine(line);
        if (message !== undefined) { value.messages.push(message); if (value.messages.length > PREVIEW_MESSAGE_WINDOW) value.messages.shift(); }
      } else {
        const codexTurn = input.provider === "codex" ? parseCodexTurn(line, this.options.now) ?? parseCodexAbort(line, offset, this.options.now) : undefined;
        const turns = input.provider === "claude" ? value.claudeStops.observe(line, this.options.now)
          : codexTurn === undefined ? [] : [codexTurn];
        for (const turn of turns) {
          if (input.provider === "codex") {
            turn.sourceOffset = offset + bytes;
            if (turn.id === value.codexClosedThroughId && value.codexClosedThroughOffset === undefined) {
              value.codexClosedThroughOffset = turn.sourceOffset;
            }
          }
          if (!value.turns.has(turn.id) && !this.semanticTurnIds.has(this.semanticKey(input.sessionId, `${input.provider}:${turn.id}`))) value.turns.set(turn.id, turn);
        }
        const activity = parseNativeActivity(input.provider, line, offset, turns);
        if (input.provider === "codex" && activity?.evidence.kind === "turn_aborted"
          && activity.evidence.providerTurnId === value.codexClosedThroughId && value.codexClosedThroughOffset === undefined) {
          value.codexClosedThroughOffset = offset + bytes;
        }
        if (activity !== undefined
          && !(activity.evidence.occurredAt !== undefined && value.activityEvidence?.occurredAt !== undefined
            && activity.evidence.occurredAt < value.activityEvidence.occurredAt)
          && !(activity.state === "idle" && value.activity === "working"
            && value.activityEvidence?.providerTurnId !== undefined && activity.evidence.providerTurnId !== undefined
            && value.activityEvidence.providerTurnId !== activity.evidence.providerTurnId)) {
          value.activity = activity.state; value.activityEvidence = activity.evidence;
        }
      }
    });
    if (input.provider === "claude") {
      if (value.cleared) this.refuseClaudeTranscript(input.sessionId, "cleared-unbound");
      else { this.claimedClaudePaths.set(path, input.sessionId); this.claudeStatuses.set(input.sessionId, "bound"); }
    }
    return value;
  }

  private async readClaudeTurns(input: CaptureProviderTurns): Promise<NativeTurnRead> {
    const path = await this.resolveClaudeTranscript(input);
    if (path === undefined) return this.unavailableClaudeTurns(input.sessionId);
    // Retain explicit terminal fallback when no provider transcript exists at all.
    if (await stat(path).catch(ignoreMissing) === undefined) return { turns: [], available: false,
      status: "missing", reason: "NATIVE_SOURCE_MISSING" };
    const projection = await this.nativeProjection(input, path, "turns");
    const nativeSessionId = (await this.claudeConversations.read(input.sessionId))?.nativeSessionId ?? input.sessionId;
    return projection.cleared ? this.unavailableClaudeTurns(input.sessionId)
      // An exact Claude binding owns completion even while its first frame is still being written.
      : { turns: [...projection.turns.values()].sort(compareNativeTurns), available: true, status: "available", nativeSessionId,
        activityVersion: `${path}:${projection.reader.offset}:${projection.activityEvidence?.id ?? "unknown"}`, nativeActivity: projection.activity,
        ...(projection.activityEvidence === undefined ? {} : { nativeActivityEvidence: {
          ...projection.activityEvidence, nativeSessionId, receiptData: { nativeSessionId },
        } }) };
  }

  private unavailableClaudeTurns(sessionId: string): NativeTurnRead {
    const reason = this.claudeStatuses.get(sessionId) ?? "cleared-unbound";
    return { turns: [], available: false, reason,
      status: reason === "source-error" ? "source-error" : reason === "cleared-unbound" ? "unbound" : "conflict" };
  }

  private async readCodexTurns(input: CaptureProviderTurns): Promise<NativeTurnRead> {
    const path = await this.findCodexTranscript(input);
    if (path === undefined) return { turns: [], available: false, ...this.codexStatuses.get(input.sessionId) };
    const projection = await this.nativeProjection(input, path, "turns");
    const binding = await this.codexConversations.read(input.sessionId);
    // Recover by the last durable native receipt's exact frame boundary. Timestamp ties and clock
    // skew cannot make an old receipt new, or discard a later receipt with the same timestamp.
    const turns = projection.codexClosedThroughId !== undefined && projection.codexClosedThroughOffset === undefined
      ? [] : [...projection.turns.values()].filter((turn) =>
        turn.sourceOffset! > (projection.codexClosedThroughOffset ?? 0))
        .sort((left, right) => left.sourceOffset! - right.sourceOffset!);
    return { turns, available: true, status: "available",
      activityVersion: `${binding?.nativeSessionId}:${projection.reader.offset}:${projection.activityEvidence?.id ?? "unknown"}`,
      ...(binding === undefined ? {} : { nativeSessionId: binding.nativeSessionId }),
      nativeActivity: projection.activity,
      ...(projection.activityEvidence === undefined ? {} : { nativeActivityEvidence: {
        ...projection.activityEvidence,
        ...(binding === undefined ? {} : { nativeSessionId: binding.nativeSessionId, receiptData: { nativeSessionId: binding.nativeSessionId } }),
      } }) };
  }

  private codexCommittedTurnId(sessionId: string): string | undefined {
    const ledger = this.completionLedgers.get(sessionId);
    const turns = [...ledger?.turns ?? [], ...(ledger?.lastNativeTurn === undefined ? [] : [ledger.lastNativeTurn])];
    for (const turn of [...turns].reverse()) {
      const id = turn.data?.semanticTurnId;
      if (turn.data?.transport === "provider-native" && typeof id === "string" && id.startsWith("codex:")) {
        return id.slice("codex:".length);
      }
    }
    return undefined;
  }

  private launchIdentity(input: CaptureProviderTurns): { id: string; text?: string } | undefined {
    const stored = this.initialInstructions.get(input.sessionId);
    return input.initialInstructionId === undefined || input.initialInstructionId === stored?.id
      ? stored : { id: input.initialInstructionId };
  }

  private async findCodexTranscript(input: CaptureProviderTurns): Promise<string | undefined> {
    const root = this.options.codexSessionsDirectory
      ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
    const resolved = await this.codexDiscovery.resolve(input, this.launchIdentity(input), root);
    this.codexStatuses.set(input.sessionId, resolved);
    return resolved.path;
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
