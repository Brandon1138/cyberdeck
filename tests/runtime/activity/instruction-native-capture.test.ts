import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ContainerNativeSource } from "../../../src/runtime/activity/container-native-source.js";
import { InstructionNativeCapture } from "../../../src/runtime/activity/instruction-native-capture.js";
import { ExecutionTranscriptStore } from "../../../src/persistence/execution-transcript-store.js";
import { AgentActivityStore } from "../../../src/persistence/agent-activity-store.js";
import { ContainerProviderAdapter } from "../../../src/runtime/execution/container-provider-adapter.js";
import { ClaudeProviderAdapter } from "../../../src/providers/claude.js";
import { CodexProviderAdapter } from "../../../src/providers/codex.js";
import { InstructionRecordSchema } from "../../../src/domain/instruction.js";
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
  const capture = new InstructionNativeCapture(join(root, "cursors"), recorder, transcripts);
  const nativeId = randomUUID();
  const directory = provider === "codex" ? join(source.stateRoot(id), ".codex", "sessions", "2026", "09", "05")
    : join(source.stateRoot(id), ".claude", "projects", "-workspace");
  await mkdir(directory, { recursive: true });
  const path = join(directory, provider === "codex" ? "rollout.jsonl" : `${id}.jsonl`);
  const instruction = (expectedTurn: number) => InstructionRecordSchema.parse({ id: randomUUID(), actorSessionId: randomUUID(), targetSessionId: id,
    messageId: randomUUID(), message: "fixture", createdAt, updatedAt: createdAt, status: "completed", expectedTurn });
  return { root, session, source, transcripts, recorder, capture, path, nativeId, instruction };
}
const codex = (type: string, payload: unknown) => ({ timestamp: "2026-09-05T10:00:01.000Z", type, payload });
it("binds delayed instruction completion to exact native intervals through restart and generation change", async () => {
  const f = await fixture(), first = f.instruction(1), second = f.instruction(2);
  const frames = [codex("session_meta", { id: f.nativeId, originator: "codex-tui", cwd: "/workspace" }),
    ...[1, 2].flatMap((turn) => [codex("turn_context", { turn_id: `turn-${turn}`, model: "observed-model" }),
      codex("response_item", { type: "function_call", call_id: `call-${turn}`, arguments: "PRIVATE_ARGUMENTS" }),
      codex("response_item", { type: "function_call_output", call_id: `call-${turn}`, output: "PRIVATE_OUTPUT" }),
      codex("event_msg", { type: "task_complete", turn_id: `turn-${turn}`, last_agent_message: `answer-${turn}` })])];
  await writeFile(f.path, frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  const observed = await f.transcripts.observeProviderTurns({ sessionId: f.session.id, provider: "codex", cwd: f.session.cwd, createdAt: f.session.createdAt, turnNumber: 1 });
  expect(observed.turns).toHaveLength(2);
  await f.transcripts.commitProviderTurns(observed);
  f.session.generation = 3; // A delayed callback must retain the generation observed in its receipt.
  await f.capture.capture(second, f.session);
  await f.capture.capture(first, f.session);
  const restarted = new InstructionNativeCapture(join(f.root, "cursors"), await AgentActivityStore.open(join(f.root, "activity")), f.transcripts);
  await restarted.capture(first, f.session);
  const durable = await AgentActivityStore.open(join(f.root, "activity"));
  for (const [instruction, turn] of [[first, 1], [second, 2]] as const) {
    const events = await durable.read(instruction.id, 0, 100);
    expect(events.map((event) => event.kind)).toEqual(["tool.invocation", "tool.result"]);
    expect(events.every((event) => event.instructionId === instruction.id && event.generation === 2 && event.toolCallId === `call-${turn}`)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
  }
  expect((await f.source.read(f.session)).model?.model).toBe("observed-model");
  const resume = new ContainerProviderAdapter(new CodexProviderAdapter(), join(f.root, "containers")).buildResumeSpec(f.session);
  expect(resume.args).toContain(f.nativeId);
  await restarted.capture({ ...first, id: randomUUID() }, f.session);
  expect((await durable.read(first.id, 0, 100)).filter((event) => event.kind === "tool.invocation")).toHaveLength(1);
});
it("refuses a competing instruction attribution and marks missing semantic receipts unavailable", async () => {
  const f = await fixture();
  await f.capture.capture(f.instruction(1), f.session);
  expect(f.recorder.health().retained).toBe(1);
  const instruction = f.instruction(2);
  await f.capture.capture(instruction, f.session);
  expect((await f.recorder.read(instruction.id, 0, 100))[0]).toMatchObject({ kind: "capture.gap", coverage: "unavailable" });
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
