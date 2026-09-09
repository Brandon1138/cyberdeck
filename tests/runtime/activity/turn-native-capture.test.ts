import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ContainerNativeSource } from "../../../src/runtime/activity/container-native-source.js";
import { TurnNativeCapture } from "../../../src/runtime/activity/turn-native-capture.js";
import { ExecutionTranscriptStore } from "../../../src/persistence/execution-transcript-store.js";
import { AgentActivityStore } from "../../../src/persistence/agent-activity-store.js";
import { ContainerProviderAdapter } from "../../../src/runtime/execution/container-provider-adapter.js";
import { ClaudeProviderAdapter } from "../../../src/providers/claude.js";
import { CodexProviderAdapter } from "../../../src/providers/codex.js";
import { InstructionRecordSchema, type InstructionRecord } from "../../../src/domain/instruction.js";
import type { SessionRecord } from "../../../src/domain/session.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(provider = "codex") {
  const root = await mkdtemp(join(tmpdir(), "native-binding-")); roots.push(root);
  const id = randomUUID(), executionId = randomUUID(), createdAt = "2026-09-05T10:00:00.000Z";
  const session: SessionRecord = { id, provider, executor: "orbstack-container", kind: "worker", cwd: "/host/private-clone", sandbox: "workspace-write", detached: true,
    generation: 2, createdAt, updatedAt: createdAt, executionState: "active", attachmentState: "detached", pid: 0, exitCode: null, childIds: [],
    execution: { brokerId: randomUUID(), executionId, workerId: id, sessionId: id, generation: 2, executor: "orbstack-container", workspaceId: "/host/private-clone" } };
  const source = new ContainerNativeSource(join(root, "containers"));
  const transcripts = new ExecutionTranscriptStore(root, {}, source, () => session);
  const recorder = await AgentActivityStore.open(join(root, "activity"));
  const instructions: InstructionRecord[] = [];
  const capture = new TurnNativeCapture(join(root, "cursors"), recorder, transcripts, { list: async () => instructions });
  transcripts.attachNativeCapture(capture);
  const nativeId = randomUUID();
  const directory = provider === "codex" ? join(source.stateRoot(id), ".codex", "sessions", "2026", "09", "05")
    : join(source.stateRoot(id), ".claude", "projects", "-workspace");
  await mkdir(directory, { recursive: true });
  const path = join(directory, provider === "codex" ? "rollout.jsonl" : `${id}.jsonl`);
  const instruction = (expectedTurn: number, status: InstructionRecord["status"] = "completed") => {
    const record = InstructionRecordSchema.parse({ id: randomUUID(), actorSessionId: randomUUID(), targetSessionId: id,
      messageId: randomUUID(), message: "fixture", createdAt, updatedAt: createdAt, status, expectedTurn });
    instructions.push(record); return record;
  };
  const observe = (turnNumber: number) => transcripts.observeProviderTurns({ sessionId: id, provider, cwd: session.cwd, createdAt, turnNumber });
  // Capture is fire-and-forget behind the receipt; wait for the recorder to hold what the test expects.
  const settle = async (expected = 0) => {
    for (let i = 0; i < 100; i++) {
      if (recorder.health().retained >= expected && i > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { root, session, source, transcripts, recorder, capture, path, nativeId, instruction, instructions, observe, settle };
}
const codex = (type: string, payload: unknown) => ({ timestamp: "2026-09-05T10:00:01.000Z", type, payload });
const codexTurn = (turn: number) => [codex("turn_context", { turn_id: `turn-${turn}`, model: "observed-model" }),
  codex("response_item", { type: "function_call", call_id: `call-${turn}`, arguments: "PRIVATE_ARGUMENTS" }),
  codex("response_item", { type: "function_call_output", call_id: `call-${turn}`, output: "PRIVATE_OUTPUT" }),
  codex("event_msg", { type: "task_complete", turn_id: `turn-${turn}`, last_agent_message: `answer-${turn}` })];
const lines = (frames: unknown[]) => frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";

it("binds delayed instruction completion to exact native intervals through restart and generation change", async () => {
  const f = await fixture(), first = f.instruction(1), second = f.instruction(2);
  await writeFile(f.path, lines([codex("session_meta", { id: f.nativeId, originator: "codex-tui", cwd: "/workspace" }), ...codexTurn(1), ...codexTurn(2)]));
  const observed = await f.observe(1);
  expect(observed.turns).toHaveLength(2);
  await f.transcripts.commitProviderTurns(observed);
  await f.settle(8);
  f.session.generation = 3; // A delayed callback must retain the generation observed in its receipt.
  await f.capture.captureInstruction(second, f.session);
  await f.capture.captureInstruction(first, f.session);
  const restarted = new TurnNativeCapture(join(f.root, "cursors"), await AgentActivityStore.open(join(f.root, "activity")), f.transcripts, { list: async () => f.instructions });
  await restarted.captureInstruction(first, f.session);
  const durable = await AgentActivityStore.open(join(f.root, "activity"));
  for (const [instruction, turn] of [[first, 1], [second, 2]] as const) {
    const events = await durable.read(instruction.id, 0, 100);
    expect(events.map((event) => event.kind)).toEqual(["provider.turn", "tool.invocation", "tool.result", "provider.turn"]);
    expect(events[0]).toMatchObject({ origin: "instruction", parentEventId: instruction.id, outcome: "observed", providerTurnId: `turn-${turn}` });
    expect(events[1]?.parentEventId).toBe(events[0]?.eventId);
    expect(events[2]?.parentEventId).toBe(events[1]?.eventId);
    expect(events[3]).toMatchObject({ outcome: "succeeded", parentEventId: events[0]?.eventId, coverage: "complete-for-source" });
    expect(events.every((event) => event.instructionId === instruction.id && event.generation === 2 && (event.kind === "provider.turn" || event.toolCallId === `call-${turn}`))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
  }
  expect((await f.source.read(f.session)).model?.model).toBe("observed-model");
  const resume = new ContainerProviderAdapter(new CodexProviderAdapter(), join(f.root, "containers")).buildResumeSpec(f.session);
  expect(resume.args).toContain(f.nativeId);
  await restarted.captureInstruction({ ...first, id: randomUUID() }, f.session);
  expect((await durable.read(first.id, 0, 100)).filter((event) => event.kind === "tool.invocation")).toHaveLength(1);
});
it("refuses a competing instruction attribution and marks missing semantic receipts unavailable", async () => {
  const f = await fixture();
  await f.capture.captureInstruction(f.instruction(1), f.session);
  expect(f.recorder.health().retained).toBe(1);
  const instruction = f.instruction(2);
  await f.capture.captureInstruction(instruction, f.session);
  expect((await f.recorder.read(instruction.id, 0, 100))[0]).toMatchObject({ kind: "capture.gap", coverage: "unavailable" });
});
it("captures a running turn incrementally under the identity its later receipt confirms", async () => {
  const f = await fixture(), instruction = f.instruction(1, "acknowledged");
  const [context, invocation, output, final] = codexTurn(1);
  await writeFile(f.path, lines([codex("session_meta", { id: f.nativeId, originator: "codex-tui", cwd: "/workspace" }), context, invocation]) + JSON.stringify(output).slice(0, 12));
  expect((await f.observe(1)).turns).toHaveLength(0);
  await f.settle(2);
  let events = await f.recorder.read(instruction.id, 0, 100);
  expect(events.map((event) => event.kind)).toEqual(["provider.turn", "tool.invocation"]);
  expect(events[0]).toMatchObject({ coverage: "partial", outcome: "observed", providerTurnId: "turn-1", origin: "instruction" });
  await appendFile(f.path, JSON.stringify(output).slice(12) + "\n" + JSON.stringify(final) + "\n");
  const observed = await f.observe(1);
  expect(observed.turns).toHaveLength(1);
  await f.transcripts.commitProviderTurns(observed);
  await f.settle(4);
  instruction.status = "completed";
  await f.capture.captureInstruction(instruction, f.session);
  events = await f.recorder.read(instruction.id, 0, 100);
  expect(events.map((event) => event.kind)).toEqual(["provider.turn", "tool.invocation", "tool.result", "provider.turn"]);
  expect(events[3]).toMatchObject({ outcome: "succeeded", startedAt: "2026-09-05T10:00:01.000Z" });
});
it("defers a rendered-only claim and records a visible conflict when two instructions claim one turn", async () => {
  const f = await fixture();
  await writeFile(f.path, lines([codex("session_meta", { id: f.nativeId, originator: "codex-tui", cwd: "/workspace" }), ...codexTurn(1), ...codexTurn(2)]));
  const rendered = f.instruction(1, "rendered");
  f.instruction(2, "acknowledged"); f.instruction(2, "submitted");
  await f.transcripts.commitProviderTurns(await f.observe(1));
  await f.settle(1);
  expect(await f.recorder.read(rendered.id, 0, 100)).toHaveLength(0);
  const session = await f.recorder.readSession(f.session.id, 0, 100);
  expect(session.map((event) => [event.kind, event.gap])).toEqual([["capture.gap", "attribution-conflict"]]);
});
it("attributes the launch prompt, a human composer prompt, and nothing at all as distinct origins", async () => {
  const f = await fixture();
  const launch = await f.transcripts.append({ sessionId: f.session.id, kind: "prompt", source: "human", text: "launch", data: { initial: true } });
  await writeFile(f.path, lines([codex("session_meta", { id: f.nativeId, originator: "codex-tui", cwd: "/workspace" }), ...codexTurn(1)]));
  await f.transcripts.commitProviderTurns(await f.observe(1));
  await f.settle(4);
  const composer = await f.transcripts.append({ sessionId: f.session.id, kind: "prompt", source: "human", text: "typed", data: {} });
  await appendFile(f.path, lines(codexTurn(2)));
  await f.transcripts.commitProviderTurns(await f.observe(2));
  await f.settle(8);
  await appendFile(f.path, lines(codexTurn(3)));
  await f.transcripts.commitProviderTurns(await f.observe(3));
  await f.settle(12);
  const turns = (await f.recorder.read(f.session.id, 0, 100)).filter((event) => event.kind === "provider.turn" && event.outcome === "succeeded");
  expect(turns.map((event) => [event.origin, event.causationId, event.providerTurnId])).toEqual([
    ["initial-prompt", launch.id, "turn-1"], ["direct-input", composer.id, "turn-2"], ["unattributed", undefined, "turn-3"]]);
  const tools = (await f.recorder.read(f.session.id, 0, 100)).filter((event) => event.kind === "tool.invocation");
  expect(tools.map((event) => event.origin)).toEqual(["initial-prompt", "direct-input", "unattributed"]);
  expect(tools.every((event) => event.instructionId === undefined)).toBe(true);
});
it("discovers Codex by the private execution root and refuses multiple conversations", async () => {
  const f = await fixture();
  const metadata = (id: string) => JSON.stringify(codex("session_meta", { id, originator: "codex-tui", cwd: "/workspace" })) + "\n";
  await writeFile(f.path, metadata(f.nativeId));
  await writeFile(join(f.path, "..", "other.jsonl"), metadata(randomUUID()));
  await expect(f.source.resolve(f.session)).rejects.toThrow("NATIVE_CONVERSATION_UNBOUND");
});
it("follows an exact Claude clear binding and resumes its native conversation", async () => {
  const f = await fixture("claude"), nativeId = randomUUID();
  f.session.model = "opus";
  const next = join(f.path, "..", `${nativeId}.jsonl`);
  await writeFile(next, JSON.stringify({ type: "assistant", timestamp: "2026-09-05T10:00:01.000Z", message: {
    id: "claude-message", role: "assistant", model: "claude-observed", stop_reason: "end_turn", content: [{ type: "text", text: "completed" }],
  } }) + "\n");
  await writeFile(join(f.source.stateRoot(f.session.id), "cyberdeck-native-binding.json"), JSON.stringify({ nativeSessionId: nativeId, relativePath: `.claude/projects/-workspace/${nativeId}.jsonl` }));
  expect((await f.source.read(f.session)).turns[0]?.providerTurnId).toBe("claude-message");
  const adapter = new ContainerProviderAdapter(new ClaudeProviderAdapter(), join(f.root, "containers"));
  const resume = adapter.buildResumeSpec(f.session);
  expect(resume.args[resume.args.indexOf("--resume") + 1]).toBe(nativeId);
  expect(JSON.stringify(resume.args)).toContain("/opt/cyberdeck/native-binding.mjs");
  await writeFile(join(f.source.stateRoot(f.session.id), "cyberdeck-native-binding.json"), JSON.stringify({ nativeSessionId: nativeId, relativePath: "../../foreign.jsonl" }));
  await expect(f.source.resolve(f.session)).rejects.toThrow("NATIVE_BINDING_CONFLICT");
});
it("detects Claude's own /clear in array content while ignoring a tool result that quotes it", async () => {
  const f = await fixture("claude");
  const clear = "<command-name>/clear</command-name>";
  const quoted = { type: "user", timestamp: "2026-09-05T10:00:01.000Z", toolUseResult: { stdout: clear },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: clear }] } };
  const final = { type: "assistant", timestamp: "2026-09-05T10:00:02.000Z", message: { id: "m1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } };
  await writeFile(f.path, lines([quoted, final]));
  expect((await f.source.read(f.session)).turns).toHaveLength(1);
  await appendFile(f.path, lines([{ type: "user", timestamp: "2026-09-05T10:00:03.000Z", message: { role: "user", content: [{ type: "text", text: `  ${clear}\n<command-message>clear</command-message>` }] } }]));
  await expect(f.source.read(f.session)).rejects.toThrow("NATIVE_CONVERSATION_CLEARED");
});
