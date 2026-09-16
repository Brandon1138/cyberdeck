import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ActivityInput } from "../../src/domain/agent-activity.js";
import { AgentActivityStore } from "../../src/persistence/agent-activity-store.js";
import { TaskEvaluationStore } from "../../src/persistence/task-evaluation-store.js";
import { TaskEvaluationService } from "../../src/orchestration/task-evaluation-service.js";
import { TaskEvaluationReconciliationService, auditTerminalInstructions } from "../../src/orchestration/task-evaluation-reconciliation.js";
import { withActivitySink } from "../../src/orchestration/activity-sink.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function input(overrides: Partial<ActivityInput> = {}): ActivityInput {
  const id = randomUUID();
  return { schemaVersion: 1, eventId: randomUUID(), sourceKey: id, runId: id, workerId: id, sessionId: id, generation: 2,
    observedAt: new Date(0).toISOString(), kind: "provider.turn", provenance: "provider-native", coverage: "complete-for-source",
    operation: "agent", outcome: "succeeded", origin: "initial-prompt", ...overrides };
}
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "eval-recovery-")); directories.push(path);
  const activityPath = join(path, "activity"), outboxPath = join(path, "outbox.sqlite");
  const openActivity = () => AgentActivityStore.open(activityPath, { maxBytes: 65536, maxAgeMs: 1, now: () => 1000 });
  const activity = await openActivity(), outbox = new TaskEvaluationStore(outboxPath);
  const capture = vi.fn(async (event: Parameters<TaskEvaluationService["observeTerminal"]>[0]) => ({ generation: event.generation!,
    manifest: { schemaVersion: 1 as const, terminalEvent: event, checks: [], complete: false, metadata: { modelSource: "unknown" as const } } }));
  const service = (store = outbox) => new TaskEvaluationService(store, { capture }, { id: "production", version: "1" });
  const reconciler = (source = activity, store = outbox, options = {}) => new TaskEvaluationReconciliationService(withActivitySink(source), store, service(store),
    { consumer: "production-v1", pageSize: 1, maxPages: 1, auditCanonicalCoverage: async () => ({ state: "complete" }), ...options });
  return { path, activityPath, outboxPath, activity, outbox, capture, service, reconciler, openActivity };
}
test("sealed legacy activity survives restart and bypasses only the exact historical event", async () => {
  const f = await fixture(), instructionId = randomUUID(), sessionId = randomUUID(), updatedAt = new Date(0).toISOString();
  const record = { id: instructionId, targetSessionId: sessionId, updatedAt, status: "completed", message: "historical" };
  const { generation: _generation, ...legacy } = input({ kind: "instruction.settled", provenance: "broker", instructionId, sessionId,
    occurredAt: updatedAt, sourceKey: `instruction:${instructionId}:completed:${updatedAt}` });
  const event = await f.activity.append(legacy), sourceId = f.activity.replayBounds().sourceId;
  f.outbox.initializeLegacyTerminalSnapshot("instructions", [record], 100, { sourceId, throughSequence: 1, events: [event] });
  expect(f.outbox.hasLegacyTerminalActivity(sourceId, event)).toBe(true);
  expect(f.outbox.hasLegacyTerminalActivity("replacement", event)).toBe(false);
  for (const changed of [{ ...event, sequence: 2 }, { ...event, observedAt: new Date(1).toISOString() }, { ...event, generation: 1 }])
    expect(f.outbox.hasLegacyTerminalActivity(sourceId, changed)).toBe(false);
  await f.activity.close(); f.outbox.close();
  const activity = await f.openActivity(), outbox = new TaskEvaluationStore(f.outboxPath);
  expect(await f.reconciler(activity, outbox, { auditCanonicalCoverage: () => auditTerminalInstructions(outbox, [record]) }).reconcile())
    .toMatchObject({ state: "caught-up", checkpoint: 1 });
  expect(f.capture).not.toHaveBeenCalled(); expect(outbox.claim(0, 10)).toBeUndefined();
  await activity.append({ ...legacy, eventId: randomUUID(), sourceKey: "new-missing-generation", instructionId: randomUUID() });
  expect(await f.reconciler(activity, outbox).reconcile()).toMatchObject({ state: "gap", reason: "EVALUATION_GENERATION_UNKNOWN", checkpoint: 1 });
  await activity.close(); outbox.close();
});
test("legacy activity correlation rejects any mismatched identity field and known generation", async () => {
  const f = await fixture(), id = randomUUID(), sessionId = randomUUID(), updatedAt = new Date(0).toISOString();
  const record = { id, targetSessionId: sessionId, updatedAt, status: "completed" };
  const { generation: _generation, ...legacy } = input({ kind: "instruction.settled", provenance: "broker", instructionId: id, sessionId,
    occurredAt: updatedAt, sourceKey: `instruction:${id}:completed:${updatedAt}` });
  const changes = [{ instructionId: randomUUID() }, { sessionId: randomUUID() }, { occurredAt: new Date(1).toISOString() },
    { provenance: "worker-report" as const }, { kind: "instruction.cancelled" as const }, { generation: 2 }, { sourceKey: "other" }];
  const events = changes.map((change, i) => ({ ...legacy, ...change, sequence: i + 1 }));
  f.outbox.initializeLegacyTerminalSnapshot("instructions", [record], 100, { sourceId: "activity", throughSequence: events.length, events });
  expect(f.outbox.legacyMigration()?.activity?.events).toBe(0);
  for (const event of events) expect(f.outbox.hasLegacyTerminalActivity("activity", event)).toBe(false);
  await f.activity.close(); f.outbox.close();
});
test("settlement-before-enqueue crash replays bounded pages after restart without pruning pending history", async () => {
  const f = await fixture(); await f.activity.retainAfter("production-v1", 0);
  await f.activity.append(input()); await f.activity.append(input());
  await f.activity.close(); f.outbox.close(); // No observer ran before this restart.
  const activity = await f.openActivity(), outbox = new TaskEvaluationStore(f.outboxPath), replay = f.reconciler(activity, outbox);
  expect(await replay.reconcile()).toMatchObject({ state: "pending", checkpoint: 1, processed: 1 });
  expect(outbox.health().pending).toBe(1);
  await activity.append(input()); // Old age alone can delete sequence 1, but never pending sequence 2.
  expect(activity.replayBounds()).toMatchObject({ firstSequence: 2, captureGaps: 0 });
  expect(await replay.reconcile()).toMatchObject({ state: "pending", checkpoint: 2 });
  expect(await replay.reconcile()).toMatchObject({ state: "caught-up", checkpoint: 3 });
  expect(outbox.health().pending).toBe(3); await activity.close(); outbox.close();
});
test("enqueue-before-checkpoint crash keeps original historical evidence and creates no duplicate", async () => {
  const f = await fixture(); await f.activity.append(input());
  const original = f.outbox.advanceCheckpoint.bind(f.outbox);
  vi.spyOn(f.outbox, "advanceCheckpoint").mockImplementation((consumer, source, expected, sequence) => {
    if (sequence > 0) throw new Error("crash-after-enqueue"); original(consumer, source, expected, sequence);
  });
  expect(await f.reconciler().reconcile()).toMatchObject({ state: "backpressure", checkpoint: 0 });
  expect(f.outbox.health().pending).toBe(1); expect(f.capture).toHaveBeenCalledTimes(1);
  await f.activity.close(); f.outbox.close();
  const activity = await f.openActivity(), outbox = new TaskEvaluationStore(f.outboxPath);
  f.capture.mockImplementation(async () => { throw new Error("current-generation-must-not-be-used"); });
  expect(await f.reconciler(activity, outbox).reconcile()).toMatchObject({ state: "caught-up", checkpoint: 1 });
  expect(outbox.health().pending).toBe(1); expect(f.capture).toHaveBeenCalledTimes(1);
  expect(outbox.claim(0, 100)!.intent.generation).toBe(2);
  await activity.close(); outbox.close();
});
test("checkpoint-before-fence crash leaves conservative retention and resumes idempotently", async () => {
  const f = await fixture(); await f.activity.append(input());
  const retain = f.activity.retainAfter.bind(f.activity);
  vi.spyOn(f.activity, "retainAfter").mockImplementation(async (consumer, sequence) => { if (sequence > 0) throw new Error("crash-before-fence"); await retain(consumer, sequence); });
  expect(await f.reconciler().reconcile()).toMatchObject({ state: "backpressure", checkpoint: 1 });
  expect(JSON.parse(await readFile(join(f.activityPath, "activity-replay.json"), "utf8")).fences["production-v1"]).toBe(0);
  await f.activity.close(); f.outbox.close();
  const activity = await f.openActivity(), outbox = new TaskEvaluationStore(f.outboxPath);
  expect(await f.reconciler(activity, outbox).reconcile()).toMatchObject({ state: "caught-up", checkpoint: 1 });
  expect(outbox.health().pending).toBe(1); await activity.close(); outbox.close();
});
test("outbox backpressure retains canonical events and checkpoint through restart", async () => {
  const f = await fixture(); await f.activity.append(input());
  vi.spyOn(f.outbox, "enqueue").mockImplementation(() => { throw new Error("disk full"); });
  expect(await f.reconciler().reconcile()).toMatchObject({ state: "backpressure", checkpoint: 0 });
  await f.activity.append(input()); expect(f.activity.replayBounds().firstSequence).toBe(1);
  await f.activity.close(); f.outbox.close();
  const activity = await f.openActivity(), outbox = new TaskEvaluationStore(f.outboxPath);
  expect(activity.replayBounds().firstSequence).toBe(1);
  expect(await f.reconciler(activity, outbox).reconcile()).toMatchObject({ state: "pending", checkpoint: 1 });
  await activity.close(); outbox.close();
});
test("missing prefix fails closed rather than starting the checkpoint at the retained suffix", async () => {
  const f = await fixture(); await f.activity.append(input()); await f.activity.append(input());
  expect(f.activity.replayBounds().firstSequence).toBe(2);
  expect(await f.reconciler().reconcile()).toMatchObject({ state: "gap", checkpoint: 0, reason: "canonical-history-pruned" });
  expect(f.outbox.health().pending).toBe(0); await f.activity.close(); f.outbox.close();
});
test("capture loss persists across restart and cannot be mistaken for acknowledged retention", async () => {
  const f = await fixture(); await f.activity.noteGap(); await f.activity.close(); f.outbox.close();
  const activity = await f.openActivity(), outbox = new TaskEvaluationStore(f.outboxPath);
  expect(await f.reconciler(activity, outbox).reconcile()).toMatchObject({ state: "gap", reason: "canonical-recorder-loss" });
  await activity.close(); outbox.close();
});
test("source replacement is detected even when its sequence happens to match", async () => {
  const f = await fixture(); await f.activity.append(input()); await f.reconciler().reconcile(); await f.activity.close();
  const metadata = join(f.activityPath, "activity-replay.json"), record = JSON.parse(await readFile(metadata, "utf8"));
  await writeFile(metadata, JSON.stringify({ ...record, sourceId: randomUUID() }));
  const activity = await f.openActivity();
  expect(await f.reconciler(activity).reconcile()).toMatchObject({ state: "gap", reason: "canonical-source-replaced" });
  await activity.close(); f.outbox.close();
});
test("canonical instruction audit detects lost projection without inventing historical generation", async () => {
  const f = await fixture(), id = randomUUID(), updatedAt = new Date(0).toISOString(), records = [{ id, status: "completed", updatedAt }];
  const audit = () => auditTerminalInstructions(f.outbox, records);
  expect(await f.reconciler(f.activity, f.outbox, { auditCanonicalCoverage: audit }).reconcile()).toMatchObject({ state: "gap", reason: "canonical-instruction-projection-missing" });
  await f.activity.append(input({ kind: "instruction.settled", instructionId: id, sourceKey: `instruction:${id}:completed:${updatedAt}` }));
  expect(await f.reconciler(f.activity, f.outbox, { auditCanonicalCoverage: audit }).reconcile()).toMatchObject({ state: "caught-up" });
  const claim = f.outbox.claim(0, 100)!; f.outbox.finish(claim, { disposition: "unverified", reason: "no checks" }, 1); f.outbox.acknowledge(claim.key);
  expect(await audit()).toEqual({ state: "complete" }); // Source index survives evidence unpinning.
  await f.activity.close(); f.outbox.close();
});
test("missing audit and unknown historical generation remain explicit gaps", async () => {
  const f = await fixture();
  const noAudit = new TaskEvaluationReconciliationService(f.activity, f.outbox, f.service(), { consumer: "production-v1" });
  expect(await noAudit.reconcile()).toMatchObject({ state: "gap", reason: "canonical-instruction-coverage-unavailable" });
  const event = input(); delete event.generation; await f.activity.append(event);
  expect(await f.reconciler().reconcile()).toMatchObject({ state: "gap", reason: "EVALUATION_GENERATION_UNKNOWN", checkpoint: 0 });
  expect(f.capture).not.toHaveBeenCalled(); await f.activity.close(); f.outbox.close();
});
test("health cannot stay caught up when new activity or capture loss arrives", async () => {
  const f = await fixture(), replay = f.reconciler();
  expect(await replay.reconcile()).toMatchObject({ state: "caught-up" });
  await f.activity.append(input()); expect(replay.health()).toMatchObject({ state: "pending" });
  expect(await replay.reconcile()).toMatchObject({ state: "caught-up" });
  await f.activity.noteGap(); expect(replay.health()).toMatchObject({ state: "gap", reason: "canonical-recorder-loss" });
  await f.activity.close(); f.outbox.close();
});
test("worker-reported check sources never enter the durable outbox as verified evidence", async () => {
  const f = await fixture(); await f.activity.append(input());
  const service = new TaskEvaluationService(f.outbox, { capture: async event => ({ generation: event.generation!, manifest: {
    schemaVersion: 1, terminalEvent: event, complete: true, metadata: { modelSource: "unknown" },
    checks: [{ id: "tests", passed: true, source: "worker-report" as "host-verified", artifactHash: "a".repeat(64) }],
  } }) }, { id: "production", version: "1" });
  const replay = new TaskEvaluationReconciliationService(f.activity, f.outbox, service, { consumer: "production-v1" });
  expect(await replay.reconcile()).toMatchObject({ state: "gap", checkpoint: 0, reason: "EVALUATION_EVIDENCE_NOT_CANONICAL" });
  expect(f.outbox.health().pending).toBe(0); await f.activity.close(); f.outbox.close();
});
