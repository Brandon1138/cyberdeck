import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { SessionRecord } from "../../domain/session.js";
import type { ObservedWorkerTurn } from "../../orchestration/session/worker-turn-ports.js";
import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";
import { openContainedSource } from "./contained-source.js";
import { nativeSourceLines } from "./native-source-lines.js";
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
export class ContainerNativeSource {
  constructor(private readonly root: string) {}
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
  async read(session: SessionRecord, window: ProviderBudgetWindow = "session"): Promise<{
    turns: ObservedWorkerTurn[]; messages: TranscriptMessage[]; model?: ObservedModel; budget: ParsedProviderBudgetTelemetry;
    /** Complete frames after the last final frame: the turn still running, if any. */
    pending?: PendingNativeInterval;
  }> {
    const source = await this.resolve(session), turns: ObservedWorkerTurn[] = [], messages: TranscriptMessage[] = [];
    let startedAt: string | undefined, pendingTurnId: string | undefined;
    let start = 0, end = 0, model: ObservedModel | undefined, budget: ParsedProviderBudgetTelemetry = {};
    const parseMessage = session.provider === "claude" ? parseClaudeTranscriptLine : parseCodexRolloutLine;
    for await (const line of nativeSourceLines(source.sourceRoot, source.path)) {
      end = line.end;
      const frame = object(JSON.parse(line.text)), payload = object(frame?.payload), message = object(frame?.message);
      if (frame?.isSidechain === true || frame?.isMeta === true) continue;
      model = observedModelParser(session.provider)?.(line.text) ?? model;
      if (session.provider === "codex") budget = { ...budget, ...parseCodexBudgetTelemetryLine(line.text, window) };
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
      const id = session.provider === "codex" ? payload?.turn_id : message?.id;
      const text = session.provider === "codex" ? payload?.last_agent_message : preview?.text;
      const timestamp = nativeTimestamp(frame?.timestamp);
      if (typeof id !== "string" || typeof text !== "string" || !text.trim() || !timestamp) throw new Error("NATIVE_FINAL_INVALID");
      turns.push({ providerTurnId: id, providerOccurredAt: timestamp, text, transport: "provider-native",
        data: { nativeActivity: { ...source, fromOffset: start, throughOffset: line.end, generation: session.generation ?? 1, executionId: session.execution?.executionId, ...(startedAt ? { startedAt } : {}) } } });
      start = line.end; startedAt = undefined; pendingTurnId = undefined;
      if (turns.length > 10000) throw new Error("NATIVE_TURN_LIMIT");
    }
    const executionId = session.execution?.executionId;
    const pending: PendingNativeInterval | undefined = end > start ? { ...source, fromOffset: start, throughOffset: end,
      generation: session.generation ?? 1, ...(executionId ? { executionId } : {}),
      ...(startedAt ? { startedAt } : {}), ...(pendingTurnId ? { providerTurnId: pendingTurnId } : {}) } : undefined;
    return { turns, messages, budget, ...(model ? { model } : {}), ...(pending ? { pending } : {}) };
  }
}
