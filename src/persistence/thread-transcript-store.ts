import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { readdir, rename, stat, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  ThreadEventSchema,
  type ThreadEvent,
  type ThreadEventKind,
  type ThreadEventSource,
  type ThreadReadResult,
} from "../domain/thread.js";
import {
  parseClaudeTranscriptLine,
  parseCodexRolloutLine,
  PREVIEW_MESSAGE_WINDOW,
  type TranscriptMessage,
} from "../runtime/conversation-preview.js";
import { ClaudeConversationBindingStore } from "./claude-conversation-bindings.js";
import { observedModelParser, type ObservedModel } from "../runtime/observed-model.js";
import { openPrivateAppendFile } from "./private-files.js";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 3;
const MAX_REMEMBERED_TURN_IDS = 100_000;
const CODEX_SESSION_MATCH_WINDOW_MS = 30_000;

export interface AppendThreadEvent {
  sessionId: string;
  kind: ThreadEventKind;
  source: ThreadEventSource;
  text?: string;
  data?: Record<string, unknown>;
}

export interface CaptureProviderTurns {
  sessionId: string;
  provider: string;
  cwd: string;
  createdAt: string;
  turnNumber: number;
  fallbackText?: string;
  /**
   * Whether a terminal-replay turn may stand in when the provider's own transcript has nothing.
   *
   * The caller retries a provider-native read a few times before giving up, so it passes `false`
   * until the last attempt. On that attempt it must be `true` for every provider: a completed turn
   * with no `turn` event at all is the cursor gap MIK-71 reported, where a worker was marked
   * completed and `thread_read` showed nothing to account for it.
   */
  allowFallback?: boolean;
}

export interface ThreadTranscriptStoreOptions {
  now?: () => string;
  idFactory?: () => string;
  maxBytes?: number;
  retainedFiles?: number;
  claudeProjectsDirectory?: string;
  codexSessionsDirectory?: string;
  claudeConversations?: ClaudeConversationBindingStore;
}

interface NativeTurn {
  id: string;
  occurredAt: string;
  text: string;
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
interface ObservedModelCursor {
  path: string;
  offset: number;
  observation: ObservedModel | undefined;
}

/**
 * Bounded semantic transcript.
 *
 * New events use semantic-transcript.jsonl so broker startup never opens or parses legacy
 * transcript.jsonl. Reads stream retained segments. Provider output is one native final response
 * per turn; Cursor and Antigravity use explicitly marked terminal-replay fallback turns.
 */
export class ThreadTranscriptStore {
  readonly path: string;
  readonly legacyPath: string;
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private writeTail = Promise.resolve();
  private nextCursor = 0;
  private readonly semanticTurnIds = new Set<string>();
  private readonly nativePaths = new Map<string, string>();
  private readonly observedModelCursors = new Map<string, ObservedModelCursor>();
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

  async append(input: AppendThreadEvent): Promise<ThreadEvent> {
    await this.init();
    const text = this.boundEventText(input.text);
    const event = ThreadEventSchema.parse({
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
    this.writeTail = this.writeTail.then(
      () => this.persist(event),
      () => this.persist(event),
    );
    await this.writeTail;
    this.rememberSemanticTurn(event);
    return event;
  }

  async captureProviderTurns(input: CaptureProviderTurns): Promise<ThreadEvent[]> {
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
    const captured: ThreadEvent[] = [];
    for (const turn of turns) {
      const semanticTurnId = `${input.provider}:${turn.id}`;
      if (this.semanticTurnIds.has(this.semanticKey(input.sessionId, semanticTurnId))) continue;
      captured.push(await this.append({
        sessionId: input.sessionId,
        kind: "turn",
        source: "provider",
        text: turn.text,
        data: {
          semantic: true,
          semanticTurnId,
          provider: input.provider,
          transport: nativeTurns.length > 0 ? "provider-native" : "terminal-replay-fallback",
          originalLength: turn.text.length,
          turnNumber: input.turnNumber + captured.length,
          providerOccurredAt: turn.occurredAt,
          ...(claudeStatus === undefined || claudeStatus === "bound"
            ? {}
            : { claudeTranscriptStatus: claudeStatus }),
        },
      }));
    }
    return captured;
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
    const collect = (line: string): void => {
      const message = parse(line);
      if (message !== undefined) {
        messages.push(message);
        if (messages.length > PREVIEW_MESSAGE_WINDOW) messages.shift();
      }
    };
    const messages: TranscriptMessage[] = [];
    if (input.provider === "claude") {
      const claudePath = await this.resolveClaudeTranscript(input);
      if (claudePath === undefined) return [];
      // A preview that keeps rendering the pre-`/clear` conversation is the stale record MIK-46
      // reported, so an abandoned file yields nothing and the caller falls back to the pane.
      const usable = await this.visitClaudeTranscript(input.sessionId, claudePath, collect);
      return usable ? messages : [];
    }
    const path = this.nativePaths.get(input.sessionId) ?? await this.findCodexTranscript(input);
    if (path === undefined) return [];
    await visitLines(path, (line) => {
      collect(line);
      return true;
    });
    if (messages.length > 0) this.nativePaths.set(input.sessionId, path);
    return messages;
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

  async read(sessionId: string, afterCursor = 0, limit = 200): Promise<ThreadReadResult> {
    await this.init();
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    return this.streamEvents(
      (event) => event.sessionId === sessionId && event.cursor > afterCursor,
      afterCursor,
      boundedLimit,
    );
  }

  async changes(afterCursor = 0, limit = 500): Promise<ThreadReadResult> {
    await this.init();
    const boundedLimit = Math.max(1, Math.min(limit, 2_000));
    return this.streamEvents(
      (event) => event.cursor > afterCursor,
      afterCursor,
      boundedLimit,
    );
  }

  private async streamEvents(
    include: (event: ThreadEvent) => boolean,
    afterCursor: number,
    limit: number,
  ): Promise<ThreadReadResult> {
    const events: ThreadEvent[] = [];
    for (const path of this.segmentPathsOldestFirst()) {
      await visitLines(path, (line) => {
        const event = parseThreadEvent(line);
        if (event !== undefined && include(event)) events.push(event);
        return events.length < limit;
      });
      if (events.length >= limit) break;
    }
    return { events, nextCursor: events.at(-1)?.cursor ?? afterCursor };
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

  /**
   * One pass over a Claude transcript that also answers whether the conversation left it.
   *
   * `/clear` is written into the file being abandoned as a final `<command-name>/clear</command-name>`
   * user frame, so the file states its own death. Reading it is what turns a silent stop into a
   * detected one, and it costs nothing: every caller already streams the whole file.
   */
  private async visitClaudeTranscript(
    sessionId: string,
    path: string,
    visitor: (line: string) => void,
  ): Promise<boolean> {
    let cleared = false;
    await visitLines(path, (line) => {
      if (isClaudeClearFrame(line)) {
        cleared = true;
        return true;
      }
      visitor(line);
      return true;
    });
    if (cleared) {
      this.refuseClaudeTranscript(sessionId, "cleared-unbound");
      return false;
    }
    this.claimedClaudePaths.set(path, sessionId);
    this.claudeStatuses.set(sessionId, "bound");
    return true;
  }

  private async readClaudeTurns(input: CaptureProviderTurns): Promise<NativeTurn[]> {
    const path = await this.resolveClaudeTranscript(input);
    if (path === undefined) return [];
    const byId = new Map<string, NativeTurn>();
    const usable = await this.visitClaudeTranscript(input.sessionId, path, (line) => {
      const turn = parseClaudeTurn(line, this.options.now);
      if (turn !== undefined) byId.set(turn.id, turn);
    });
    if (!usable) return [];
    return [...byId.values()].sort(compareNativeTurns);
  }

  private async readCodexTurns(input: CaptureProviderTurns): Promise<NativeTurn[]> {
    const path = this.nativePaths.get(input.sessionId) ?? await this.findCodexTranscript(input);
    if (path === undefined) return [];
    this.nativePaths.set(input.sessionId, path);
    this.claimedCodexPaths.set(path, input.sessionId);
    const byId = new Map<string, NativeTurn>();
    await visitLines(path, (line) => {
      const turn = parseCodexTurn(line, this.options.now);
      if (turn !== undefined) byId.set(turn.id, turn);
      return true;
    });
    return [...byId.values()].sort(compareNativeTurns);
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

function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/gu, "-");
}

function candidateDayDirectories(root: string, timestamp: number): string[] {
  const directories = new Set<string>();
  for (const offset of [-86_400_000, 0, 86_400_000]) {
    const date = new Date(timestamp + offset);
    directories.add(join(
      root,
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ));
  }
  return [...directories];
}

async function readCodexMetadata(
  path: string,
): Promise<{ id: string; timestamp: string; cwd: string } | undefined> {
  let metadata: { id: string; timestamp: string; cwd: string } | undefined;
  await visitLines(path, (line) => {
    try {
      const frame = JSON.parse(line) as {
        type?: unknown;
        payload?: {
          id?: unknown;
          timestamp?: unknown;
          cwd?: unknown;
          originator?: unknown;
        };
      };
      const payload = frame.payload;
      if (
        frame.type === "session_meta"
        && payload?.originator === "codex-tui"
        && typeof payload.id === "string"
        && typeof payload.timestamp === "string"
        && typeof payload.cwd === "string"
      ) {
        metadata = { id: payload.id, timestamp: payload.timestamp, cwd: payload.cwd };
      }
    } catch {
      // Ignore incomplete or unrelated provider frames.
    }
    return false;
  });
  return metadata;
}

function parseClaudeTurn(line: string, now: (() => string) | undefined): NativeTurn | undefined {
  try {
    const frame = JSON.parse(line) as {
      type?: unknown;
      timestamp?: unknown;
      uuid?: unknown;
      message?: {
        id?: unknown;
        role?: unknown;
        stop_reason?: unknown;
        content?: unknown;
      };
    };
    const message = frame.message;
    if (
      frame.type !== "assistant"
      || message?.role !== "assistant"
      || message.stop_reason !== "end_turn"
      || !Array.isArray(message.content)
    ) return undefined;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } =>
        typeof block === "object"
        && block !== null
        && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
      )
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    const id = typeof message.id === "string"
      ? message.id
      : typeof frame.uuid === "string"
        ? frame.uuid
        : undefined;
    if (id === undefined || text === "") return undefined;
    return {
      id,
      occurredAt: typeof frame.timestamp === "string"
        ? frame.timestamp
        : now?.() ?? new Date().toISOString(),
      text,
    };
  } catch {
    return undefined;
  }
}

const CLAUDE_CLEAR_COMMAND = "<command-name>/clear</command-name>";

/**
 * The `/clear` Claude writes as the last user frame of the conversation it is abandoning.
 *
 * Deliberately strict about *where* the marker sits. The same literal appears inside ordinary
 * conversation whenever a session greps its own transcripts or quotes this file, and those arrive
 * as tool-result user frames carrying `toolUseResult`. Only a frame whose entire content opens with
 * the command block is Claude's own record of the command.
 */
export function isClaudeClearFrame(line: string): boolean {
  if (!line.includes(CLAUDE_CLEAR_COMMAND)) return false;
  try {
    const frame = JSON.parse(line) as {
      type?: unknown;
      toolUseResult?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    if (frame.type !== "user" || frame.toolUseResult !== undefined) return false;
    const content = frame.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .map((block) =>
            typeof block === "object"
            && block !== null
            && typeof (block as { text?: unknown }).text === "string"
              ? (block as { text: string }).text
              : ""
          )
          .join("")
        : "";
    return text.trimStart().startsWith(CLAUDE_CLEAR_COMMAND);
  } catch {
    return false;
  }
}

function parseCodexTurn(line: string, now: (() => string) | undefined): NativeTurn | undefined {
  try {
    const frame = JSON.parse(line) as {
      type?: unknown;
      timestamp?: unknown;
      payload?: {
        type?: unknown;
        turn_id?: unknown;
        last_agent_message?: unknown;
      };
    };
    const payload = frame.payload;
    if (
      frame.type !== "event_msg"
      || payload?.type !== "task_complete"
      || typeof payload.turn_id !== "string"
      || typeof payload.last_agent_message !== "string"
      || payload.last_agent_message.trim() === ""
    ) return undefined;
    return {
      id: payload.turn_id,
      occurredAt: typeof frame.timestamp === "string"
        ? frame.timestamp
        : now?.() ?? new Date().toISOString(),
      text: payload.last_agent_message,
    };
  } catch {
    return undefined;
  }
}

function parseThreadEvent(line: string): ThreadEvent | undefined {
  try {
    const parsed = ThreadEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function compareNativeTurns(left: NativeTurn, right: NativeTurn): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

async function visitLines(
  path: string,
  visitor: (line: string) => boolean,
): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() !== "" && !visitor(line)) break;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== "ENOENT") throw error;
}

/**
 * The complete newline-terminated lines appended after `offset`, and the offset just past the last
 * one. A trailing line with no terminating `\n` yet — the writer mid-append — is left unread and
 * `nextOffset` stops before it, so the next call picks it back up whole rather than parsing a
 * half-written frame.
 */
async function readCompleteLinesFromOffset(
  path: string,
  offset: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { start: offset });
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream.on("end", resolve);
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
  if (chunks.length === 0) return { lines: [], nextOffset: offset };
  const buffer = Buffer.concat(chunks);
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) return { lines: [], nextOffset: offset };
  const lines = buffer
    .subarray(0, lastNewline + 1)
    .toString("utf8")
    .split("\n")
    .slice(0, -1)
    .map((line) => line.replace(/\r$/u, ""));
  return { lines, nextOffset: offset + lastNewline + 1 };
}
