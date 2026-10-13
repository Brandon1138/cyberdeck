import { readFile, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { SessionRecord } from "../../domain/session.js";
import type { ObservedWorkerTurn, WorkerTurnObservation } from "../../orchestration/session/worker-turn-ports.js";
import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";
import { openContainedSource } from "./contained-source.js";
import { nativeSourceLines } from "./native-source-lines.js";
import { nativeTimestamp, object } from "./provider-activity-collector.js";
import { observedModelParser, type ObservedModel } from "../observed-model.js";
import { parseClaudeTranscriptLine, parseCodexRolloutLine, type TranscriptMessage } from "../conversation-preview.js";
import { isClaudeClearFrame } from "../claude-clear-frame.js";
import { parseCodexBudgetTelemetryLine, type ParsedProviderBudgetTelemetry, type ProviderBudgetWindow } from "../provider-budget-telemetry.js";
import { ClaudeTurnStops, parseCodexTurn, parseCodexAbort, parseNativeActivity } from "../../persistence/thread-transcript-lines.js";
import { NativeSourceError } from "../../persistence/native-source-observation.js";

export const ContainerNativeBindingSchema = z.object({ sessionId: z.uuid(), nativeSessionId: z.uuid(),
  provider: z.enum(["claude", "codex"]), relativePath: z.string().min(1), executionId: z.uuid().optional() }).strict();
export interface PendingNativeInterval {
  sourceRoot: string; path: string; fromOffset: number; throughOffset: number; generation: number;
  executionId?: string; startedAt?: string; providerTurnId?: string;
}
export class ContainerNativeSource {
  constructor(private readonly root: string) {}
  stateRoot(id: string): string { return join(this.root, "provider-state", z.uuid().parse(id)); }
  bindingPath(id: string): string { return join(this.root, "native-bindings", `${z.uuid().parse(id)}.json`); }
  async dropBinding(id: string): Promise<void> { await rm(this.bindingPath(id), { force: true }); }
  async resolve(session: SessionRecord): Promise<{ sourceRoot: string; path: string; nativeSessionId: string }> {
    const execution = session.execution;
    if (execution?.executor !== "orbstack-container" || execution.sessionId !== session.id
      || execution.workerId !== session.id) throw new NativeSourceError("unbound", "NATIVE_EXECUTION_UNBOUND");
    const sourceRoot = this.stateRoot(session.id);
    let bound: z.infer<typeof ContainerNativeBindingSchema> | undefined;
    try { bound = ContainerNativeBindingSchema.parse(JSON.parse(await readFile(this.bindingPath(session.id), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (bound && (bound.sessionId !== session.id || bound.provider !== session.provider
      || (bound.executionId !== undefined && bound.executionId !== execution.executionId))) {
      throw new NativeSourceError("conflict", "NATIVE_BINDING_CONFLICT");
    }
    if (session.provider === "claude") {
      let nativeSessionId = bound?.nativeSessionId ?? session.id;
      if (bound && bound.relativePath !== `.claude/projects/-workspace/${nativeSessionId}.jsonl`) throw new Error("NATIVE_BINDING_CONFLICT");
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
      const file = await openContainedSource(sourceRoot, path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new NativeSourceError("missing", "NATIVE_SOURCE_MISSING");
        throw error;
      }); await file.close();
      await writeAtomicPrivateFile(this.bindingPath(session.id), JSON.stringify({ sessionId: session.id, provider: "claude", nativeSessionId, relativePath,
        executionId: execution.executionId }));
      return { sourceRoot, path, nativeSessionId };
    }
    if (session.provider !== "codex") throw new Error("CONTAINER_NATIVE_SOURCE_UNSUPPORTED");
    if (bound) {
      const path = join(sourceRoot, bound.relativePath);
      if (await this.codexId(sourceRoot, path, true) !== bound.nativeSessionId) throw new Error("NATIVE_BINDING_CONFLICT");
      return { sourceRoot, path, nativeSessionId: bound.nativeSessionId };
    }
    // This is one worker's private provider root, never a shared cwd/time-window match.
    // Multiple native conversations are ambiguous; explicit resume cannot guess one.
    const candidates: Array<{ path: string; id: string }> = [];
    let visited = 0, files = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 4) throw new NativeSourceError("source-error", "NATIVE_DISCOVERY_LIMIT");
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && depth === 0) throw new NativeSourceError("missing", "NATIVE_SOURCE_MISSING");
        throw error;
      });
      for (const entry of entries) {
        if (++visited > 10000) throw new Error("NATIVE_DISCOVERY_LIMIT");
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new NativeSourceError("conflict", "ACTIVITY_SOURCE_ESCAPE");
        if (entry.isDirectory()) await visit(path, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files++;
          const id = await this.codexId(sourceRoot, path);
          if (id) candidates.push({ path, id });
        }
      }
    };
    await visit(join(sourceRoot, ".codex", "sessions"), 0);
    if (candidates.length !== 1) throw new NativeSourceError(candidates.length > 1 ? "conflict" : files > 0 ? "unbound" : "missing",
      candidates.length === 0 && files === 0 ? "NATIVE_SOURCE_MISSING" : "NATIVE_CONVERSATION_UNBOUND");
    const candidate = candidates[0]!;
    await writeAtomicPrivateFile(this.bindingPath(session.id), JSON.stringify({ sessionId: session.id, provider: "codex",
      nativeSessionId: candidate.id, relativePath: relative(sourceRoot, candidate.path), executionId: execution.executionId }));
    return { sourceRoot, path: candidate.path, nativeSessionId: candidate.id };
  }
  private async codexId(root: string, path: string, required = false): Promise<string | undefined> {
    try {
      for await (const line of nativeSourceLines(root, path)) {
        const frame = object(JSON.parse(line.text)), payload = object(frame?.payload);
        if (frame?.type !== "session_meta" || payload?.cwd !== "/workspace" || payload.originator !== "codex-tui"
          || object(payload.source)?.subagent !== undefined) return undefined;
        const id = z.uuid().safeParse(payload.id); return id.success ? id.data : undefined;
      }
    } catch (error) {
      if (required && (error as NodeJS.ErrnoException).code === "ENOENT") throw new NativeSourceError("missing", "NATIVE_SOURCE_MISSING");
      throw error;
    }
    return undefined;
  }
  async read(session: SessionRecord, window: ProviderBudgetWindow = "session"): Promise<{
    turns: ObservedWorkerTurn[]; messages: TranscriptMessage[]; model?: ObservedModel; budget: ParsedProviderBudgetTelemetry;
    /** Complete frames after the last final frame: the turn still running, if any. */
    pending?: PendingNativeInterval;
    nativeSourceAvailable: true; nativeSessionId: string; activityVersion: string; path: string;
    nativeActivity: "working" | "idle" | "unknown";
    nativeActivityEvidence?: WorkerTurnObservation["nativeActivityEvidence"];
    boundaries: Array<{ providerTurnId: string; throughOffset: number; nativeActivityId?: string }>;
  }> {
    // A record may be mutated by resume while a safe file read awaits I/O. These observations own
    // the execution/generation they started with, never the replacement process's identity.
    const snapshot = { ...session, execution: session.execution === undefined ? undefined : { ...session.execution } } as SessionRecord;
    const source = await this.resolve(snapshot), turns: ObservedWorkerTurn[] = [], messages: TranscriptMessage[] = [];
    const intervalSource = { sourceRoot: source.sourceRoot, path: source.path };
    const generation = snapshot.generation ?? snapshot.execution!.generation, executionId = snapshot.execution!.executionId;
    const claudeStops = new ClaudeTurnStops();
    let nativeActivity: "working" | "idle" | "unknown" = "unknown";
    let nativeActivityEvidence: WorkerTurnObservation["nativeActivityEvidence"];
    const boundaries: Array<{ providerTurnId: string; throughOffset: number; nativeActivityId?: string }> = [];
    const ended = new Set<string>();
    let startedAt: string | undefined, pendingTurnId: string | undefined;
    let start = 0, end = 0, model: ObservedModel | undefined, budget: ParsedProviderBudgetTelemetry = {};
    const parseMessage = snapshot.provider === "claude" ? parseClaudeTranscriptLine : parseCodexRolloutLine;
    for await (const line of nativeSourceLines(source.sourceRoot, source.path)) {
      end = line.end;
      if (line.text.trim() === "") continue;
      const frame = object(JSON.parse(line.text)), payload = object(frame?.payload);
      if (frame?.isSidechain === true || frame?.isMeta === true) continue;
      if (snapshot.provider === "codex" && frame?.type === "session_meta"
        && (payload?.id !== source.nativeSessionId || payload.cwd !== "/workspace" || payload.originator !== "codex-tui")) {
        throw new NativeSourceError("conflict", "NATIVE_BINDING_CONFLICT");
      }
      if (snapshot.provider === "claude" && typeof frame?.sessionId === "string" && frame.sessionId !== source.nativeSessionId) {
        throw new NativeSourceError("conflict", "NATIVE_BINDING_CONFLICT");
      }
      model = observedModelParser(snapshot.provider)?.(line.text) ?? model;
      if (snapshot.provider === "codex") budget = { ...budget, ...parseCodexBudgetTelemetryLine(line.text, window) };
      const preview = parseMessage(line.text);
      if (preview) { messages.push(preview); if (messages.length > 20) messages.shift(); }
      // Only Claude's own record of the command, never a tool result that quotes the literal.
      if (snapshot.provider === "claude" && isClaudeClearFrame(frame)) throw new Error("NATIVE_CONVERSATION_CLEARED");
      if (frame?.type === "turn_context" && startedAt === undefined) {
        startedAt = nativeTimestamp(frame?.timestamp);
        pendingTurnId = typeof payload?.turn_id === "string" ? payload.turn_id : undefined;
      }
      if (snapshot.provider === "codex" && frame?.type === "event_msg" && payload?.type === "task_started") {
        startedAt = nativeTimestamp(frame.timestamp);
        pendingTurnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
      }
      if (snapshot.provider === "claude" && frame?.type === "user" && frame.toolUseResult === undefined && startedAt === undefined) {
        startedAt = nativeTimestamp(frame?.timestamp);
      }
      const codexTurn = snapshot.provider === "codex" ? parseCodexTurn(line.text, undefined) ?? parseCodexAbort(line.text, line.offset) : undefined;
      if (snapshot.provider === "codex" && frame?.type === "event_msg" && payload?.type === "task_complete" && codexTurn === undefined) {
        throw new NativeSourceError("source-error", "NATIVE_FINAL_INVALID");
      }
      const completed = snapshot.provider === "claude" ? claudeStops.observe(line.text, undefined)
        : codexTurn === undefined ? [] : [codexTurn];
      const activity = parseNativeActivity(snapshot.provider, line.text, line.offset, completed);
      if (activity !== undefined
        && !(activity.evidence.occurredAt !== undefined && nativeActivityEvidence?.occurredAt !== undefined
          && activity.evidence.occurredAt < nativeActivityEvidence.occurredAt)
        && !(activity.state === "idle" && nativeActivity === "working"
          && nativeActivityEvidence?.providerTurnId !== undefined && activity.evidence.providerTurnId !== undefined
          && nativeActivityEvidence.providerTurnId !== activity.evidence.providerTurnId)) {
        nativeActivity = activity.state;
        nativeActivityEvidence = { ...activity.evidence, generation, executionId, nativeSessionId: source.nativeSessionId,
          receiptData: { nativeSessionId: source.nativeSessionId, nativeActivity: { ...intervalSource,
            fromOffset: start, throughOffset: line.end, generation, executionId, ...(startedAt ? { startedAt } : {}) } } };
      }
      if (activity?.evidence.kind === "turn_aborted" && activity.evidence.providerTurnId !== undefined) {
        boundaries.push({ providerTurnId: activity.evidence.providerTurnId, throughOffset: line.end, nativeActivityId: activity.evidence.id });
      }
      for (const turn of completed) {
        if (ended.has(turn.id)) continue;
        ended.add(turn.id);
        boundaries.push({ providerTurnId: turn.id, throughOffset: line.end });
        turns.push({ providerTurnId: turn.id, providerOccurredAt: turn.occurredAt, text: turn.text, transport: "provider-native",
          data: { ...turn.data, nativeSessionId: source.nativeSessionId, nativeActivity: { ...intervalSource, fromOffset: start,
            throughOffset: line.end, generation, executionId, ...(startedAt ? { startedAt } : {}) } } });
        start = line.end; startedAt = undefined; pendingTurnId = undefined;
      }
      if (boundaries.length > 10000) throw new Error("NATIVE_TURN_LIMIT");
    }
    const pending: PendingNativeInterval | undefined = end > start ? { ...intervalSource, fromOffset: start, throughOffset: end,
      generation, executionId,
      ...(startedAt ? { startedAt } : {}), ...(pendingTurnId ? { providerTurnId: pendingTurnId } : {}) } : undefined;
    return { turns, messages, budget, boundaries, ...(model ? { model } : {}), ...(pending ? { pending } : {}),
      nativeSourceAvailable: true, nativeSessionId: source.nativeSessionId, nativeActivity, path: source.path,
      activityVersion: `${executionId}:${generation}:${source.nativeSessionId}:${end}:${nativeActivityEvidence?.id ?? "unknown"}`,
      ...(nativeActivityEvidence === undefined ? {} : { nativeActivityEvidence }) };
  }
}
