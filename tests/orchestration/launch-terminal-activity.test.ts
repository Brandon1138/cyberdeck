import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionRecordSchema } from "../../src/domain/session.js";
import type { SessionLaunchIntent } from "../../src/domain/session-launch-intent.js";
import { SessionLaunchIntentStore } from "../../src/persistence/session-launch-intent-store.js";
import { AgentActivityStore } from "../../src/persistence/agent-activity-store.js";
import { TaskEvaluationStore } from "../../src/persistence/task-evaluation-store.js";
import { TaskEvaluationService } from "../../src/orchestration/task-evaluation-service.js";
import { TaskEvaluationReconciliationService } from "../../src/orchestration/task-evaluation-reconciliation.js";
import { auditTerminalLaunches, projectLaunchTerminalActivity, repairTerminalLaunchProjections, retireCapturedLaunches } from "../../src/orchestration/launch-terminal-activity.js";
import { evaluateEvidence } from "../../src/runtime/execution/task-evaluation-executor-report.js";
import { projectActivity } from "../../src/observability/activity-projection.js";
import { brokerEvaluationRuntime } from "../../src/runtime/resources/broker-evaluation-runtime.js";

const createdAt = "2026-09-16T08:00:00.000Z", terminalAt = "2026-09-16T08:01:00.000Z";
const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
function intent(outcome: SessionLaunchIntent["outcome"] = "cancelled", terminalFromPhase: SessionLaunchIntent["terminalFromPhase"] = "ready"): SessionLaunchIntent {
  const requestId = randomUUID();
  return { record: SessionRecordSchema.parse({ id: randomUUID(), provider: "codex", model: "launch-only-model", cwd: "/private/SECRET_PATH",
    detached: true, sandbox: "workspace-write", kind: "worker", generation: 1, createdAt, updatedAt: terminalAt,
    executionState: "cancelled", attachmentState: "detached", pid: 0, exitCode: null, childIds: [], pendingLaunch: { requestId, state: "cancelled" } }),
    requestId, initialPrompt: "SECRET_PROMPT", phase: "terminal", outcome, terminalAt, terminalFromPhase, terminalProjectionCommitted: true };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "launch-terminal-activity-")); paths.push(directory);
  const launches = await SessionLaunchIntentStore.open(directory, () => {});
  const activity = await AgentActivityStore.open(join(directory, "activity"));
  const outbox = new TaskEvaluationStore(join(directory, "evaluations.sqlite"));
  const service = new TaskEvaluationService(outbox, { capture: async event => ({ generation: event.generation!, manifest: {
    schemaVersion: 1, terminalEvent: event, complete: false, checks: [], metadata: { modelSource: "unknown" },
  } }) }, { id: "production-attempt", version: "1" });
  const replay = new TaskEvaluationReconciliationService(activity, outbox, service, { consumer: "launches-v1", auditCanonicalCoverage: async () => {
    await repairTerminalLaunchProjections(outbox, activity, launches.list());
    const audit = auditTerminalLaunches(outbox, launches.list());
    if (audit.state === "complete") await retireCapturedLaunches(outbox, launches);
    return audit;
  } });
  return { directory, launches, activity, outbox, service, replay, close: async () => { await activity.close(); outbox.close(); } };
}

test("terminal-write crash recovers the original prompt boundary and only retires after durable outbox capture", async () => {
  const f = await fixture(), original = intent();
  try {
    await f.launches.put(original);
    const reopened = await SessionLaunchIntentStore.open(f.directory, () => {});
    expect(auditTerminalLaunches(f.outbox, reopened.list())).toMatchObject({ state: "gap" });
    await repairTerminalLaunchProjections(f.outbox, f.activity, reopened.list());
    await retireCapturedLaunches(f.outbox, f.launches);
    expect(f.launches.list()).toHaveLength(1); // Appended activity is not an outbox receipt.
    expect(await f.replay.reconcile()).toMatchObject({ state: "caught-up", checkpoint: 1 });
    expect(f.launches.list()).toHaveLength(0);
    const claim = f.outbox.claim(0, 100)!;
    expect(claim.intent).toMatchObject({ sessionId: original.record.id, generation: 1, attribution: "initial-prompt" });
    expect(claim.intent.instructionId).toBeUndefined(); expect(claim.intent.executionId).toBeUndefined();
    expect(evaluateEvidence(claim)).toEqual({ disposition: "cancelled", reason: "canonical-cancellation" });
  } finally { await f.close(); }
});

test("enqueue-before-checkpoint replay keeps one immutable attempt and retryable retirement", async () => {
  const f = await fixture(), original = intent("failed");
  try {
    await f.launches.put(original); await repairTerminalLaunchProjections(f.outbox, f.activity, f.launches.list());
    await f.service.observeTerminal((await f.activity.readGlobal(0, 10))[0]!);
    const failure = vi.spyOn(f.launches, "ackTerminal").mockRejectedValueOnce(new Error("disk full"));
    expect(await f.replay.reconcile()).toMatchObject({ state: "backpressure" });
    expect(f.launches.list()).toHaveLength(1);
    failure.mockRestore();
    expect(await f.replay.reconcile()).toMatchObject({ state: "caught-up" });
    expect(f.outbox.health().pending).toBe(1);
    expect((await SessionLaunchIntentStore.open(f.directory, () => {})).list()).toHaveLength(0);
  } finally { await f.close(); }
});

test("captured launch retains its recovery source until catalog projection commits", async () => {
  const f = await fixture(), original = intent(); original.terminalProjectionCommitted = false;
  try {
    await f.launches.put(original);
    await repairTerminalLaunchProjections(f.outbox, f.activity, f.launches.list());
    expect(await f.replay.reconcile()).toMatchObject({ state: "caught-up" });
    expect(f.outbox.health().pending).toBe(1);
    expect((await SessionLaunchIntentStore.open(f.directory, () => {})).list()).toHaveLength(1);
    await f.launches.markTerminalProjected(original.record.id, original.requestId, original.terminalAt!);
    await f.replay.reconcile();
    expect((await SessionLaunchIntentStore.open(f.directory, () => {})).list()).toHaveLength(0);
    expect(f.outbox.health().pending).toBe(1);
  } finally { await f.close(); }
});

test("broker startup repairs reopened launch history and automatically captures later terminal launches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "broker-launch-evaluation-")); paths.push(directory);
  const sourceId = randomUUID(), original = intent();
  const beforeCrash = await SessionLaunchIntentStore.open(directory, () => {});
  await beforeCrash.put(original);
  const launches = await SessionLaunchIntentStore.open(directory, () => {});
  const activity = await AgentActivityStore.open(join(directory, "activity"));
  const options = { directory, instructionSourceId: sourceId, activity, launches,
    instructions: async () => [], instructionVersion: () => 0, jobs: { load: async () => [], version: () => 0 } };
  let runtime = await brokerEvaluationRuntime(options);
  try {
    expect(runtime.admissionHold()).toBe("evaluation-capture-gap");
    await vi.waitFor(() => expect(runtime.health()).toMatchObject({ startupReady: true, outbox: { pending: 1 } }), { timeout: 5000 });
    expect(launches.list()).toHaveLength(0);
    const next = intent("failed"); await launches.put(next);
    await vi.waitFor(() => {
      expect(runtime.health()).toMatchObject({ capture: { state: "caught-up" }, outbox: { pending: 2 } });
      expect(launches.list()).toHaveLength(0);
    }, { timeout: 5000 });
    await runtime.close();
    runtime = await brokerEvaluationRuntime(options);
    expect(runtime.admissionHold()).toBeNull();
    expect(runtime.health().outbox.pending).toBe(2);
    const claim = runtime.store.claim(0, 100)!;
    expect(claim.intent.sessionId).toBe(original.record.id);
    expect(evaluateEvidence(claim)).toMatchObject({ disposition: "cancelled" });
  } finally { await runtime.close(); await activity.close(); }
});

test.each([
  ["cancelled", "ready", "cancelled"], ["failed", "preparing", "infrastructure-error"],
  ["failed", "ready", "infrastructure-error"], ["failed", "launching", "unverified"],
  ["interrupted", "ready", "unverified"], ["interrupted", "launching", "unverified"],
] as const)("%s from %s stays %s without grading model quality", async (outcome, phase, disposition) => {
  const f = await fixture();
  try {
    await f.launches.put(intent(outcome, phase));
    await repairTerminalLaunchProjections(f.outbox, f.activity, f.launches.list()); await f.replay.reconcile();
    expect(evaluateEvidence(f.outbox.claim(0, 100)!)).toMatchObject({ disposition });
  } finally { await f.close(); }
});

test("launched and absent-prompt terminal records do not invent terminal provider tasks", () => {
  expect(projectLaunchTerminalActivity(intent("launched", "launching"))).toBeNull();
  const empty = intent(); delete empty.initialPrompt;
  expect(projectLaunchTerminalActivity(empty)).toBeNull();
  const queued = intent(); queued.phase = "ready"; delete queued.outcome; delete queued.terminalAt; delete queued.terminalFromPhase;
  expect(projectLaunchTerminalActivity(queued)).toBeNull();
});

test("missing identity, contradictory history and excessive audit input fail closed", async () => {
  const original = intent(), invalid = structuredClone(original); delete invalid.record.generation;
  const activity = { append: vi.fn() }, outbox = { hasTerminalSource: () => false };
  await expect(repairTerminalLaunchProjections(outbox, activity, [original, invalid])).rejects.toThrow("EVALUATION_LAUNCH_HISTORY_INVALID");
  expect(activity.append).not.toHaveBeenCalled();
  expect(auditTerminalLaunches(outbox, [original, original])).toMatchObject({ state: "gap" });
  expect(auditTerminalLaunches(outbox, [original, intent()], 1)).toMatchObject({ state: "gap" });
  const backwards = intent(); backwards.terminalAt = "2026-09-15T00:00:00.000Z";
  expect(() => projectLaunchTerminalActivity(backwards)).toThrow("EVALUATION_LAUNCH_HISTORY_INVALID");
});

test("private input and requested model are not observed facts or remote payloads", () => {
  const original = intent(), event = projectLaunchTerminalActivity(original)!;
  const remote = projectActivity({ ...event, sequence: 1 });
  expect(event.model).toBeUndefined(); expect(event.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(remote).not.toHaveProperty("sourceHash");
  expect(JSON.stringify({ event, remote })).not.toMatch(/SECRET|launch-only-model/);
  expect(projectLaunchTerminalActivity(structuredClone(original))).toEqual(event);
});
