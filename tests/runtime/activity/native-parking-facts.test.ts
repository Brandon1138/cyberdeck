import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../../src/domain/session.js";
import type { ThreadEvent } from "../../../src/domain/thread.js";
import { AgentActivityStore } from "../../../src/persistence/agent-activity-store.js";
import { ExecutionTranscriptStore } from "../../../src/persistence/execution-transcript-store.js";
import { ContainerNativeSource } from "../../../src/runtime/activity/container-native-source.js";
import { TurnNativeCapture } from "../../../src/runtime/activity/turn-native-capture.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const timestamp = "2026-09-16T10:00:00.000Z";
const frame = (type: string, payload: unknown) => ({ timestamp, type, payload });
const invocation = frame("response_item", { type: "function_call", call_id: "call-1", name: "exec" });
const result = frame("response_item", { type: "function_call_output", call_id: "call-1", output: "ok" });
const final = frame("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: "done" });
const lines = (frames: unknown[]) => frames.map(value => JSON.stringify(value)).join("\n") + "\n";
async function fixture(extra: unknown[] = [invocation, result]) {
  const root = await mkdtemp(join(tmpdir(), "native-parking-facts-")); roots.push(root);
  const id = randomUUID(), nativeId = randomUUID();
  const session: SessionRecord = { id, provider: "codex", executor: "orbstack-container", cwd: "/workspace", sandbox: "workspace-write", detached: true,
    generation: 2, createdAt: timestamp, updatedAt: timestamp, executionState: "active", attachmentState: "detached", pid: 0, exitCode: null, childIds: [],
    execution: { brokerId: randomUUID(), executionId: randomUUID(), workerId: id, sessionId: id, generation: 2, executor: "orbstack-container", workspaceId: "/workspace" } };
  const source = new ContainerNativeSource(join(root, "containers"));
  const path = join(source.stateRoot(id), ".codex", "sessions", "rollout.jsonl");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, lines([frame("session_meta", { id: nativeId, originator: "codex-tui", cwd: "/workspace" }), ...extra, final]));
  const transcripts = new ExecutionTranscriptStore(join(root, "threads"), {}, source, () => session);
  const observed = await transcripts.observeProviderTurns({ sessionId: id, provider: session.provider, cwd: session.cwd, createdAt: timestamp, turnNumber: 1 });
  const [receipt] = await transcripts.commitProviderTurns(observed);
  const recorder = await AgentActivityStore.open(join(root, "activity"));
  const instructions = { list: async () => [] };
  const capture = new TurnNativeCapture(join(root, "cursors"), recorder, transcripts, instructions);
  transcripts.attachNativeCapture(capture);
  return { root, session, source, path, transcripts, recorder, instructions, capture, nativeId, receipt: receipt as ThreadEvent };
}
it("requires complete pairing for exact generation/execution/turn and a verified real resume binding", async () => {
  const f = await fixture();
  expect(f.transcripts.parkingFacts(f.session.id, 1)).toEqual({ conversationId: f.nativeId, resumeSupported: true, outstandingTools: null });
  await f.capture.captureCompleted(f.session, f.receipt);
  expect(f.transcripts.parkingFacts(f.session.id, 1)).toEqual({ conversationId: f.nativeId, resumeSupported: true, outstandingTools: 0 });
  expect(f.capture.outstandingTools(f.session, 2)).toBeNull();
  expect(f.capture.outstandingTools({ ...f.session, generation: 3 }, 1)).toBeNull();
  expect(f.capture.outstandingTools({ ...f.session, execution: { ...f.session.execution!, executionId: randomUUID() } }, 1)).toBeNull();
  f.session.generation = 3; f.session.execution!.generation = 3;
  expect(f.transcripts.parkingFacts(f.session.id, 1).resumeSupported).toBe(false);
  await f.transcripts.refreshParkingFacts(f.session.id);
  expect(f.transcripts.parkingFacts(f.session.id, 1)).toEqual({ conversationId: f.nativeId, resumeSupported: true, outstandingTools: null });
});
it.each([ [invocation], [result], [invocation, result, result], [frame("response_item", { type: "new_tool" })], [frame("unknown", {})] ])("never grants zero for missing pairs or unknown native coverage: %j", async (...extra) => {
  const f = await fixture(extra);
  await f.capture.captureCompleted(f.session, f.receipt);
  expect(f.capture.outstandingTools(f.session, 1)).toBeNull();
});
it.each(["append", "replace", "partial"])("invalidates verified facts on source %s", async mode => {
  const f = await fixture(); await f.capture.captureCompleted(f.session, f.receipt);
  expect(f.capture.outstandingTools(f.session, 1)).toBe(0);
  if (mode === "replace") { await rename(f.path, f.path + ".old"); await writeFile(f.path, ""); }
  else await appendFile(f.path, mode === "partial" ? "{\"type\":" : lines([frame("turn_context", { turn_id: "next" })]));
  expect(f.capture.outstandingTools(f.session, 1)).toBeNull();
  expect(f.transcripts.parkingFacts(f.session.id, 1).resumeSupported).toBe(false);
});
it("rejects binding replacement and never restores cached zero after restart", async () => {
  const f = await fixture(); await f.capture.captureCompleted(f.session, f.receipt);
  const restart = new TurnNativeCapture(join(f.root, "cursors"), f.recorder, f.transcripts, f.instructions);
  expect(restart.outstandingTools(f.session, 1)).toBeNull();
  await writeFile(f.source.bindingPath(f.session.id), JSON.stringify({ sessionId: f.session.id, provider: "codex", nativeSessionId: randomUUID(), relativePath: ".codex/sessions/rollout.jsonl" }));
  expect(f.transcripts.parkingFacts(f.session.id, 1).resumeSupported).toBe(false);
  await f.transcripts.refreshParkingFacts(f.session.id);
  expect(f.transcripts.parkingFacts(f.session.id, 1).resumeSupported).toBe(false);
});
it("does not infer zero when retained activity omitted an unpaired native call", async () => {
  const f = await fixture([invocation]);
  await f.capture.captureCompleted(f.session, f.receipt);
  vi.spyOn(f.recorder, "read").mockResolvedValue([]);
  const restart = new TurnNativeCapture(join(f.root, "cursors"), f.recorder, f.transcripts, f.instructions);
  await restart.captureCompleted(f.session, f.receipt);
  expect(restart.outstandingTools(f.session, 1)).toBeNull();
});
it("fences overlapping running capture and retirement against late completed callbacks", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.instructions, "list").mockImplementation(async () => { await gate; return []; });
  const completion = f.capture.captureCompleted(f.session, f.receipt);
  expect(f.capture.outstandingTools(f.session, 1)).toBeNull();
  const running = f.capture.captureRunning(f.session, f.receipt.data.nativeActivity as never, 1);
  f.capture.forget(f.session.id); release();
  await Promise.all([completion, running]);
  expect(f.capture.outstandingTools(f.session, 1)).toBeNull();
});
it("keeps pending native refresh unknown and retirement prevents a late refresh publishing", async () => {
  const f = await fixture(); await f.capture.captureCompleted(f.session, f.receipt);
  const original = f.source.read.bind(f.source);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.source, "read").mockImplementation(async (...args) => { await gate; return original(...args); });
  const refreshing = f.transcripts.refreshParkingFacts(f.session.id);
  expect(f.transcripts.parkingFacts(f.session.id, 1).resumeSupported).toBe(false);
  await f.transcripts.dropClaudeBinding(f.session.id); release(); await refreshing;
  expect(f.transcripts.parkingFacts(f.session.id, 1).resumeSupported).toBe(false);
});

it("validates Claude resume from its real native source and invalidates changed hooks and clear frames", async () => {
  const f = await fixture(); f.session.provider = "claude";
  const directory = join(f.source.stateRoot(f.session.id), ".claude", "projects", "-workspace");
  await mkdir(directory, { recursive: true });
  const nativePath = join(directory, f.session.id + ".jsonl");
  await writeFile(nativePath, lines([{ type: "assistant", timestamp, message: { id: "m1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }]));
  await f.transcripts.refreshParkingFacts(f.session.id);
  expect(f.transcripts.parkingFacts(f.session.id, 1)).toEqual({ conversationId: f.session.id, resumeSupported: true, outstandingTools: null });
  const hookPath = join(f.source.stateRoot(f.session.id), "cyberdeck-native-binding.json");
  await writeFile(hookPath, JSON.stringify({ nativeSessionId: randomUUID(), relativePath: "invalid" }));
  expect(f.transcripts.parkingFacts(f.session.id, 1).resumeSupported).toBe(false);
  await rm(hookPath);
  await appendFile(nativePath, lines([{ type: "user", timestamp, message: { role: "user", content: "<command-name>/clear</command-name>" } }]));
  await f.transcripts.refreshParkingFacts(f.session.id);
  expect(f.transcripts.parkingFacts(f.session.id, 1).resumeSupported).toBe(false);
});
it("running capture invalidates zero immediately and overlapping completion cannot restore it", async () => {
  const f = await fixture(); await f.capture.captureCompleted(f.session, f.receipt);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.instructions, "list").mockImplementation(async () => { await gate; return []; });
  const completion = f.capture.captureCompleted(f.session, f.receipt);
  const running = f.capture.captureRunning(f.session, f.receipt.data.nativeActivity as never, 1);
  expect(f.capture.outstandingTools(f.session, 1)).toBeNull();
  release(); await Promise.all([completion, running]);
  expect(f.capture.outstandingTools(f.session, 1)).toBeNull();
});
it("degraded or dropped recording cannot grant zero", async () => {
  const f = await fixture(); await f.capture.captureCompleted(f.session, f.receipt);
  const health = f.recorder.health();
  vi.spyOn(f.recorder, "health").mockReturnValue({ ...health, dropped: 1 });
  expect(f.capture.outstandingTools(f.session, 1)).toBeNull();
});
