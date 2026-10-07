import { createHash, type Hash } from "node:crypto";
import { readFile, readdir, type FileHandle } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { SessionRecord } from "../../domain/session.js";
import type { ObservedWorkerTurn } from "../../orchestration/session/worker-turn-ports.js";
import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";
import { openContainedSource } from "./contained-source.js";
import { nativeSourceLines, nativeSourceLinesFromFile } from "./native-source-lines.js";
import { nativeTimestamp, object } from "./provider-activity-collector.js";
import { observedModelParser, type ObservedModel } from "../observed-model.js";
import { parseClaudeTranscriptLine, parseCodexRolloutLine, type TranscriptMessage } from "../conversation-preview.js";
import { isClaudeClearFrame } from "../claude-clear-frame.js";
import { parseCodexBudgetTelemetryLine, type ParsedProviderBudgetTelemetry, type ProviderBudgetWindow } from "../provider-budget-telemetry.js";

export const ContainerNativeBindingSchema = z.object({ sessionId: z.uuid(), nativeSessionId: z.uuid(),
  provider: z.enum(["claude", "codex"]), relativePath: z.string().min(1) }).strict();
export interface PendingNativeInterval {
  sourceRoot: string; path: string; fromOffset: number; throughOffset: number; generation: number;
  executionId?: string; startedAt?: string; providerTurnId?: string;
}
interface NativeProjection {
  turns: ObservedWorkerTurn[]; messages: TranscriptMessage[]; model?: ObservedModel;
  budgets: Record<ProviderBudgetWindow, ParsedProviderBudgetTelemetry>;
  start: number; end: number; startedAt: string | undefined; pendingTurnId: string | undefined;
  retainedBytes: number; previewBytes: number;
}
interface CachedProjection {
  identity: string; stamp: string; size: number; prefixHash: string; projection: NativeProjection;
}
const MAX_PROJECTION_BYTES = 16 * 1024 * 1024;
const MAX_PROJECTION_SESSIONS = 64;

export class ContainerNativeSource {
  private readonly projections = new Map<string, CachedProjection>();
  private readonly reads = new Map<string, Promise<unknown>>();
  private retainedBytes = 0;
  constructor(private readonly root: string) {}
  /** Explicit retirement hook; capacity eviction also bounds retained inactive sessions. */
  forget(sessionId: string): void {
    const prior = this.projections.get(sessionId);
    if (prior) this.retainedBytes -= prior.projection.retainedBytes;
    this.projections.delete(sessionId);
  }
  private retain(sessionId: string, cached: CachedProjection): void {
    this.forget(sessionId);
    if (cached.projection.retainedBytes > MAX_PROJECTION_BYTES) return;
    this.projections.set(sessionId, cached);
    this.retainedBytes += cached.projection.retainedBytes;
    while (this.projections.size > MAX_PROJECTION_SESSIONS || this.retainedBytes > MAX_PROJECTION_BYTES) {
      this.forget(this.projections.keys().next().value!);
    }
  }

  stateRoot(id: string): string { return join(this.root, "provider-state", z.uuid().parse(id)); }
  bindingPath(id: string): string { return join(this.root, "native-bindings", `${z.uuid().parse(id)}.json`); }
  async resolve(session: SessionRecord): Promise<{ sourceRoot: string; path: string }> {
    const sourceRoot = this.stateRoot(session.id);
    if (session.provider === "claude") {
      let nativeSessionId = session.id;
      try {
        const file = await openContainedSource(sourceRoot, join(sourceRoot, "cyberdeck-native-binding.json"));
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 65536) throw new Error("NATIVE_BINDING_LIMIT");
          const hook = z.object({ nativeSessionId: z.uuid(), relativePath: z.string() }).strict().parse(JSON.parse(await file.readFile("utf8")));
          if (hook.relativePath !== `.claude/projects/-workspace/${hook.nativeSessionId}.jsonl`) throw new Error("NATIVE_BINDING_CONFLICT");
          nativeSessionId = hook.nativeSessionId;
        } finally { await file.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const relativePath = `.claude/projects/-workspace/${nativeSessionId}.jsonl`;
      const path = join(sourceRoot, relativePath);
      // Refuse incomplete signals until the exact native file exists within this worker root.
      const file = await openContainedSource(sourceRoot, path); await file.close();
      await writeAtomicPrivateFile(this.bindingPath(session.id), JSON.stringify({ sessionId: session.id, provider: "claude", nativeSessionId, relativePath }));
      return { sourceRoot, path };
    }
    if (session.provider !== "codex") throw new Error("CONTAINER_NATIVE_SOURCE_UNSUPPORTED");
    let bound: z.infer<typeof ContainerNativeBindingSchema> | undefined;
    try { bound = ContainerNativeBindingSchema.parse(JSON.parse(await readFile(this.bindingPath(session.id), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (bound) {
      if (bound.sessionId !== session.id || bound.provider !== session.provider) throw new Error("NATIVE_BINDING_CONFLICT");
      const path = join(sourceRoot, bound.relativePath);
      if (await this.codexId(sourceRoot, path) !== bound.nativeSessionId) throw new Error("NATIVE_BINDING_CONFLICT");
      return { sourceRoot, path };
    }
    // This is one worker's private provider root, never a shared cwd/time-window match.
    // Multiple native conversations are ambiguous; explicit resume cannot guess one.
    const candidates: Array<{ path: string; id: string }> = [];
    let visited = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++visited > 10000) throw new Error("NATIVE_DISCOVERY_LIMIT");
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const id = await this.codexId(sourceRoot, path);
          if (id) candidates.push({ path, id });
        }
      }
    };
    await visit(join(sourceRoot, ".codex", "sessions"), 0);
    if (candidates.length !== 1) throw new Error("NATIVE_CONVERSATION_UNBOUND");
    const candidate = candidates[0]!;
    await writeAtomicPrivateFile(this.bindingPath(session.id), JSON.stringify({ sessionId: session.id, provider: "codex",
      nativeSessionId: candidate.id, relativePath: relative(sourceRoot, candidate.path) }));
    return { sourceRoot, path: candidate.path };
  }
  private async codexId(root: string, path: string): Promise<string | undefined> {
    for await (const line of nativeSourceLines(root, path)) {
      const frame = object(JSON.parse(line.text)), payload = object(frame?.payload);
      if (frame?.type !== "session_meta" || payload?.cwd !== "/workspace" || payload.originator !== "codex-tui") return undefined;
      const id = z.uuid().safeParse(payload.id); return id.success ? id.data : undefined;
    }
    return undefined;
  }
  async read(session: SessionRecord, window: ProviderBudgetWindow = "session", includeTurns = true): Promise<{
    turns: ObservedWorkerTurn[]; messages: TranscriptMessage[]; model?: ObservedModel; budget: ParsedProviderBudgetTelemetry;
    pending?: PendingNativeInterval;
  }> {
    // Readers share one projection, including both budget windows. Serialize only this session.
    const previous = this.reads.get(session.id) ?? Promise.resolve();
    const read = previous.catch(() => undefined).then(() => this.readProjection(session, window, includeTurns));
    this.reads.set(session.id, read);
    try { return await read; }
    finally { if (this.reads.get(session.id) === read) this.reads.delete(session.id); }
  }
  private async readProjection(session: SessionRecord, window: ProviderBudgetWindow, includeTurns: boolean) {
    const source = await this.resolve(session);
    // Never use a cached path/stat to bypass containment or native binding validation.
    const file = await openContainedSource(source.sourceRoot, source.path);
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.size > BigInt(512 * 1024 * 1024)) throw new Error("ACTIVITY_SOURCE_LIMIT");
      const size = Number(stat.size);
      const identity = JSON.stringify([source.path, session.provider, session.generation ?? 1,
        session.execution?.executionId, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
      const stamp = `${stat.mtimeNs}:${stat.ctimeNs}`;
      const cached = this.projections.get(session.id);
      // The worker can rewrite old frames while growing the file. Validate the entire previously
      // parsed prefix, not just its boundary, before reusing semantic/model/preview observations.
      // Parsing scales with appended frames; integrity verification still reads the old bytes.
      let prefix: Hash | undefined;
      let reusable = cached?.identity === identity && cached.size === size && cached.stamp === stamp;
      if (cached?.identity === identity && cached.size < size) {
        prefix = await hashPrefix(file, cached.projection.end);
        reusable = prefix.copy().digest("hex") === cached.prefixHash;
      }
      const projection: NativeProjection = reusable && cached ? cached.projection : {
        turns: [], messages: [], budgets: { session: {}, weekly: {} }, start: 0, end: 0,
        startedAt: undefined, pendingTurnId: undefined, retainedBytes: 0, previewBytes: 0,
      };
      // Drop ownership while updating: a failed parse cannot leave a partially advanced cache.
      this.forget(session.id);
      const { turns, messages } = projection;
      let { start, end, model, startedAt, pendingTurnId } = projection;
      const budgets = projection.budgets;
      const readFrom = end;
      const parseMessage = session.provider === "claude" ? parseClaudeTranscriptLine : parseCodexRolloutLine;
      for await (const line of nativeSourceLinesFromFile(file, end)) {
        end = line.end;
        const frame = object(JSON.parse(line.text)), payload = object(frame?.payload), message = object(frame?.message);
        if (frame?.isSidechain === true || frame?.isMeta === true) continue;
        if (frame?.type === (session.provider === "claude" ? "assistant" : "turn_context")) {
          model = observedModelParser(session.provider)?.(line.text) ?? model;
        }
        if (session.provider === "codex" && frame?.type === "event_msg" && payload?.type === "token_count") for (const budgetWindow of ["session", "weekly"] as const) {
          budgets[budgetWindow] = { ...budgets[budgetWindow], ...parseCodexBudgetTelemetryLine(line.text, budgetWindow) };
        }
        const preview = parseMessage(line.text);
        if (preview) { messages.push(preview); if (messages.length > 20) messages.shift(); }
        // Only Claude's own record of the command, never a tool result that quotes the literal.
        if (session.provider === "claude" && isClaudeClearFrame(frame)) throw new Error("NATIVE_CONVERSATION_CLEARED");
        if (frame?.type === "turn_context" && startedAt === undefined) {
          startedAt = nativeTimestamp(frame?.timestamp);
          pendingTurnId = typeof payload?.turn_id === "string" ? payload.turn_id : undefined;
        }
        if (session.provider === "claude" && frame?.type === "user" && frame.toolUseResult === undefined && startedAt === undefined) {
          startedAt = nativeTimestamp(frame?.timestamp);
        }
        const final = session.provider === "codex" ? frame?.type === "event_msg" && payload?.type === "task_complete"
          : frame?.type === "assistant" && message?.stop_reason === "end_turn";
        if (!final) continue;
        // Claude 2.1.261 emits separate thinking/text blocks with the same message id
        // and end_turn on both. Only the text block is the semantic completion.
        if (session.provider === "claude" && Array.isArray(message?.content) && message.content.length > 0
          && message.content.every((block: unknown) => ["thinking", "redacted_thinking"].includes(String(object(block)?.type)))) continue;
        const id = session.provider === "codex" ? payload?.turn_id : message?.id;
        const text = session.provider === "codex" ? payload?.last_agent_message : preview?.text;
        const timestamp = nativeTimestamp(frame?.timestamp);
        if (typeof id !== "string" || typeof text !== "string" || !text.trim() || !timestamp) throw new Error("NATIVE_FINAL_INVALID");
        turns.push({ providerTurnId: id, providerOccurredAt: timestamp, text, transport: "provider-native",
          data: { nativeActivity: { ...source, fromOffset: start, throughOffset: line.end, generation: session.generation ?? 1, executionId: session.execution?.executionId, ...(startedAt ? { startedAt } : {}) } } });
        projection.retainedBytes += Buffer.byteLength(JSON.stringify(turns.at(-1))) * 2;
        start = line.end; startedAt = undefined; pendingTurnId = undefined;
        if (turns.length > 10000) throw new Error("NATIVE_TURN_LIMIT");
      }
      const executionId = session.execution?.executionId;
      const pending: PendingNativeInterval | undefined = end > start ? { ...source, fromOffset: start, throughOffset: end,
        generation: session.generation ?? 1, ...(executionId ? { executionId } : {}),
        ...(startedAt ? { startedAt } : {}), ...(pendingTurnId ? { providerTurnId: pendingTurnId } : {}) } : undefined;
      Object.assign(projection, { start, end, model, startedAt, pendingTurnId });
      // Preview strings are bounded by twenty 1 MiB frames; charge their actual retained size.
      projection.retainedBytes -= projection.previewBytes;
      projection.previewBytes = Buffer.byteLength(JSON.stringify(messages)) * 2;
      projection.retainedBytes += projection.previewBytes;
      const verifiedPrefix = reusable && prefix
        ? await hashPrefix(file, end, readFrom, prefix)
        : reusable && readFrom === end ? undefined : await hashPrefix(file, end);
      const prefixHash = verifiedPrefix?.digest("hex") ?? cached!.prefixHash;
      const after = await file.stat({ bigint: true });
      if (after.size === stat.size && after.mtimeNs === stat.mtimeNs && after.ctimeNs === stat.ctimeNs) {
        this.retain(session.id, { identity, stamp, size, prefixHash, projection });
      }
      // Callers own their returned data; mutation cannot poison later model/turn/preview readers.
      return structuredClone({ turns: includeTurns ? turns : [], messages, budget: budgets[window], ...(model ? { model } : {}), ...(pending ? { pending } : {}) });
    } finally { await file.close(); }
  }
}

async function hashPrefix(file: FileHandle, end: number, start = 0, hash = createHash("sha256")): Promise<Hash> {
  const buffer = Buffer.alloc(64 * 1024);
  let position = start;
  while (position < end) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position);
    if (!bytesRead) throw new Error("ACTIVITY_SOURCE_TRUNCATED");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash;
}
