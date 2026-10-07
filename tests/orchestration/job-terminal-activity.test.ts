import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { JobControlPlane, type PersistedJobState } from "../../src/control-plane/job-control-plane.js";
import { defaultProviderRegistry } from "../../src/control-plane/provider-registry.js";
import { JobRecordSchema, type JobResult } from "../../src/domain/job.js";
import { JobStore } from "../../src/persistence/job-store.js";
import { AgentActivityStore } from "../../src/persistence/agent-activity-store.js";
import { TaskEvaluationStore } from "../../src/persistence/task-evaluation-store.js";
import { TaskEvaluationService } from "../../src/orchestration/task-evaluation-service.js";
import { TaskEvaluationReconciliationService } from "../../src/orchestration/task-evaluation-reconciliation.js";
import { auditTerminalJobs, projectJobTerminalActivity, repairTerminalJobProjections } from "../../src/orchestration/job-terminal-activity.js";
import { projectActivity } from "../../src/observability/activity-projection.js";
import { evaluateEvidence } from "../../src/runtime/execution/task-evaluation-executor-report.js";

const createdAt = "2026-09-16T08:00:00.000Z", endedAt = "2026-09-16T08:01:00.000Z";
const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
function state(result: JobResult = { outcome: "completed", artifacts: [] }): PersistedJobState {
  return { idempotencyKey: randomUUID(), record: JobRecordSchema.parse({ schemaVersion: 1, id: randomUUID(), correlationId: randomUUID(),
    request: { schemaVersion: 1, provider: "codex", cwd: "/private/secret", sandbox: "workspace-write", instruction: "SECRET_PROMPT", model: "launch-only-model" },
    lifecycle: { status: "settled", finishedAt: endedAt, result }, createdAt, updatedAt: endedAt }) };
}
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "job-terminal-activity-")); paths.push(path);
  const jobs = new JobStore(path), activity = await AgentActivityStore.open(join(path, "activity")), outbox = new TaskEvaluationStore(join(path, "evaluations.sqlite"));
  const service = new TaskEvaluationService(outbox, { capture: async event => ({ generation: event.generation!, manifest: {
    schemaVersion: 1, terminalEvent: event, complete: false, checks: [], metadata: { modelSource: "unknown" },
  } }) }, { id: "production-attempt", version: "1" });
  const replay = new TaskEvaluationReconciliationService(activity, outbox, service, { consumer: "jobs-v1", auditCanonicalCoverage: async () => {
    const states = await jobs.load(); await repairTerminalJobProjections(outbox, activity, states); return auditTerminalJobs(outbox, states);
  } });
  return { path, jobs, activity, outbox, replay, close: async () => { await activity.close(); outbox.close(); } };
}

test("fsynced job without activity is repaired after reopening and captured before checkpoint advances", async () => {
  const f = await fixture(), original = state();
  try {
    await f.jobs.append(original);
    const recovered = await new JobStore(f.path).load();
    expect(await auditTerminalJobs(f.outbox, recovered)).toEqual({ state: "gap", reason: "canonical-job-projection-missing" });
    await repairTerminalJobProjections(f.outbox, f.activity, recovered);
    expect(f.outbox.health().pending).toBe(0); // An activity append alone is not outbox coverage.
    expect(await f.replay.reconcile()).toMatchObject({ state: "caught-up", checkpoint: 1 });
    const claim = f.outbox.claim(0, 100)!;
    expect(claim.intent).toMatchObject({ jobId: original.record.id, generation: 1, attribution: "unattributed" });
    expect(evaluateEvidence(claim)).toMatchObject({ disposition: "unverified" });
    f.outbox.finish(claim, evaluateEvidence(claim), 1); f.outbox.acknowledge(claim.key);
    expect(await auditTerminalJobs(f.outbox, recovered)).toEqual({ state: "complete" });
  } finally { await f.close(); }
});

test("report-back mutation and replay before outbox capture preserve exactly one historical event", async () => {
  const f = await fixture(), original = state();
  try {
    original.parentSessionId = randomUUID();
    await f.jobs.append(original);
    await repairTerminalJobProjections(f.outbox, f.activity, await f.jobs.load());
    const later = structuredClone(original);
    later.record.updatedAt = "2026-09-16T10:00:00.000Z";
    later.reportBack = { schemaVersion: 1, jobId: later.record.id, correlationId: later.record.correlationId, parentSessionId: original.parentSessionId,
      result: { outcome: "completed", artifacts: [] }, state: "failed", attempts: 5, createdAt: endedAt, updatedAt: later.record.updatedAt, lastError: "SECRET_REPORT_ERROR" };
    await f.jobs.append(later);
    expect(projectJobTerminalActivity(later)).toEqual(projectJobTerminalActivity(original));
    await repairTerminalJobProjections(f.outbox, f.activity, await f.jobs.load());
    expect(f.activity.replayBounds().sequence).toBe(1);
    expect(await f.replay.reconcile()).toMatchObject({ state: "caught-up" });
    await repairTerminalJobProjections(f.outbox, f.activity, await f.jobs.load());
    expect(f.outbox.health().pending).toBe(1);
  } finally { await f.close(); }
});

test("distinct jobs retain separate identities despite sharing a historical parent", async () => {
  const f = await fixture(), parentSessionId = randomUUID(), first = state(), second = state();
  try {
    first.parentSessionId = second.parentSessionId = parentSessionId;
    await repairTerminalJobProjections(f.outbox, f.activity, [first, second]);
    await f.jobs.append(first); await f.jobs.append(second);
    expect(await f.replay.reconcile()).toMatchObject({ state: "caught-up" });
    expect(f.outbox.health().pending).toBe(2);
    const events = await f.activity.readGlobal(0, 10);
    expect(events.map(e => e.sessionId)).toEqual([parentSessionId, parentSessionId]);
    expect(new Set(events.map(e => e.eventId)).size).toBe(2);
  } finally { await f.close(); }
});

test("recovered interruption and later settlement remain distinct transitions of one job", () => {
  const original = state(), interrupted = structuredClone(original);
  interrupted.record.lifecycle = { status: "interrupted", interruptedAt: endedAt, reason: "SECRET_RUNTIME_ERROR" };
  const first = projectJobTerminalActivity(interrupted)!, last = projectJobTerminalActivity(original)!;
  expect(first).toMatchObject({ jobId: original.record.id, generation: 1, outcome: "unknown", observedAt: endedAt });
  expect(last).toMatchObject({ jobId: original.record.id, generation: 1, outcome: "succeeded" });
  expect(first.eventId).not.toBe(last.eventId);
  expect(projectJobTerminalActivity({ ...interrupted, record: { ...interrupted.record, updatedAt: "2026-09-16T12:00:00.000Z" } })).toEqual(first);
});

test("canonical recovery persists interruption before repair and later cancellation is captured", async () => {
  const f = await fixture(), original = state();
  try {
    original.record.lifecycle = { status: "running", startedAt: createdAt };
    expect(projectJobTerminalActivity(original)).toBeNull();
    await f.jobs.append(original);
    const plane = new JobControlPlane({ store: f.jobs, registry: defaultProviderRegistry(), now: () => endedAt });
    await plane.recover();
    await repairTerminalJobProjections(f.outbox, f.activity, await f.jobs.load());
    expect(await f.replay.reconcile()).toMatchObject({ state: "caught-up" });
    const interrupted = (await f.activity.readGlobal(0, 10))[0]!;
    expect(interrupted).toMatchObject({ kind: "job.settled", outcome: "unknown", jobId: original.record.id, generation: 1 });
    await plane.cancel(original.record.id, "operator cancelled recovered job");
    await repairTerminalJobProjections(f.outbox, f.activity, await f.jobs.load());
    expect(await f.replay.reconcile()).toMatchObject({ state: "caught-up" });
    const events = await f.activity.readGlobal(0, 10);
    expect(events.map(event => event.outcome)).toEqual(["unknown", "cancelled"]);
    expect(new Set(events.map(event => event.jobId)).size).toBe(1);
  } finally { await f.close(); }
});

test.each([
  [{ outcome: "completed", artifacts: [] }, "succeeded", "unverified"],
  [{ outcome: "failed", error: { code: "DISPATCH_REJECTED", message: "secret" }, artifacts: [] }, "failed", "unverified"],
  [{ outcome: "cancelled", reason: "secret" }, "cancelled", "cancelled"],
  [{ outcome: "timedOut" }, "failed", "unverified"],
] as const)("terminal %j has honest outcome %s and disposition %s", async (result, outcome, disposition) => {
  const f = await fixture(), record = state(result as JobResult);
  try {
    await f.jobs.append(record); await repairTerminalJobProjections(f.outbox, f.activity, await f.jobs.load()); await f.replay.reconcile();
    expect(projectJobTerminalActivity(record)?.outcome).toBe(outcome);
    expect(evaluateEvidence(f.outbox.claim(0, 100)!)).toMatchObject({ disposition });
  } finally { await f.close(); }
});

test("standalone job subject aliases and historical sessions do not invent execution/model identity", () => {
  const original = state(), standalone = projectJobTerminalActivity(original)!;
  expect(standalone).toMatchObject({ jobId: original.record.id, runId: original.record.id, sessionId: original.record.id, workerId: original.record.id });
  original.record.sessionId = randomUUID(); original.parentSessionId = randomUUID();
  expect(projectJobTerminalActivity(original)).toMatchObject({ sessionId: original.record.sessionId });
  expect(standalone.model).toBeUndefined(); expect(standalone.executionId).toBeUndefined(); expect(standalone.instructionId).toBeUndefined();
});

test("invalid historical identity/time and bounded inventory fail closed before any repair", async () => {
  const valid = state(), broken = structuredClone(valid);
  delete (broken.record.lifecycle as { finishedAt?: string }).finishedAt;
  const activity = { append: vi.fn() }, outbox = { hasTerminalSource: () => false };
  await expect(repairTerminalJobProjections(outbox, activity, [valid, broken])).rejects.toThrow("EVALUATION_JOB_HISTORY_INVALID");
  expect(activity.append).not.toHaveBeenCalled();
  expect(await auditTerminalJobs(outbox, [broken])).toEqual({ state: "gap", reason: "EVALUATION_JOB_HISTORY_INVALID" });
  const badIdentity = { ...valid, parentSessionId: "not-a-session" };
  expect(() => projectJobTerminalActivity(badIdentity)).toThrow("EVALUATION_JOB_HISTORY_INVALID");
  const reversed = state(); reversed.record.createdAt = "2026-09-17T00:00:00.000Z";
  expect(() => projectJobTerminalActivity(reversed)).toThrow("EVALUATION_JOB_HISTORY_INVALID");
  const unsupported = state(); unsupported.record.schemaVersion = 2;
  expect(() => projectJobTerminalActivity(unsupported)).toThrow("EVALUATION_JOB_HISTORY_INVALID");
  expect(await auditTerminalJobs(outbox, [valid, state()], 1)).toEqual({ state: "gap", reason: "EVALUATION_JOB_AUDIT_LIMIT" });
  expect(await auditTerminalJobs(outbox, [valid, valid])).toEqual({ state: "gap", reason: "EVALUATION_JOB_HISTORY_INVALID" });
});

test("raw instructions, artifacts, summaries, errors and launch model never enter activity or telemetry", () => {
  const original = state({ outcome: "failed", error: { code: "DISPATCH_REJECTED", message: "SECRET_ERROR" }, artifacts: [{ schemaVersion: 1,
    id: randomUUID() as never, name: "SECRET_ARTIFACT", mediaType: "text/plain", content: { kind: "inline", mediaType: "text/plain", text: "SECRET_SOURCE" }, createdAt }] });
  const event = projectJobTerminalActivity(original)!, remote = projectActivity({ ...event, sequence: 1 });
  const encoded = JSON.stringify({ event, remote });
  expect(encoded).not.toContain("SECRET"); expect(encoded).not.toContain("/private/secret"); expect(encoded).not.toContain("launch-only-model");
});

test("failed activity write prevents repair completion and cannot manufacture outbox coverage", async () => {
  const original = state(), outbox = { hasTerminalSource: () => false };
  await expect(repairTerminalJobProjections(outbox, { append: async () => { throw new Error("disk full"); } }, [original])).rejects.toThrow("disk full");
  expect(await auditTerminalJobs(outbox, [original])).toMatchObject({ state: "gap" });
});
