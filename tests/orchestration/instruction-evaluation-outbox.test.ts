import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { InstructionRecordSchema } from "../../src/domain/instruction.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { JobStore } from "../../src/persistence/job-store.js";
import { AgentActivityStore } from "../../src/persistence/agent-activity-store.js";
import { TaskEvaluationStore } from "../../src/persistence/task-evaluation-store.js";
import { activityInstructionStore } from "../../src/orchestration/activity-instruction-store.js";
import { repairTerminalInstructionProjections } from "../../src/orchestration/task-evaluation-reconciliation.js";
import { brokerEvaluationRuntime } from "../../src/runtime/resources/broker-evaluation-runtime.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "instruction-outbox-")); directories.push(path);
  const store = new InstructionStore(path), activity = await AgentActivityStore.open(join(path, "activity"));
  const sessionId = randomUUID(), executionId = randomUUID();
  let worker = { id: sessionId, generation: 2, executor: "orbstack-container", execution: { executionId } } as SessionRecord;
  const wrapped = activityInstructionStore(store, activity, () => worker);
  const record = InstructionRecordSchema.parse({ id: randomUUID(), actorSessionId: randomUUID(), targetSessionId: sessionId,
    message: "private task", status: "accepted", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), messageId: randomUUID() });
  return { path, store, activity, wrapped, record, executionId,
    advance: () => { worker = { ...worker, generation: 3, execution: { ...worker.execution!, executionId: randomUUID() } }; } };
}
test("fsync latency and a later wake cannot rewrite an instruction's dispatch generation", async () => {
  const f = await fixture(); await f.wrapped.put(f.record);
  const accepted = (await f.store.list())[0]!;
  const put = f.store.put.bind(f.store);
  vi.spyOn(f.store, "put").mockImplementation(async record => { f.advance(); await put(record); });
  await f.wrapped.put({ ...accepted, status: "rendered" });
  const rendered = (await f.store.list())[0]!;
  expect(rendered.attemptGeneration).toBe(2);
  await f.wrapped.put({ ...rendered, status: "completed", updatedAt: new Date(1).toISOString() });
  const terminal = (await f.store.list())[0]!;
  expect(terminal.terminalActivity).toMatchObject({ generation: 2, executionId: f.executionId });
  expect(JSON.stringify(terminal.terminalActivity)).not.toContain("private task");
  await f.activity.close();
});
test("canonical settlement survives a crash before activity append and reconciles exactly once after restart", async () => {
  const f = await fixture(); await f.wrapped.put(f.record);
  const record = (await f.store.list())[0]!;
  vi.spyOn(f.activity, "append").mockRejectedValueOnce(new Error("crash before activity write"));
  await f.wrapped.put({ ...record, status: "completed", updatedAt: new Date(1).toISOString() });
  await f.activity.close(); f.advance();
  const reopened = await AgentActivityStore.open(join(f.path, "activity"));
  const runtime = await brokerEvaluationRuntime({ directory: f.path, instructionSourceId: "fixture-instructions", activity: reopened, instructions: () => new InstructionStore(f.path).list(), jobs: new JobStore(f.path) });
  await runtime.replay.reconcile();
  expect(runtime.health().capture.state).toBe("caught-up");
  expect(runtime.store.health().pending).toBe(1);
  await runtime.replay.reconcile();
  const claim = runtime.store.claim(0, 100)!;
  expect(claim.intent).toMatchObject({ generation: 2, executionId: f.executionId, instructionId: record.id });
  await runtime.close(); await reopened.close();
});
test("a mismatched persisted projection is refused without append", async () => {
  const f = await fixture(); await f.wrapped.put(f.record);
  await f.wrapped.put({ ...(await f.store.list())[0]!, status: "completed" });
  const record = (await f.store.list())[0]!;
  record.terminalActivity!.generation = 99;
  const outbox = new TaskEvaluationStore(join(f.path, "eval.sqlite")), append = vi.fn();
  await expect(repairTerminalInstructionProjections(outbox, { append }, [record])).rejects.toThrow("EVALUATION_CANONICAL_IDENTITY_CONFLICT");
  expect(append).not.toHaveBeenCalled(); outbox.close(); await f.activity.close();
});


test("broker startup seals preexisting unverified history without exempting a later projection gap", async () => {
  const f = await fixture(); await f.store.put({ ...f.record, status: "completed" });
  const open = () => brokerEvaluationRuntime({ directory: f.path, instructionSourceId: "fixture-journal", activity: f.activity,
    instructions: () => f.store.list(), instructionVersion: () => f.store.version(), jobs: new JobStore(f.path) });
  const first = await open();
  expect(first.health()).toMatchObject({ capture: { state: "caught-up" }, legacy: { snapshots: 1 } });
  expect(first.store.legacyDispositions()).toMatchObject([{ disposition: "unverified", reason: "legacy-terminal-attempt-identity-unavailable" }]);
  expect(first.store.health().pending).toBe(0); await first.close();
  await f.store.put({ ...f.record, id: randomUUID(), status: "completed" });
  const restarted = await open();
  expect(restarted.health()).toMatchObject({ capture: { state: "gap", reason: "canonical-instruction-projection-missing" }, legacy: { snapshots: 1 } });
  expect(restarted.admissionHold()).toBe("evaluation-capture-gap");
  await restarted.close(); await f.activity.close();
});
