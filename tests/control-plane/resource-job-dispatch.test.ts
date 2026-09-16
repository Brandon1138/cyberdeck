import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { JobControlPlane, type PersistedJobState } from "../../src/control-plane/job-control-plane.js";
import { defaultProviderRegistry } from "../../src/control-plane/provider-registry.js";
import { DispatchRequestSchema, type DispatchRequest, type JobDispatchAdapter } from "../../src/domain/dispatch.js";
import { resourceJobRecord } from "../../src/orchestration/resource-job-record.js";
import { AdmissionScheduler } from "../../src/control-plane/admission-scheduler.js";

const request = { provider: "codex", cwd: "/tmp/repo", sandbox: "read-only", instruction: "inspect", model: "explicit-model" };
test("resource waits return queued receipts and do not hide a second family behind dispatch acknowledgment", async () => {
  const scheduler = new AdmissionScheduler({ limits: { schemaVersion: 1 } }); scheduler.openAdmission();
  const plane = new JobControlPlane({ registry: defaultProviderRegistry(), scheduler, deferDispatchAcknowledgment: true });
  const waiting = new Map<string, (error: Error) => void>();
  plane.registerAdapter({ provider: "codex", dispatch: input => new Promise((_resolve, reject) => { waiting.set(input.jobId, reject); }),
    cancel: async input => { waiting.get(input.jobId)!(new Error("cancelled")); return { accepted: true, jobId: input.jobId }; },
    onReport: () => () => {} });
  const first = await plane.delegate({ request, delegationId: randomUUID(), correlationId: randomUUID(), parentSessionId: randomUUID() });
  const second = await plane.delegate({ request, delegationId: randomUUID(), correlationId: randomUUID(), parentSessionId: randomUUID() });
  expect(first.job.lifecycle.status).toBe("queued"); expect(second.job.lifecycle.status).toBe("queued");
  expect(waiting.size).toBe(2);
  await plane.cancel(first.job.id); await plane.cancel(second.job.id); await plane.whenIdle();
  expect(plane.listJobs().every(job => job.record.lifecycle.status === "settled")).toBe(true);
});
function waitingAdapter(accepted = true) {
  let reject!: (error: Error) => void;
  const dispatches: DispatchRequest[] = [];
  const cancel = vi.fn(async (input: Parameters<JobDispatchAdapter["cancel"]>[0]) => {
    reject(new Error("resource wait cancelled"));
    return accepted ? { accepted: true as const, jobId: input.jobId }
      : { accepted: false as const, jobId: input.jobId, code: "CANCELLATION_NOT_SUPPORTED" as const };
  });
  const adapter: JobDispatchAdapter = { provider: "codex", dispatch: input => {
    dispatches.push(input); return new Promise((_resolve, fail) => { reject = fail; });
  }, cancel, onReport: () => () => {} };
  return { adapter, dispatches, cancel };
}

test("queued in-flight admission is cancelled through its adapter and dispatch rejection cannot overwrite cancellation", async () => {
  const plane = new JobControlPlane({ registry: defaultProviderRegistry() }), waiting = waitingAdapter(); plane.registerAdapter(waiting.adapter);
  const submission = plane.submit({ request, idempotencyKey: "waiting" });
  await vi.waitFor(() => expect(waiting.dispatches).toHaveLength(1));
  const input = waiting.dispatches[0]!;
  expect(plane.getJob(input.jobId).record.lifecycle.status).toBe("queued");
  expect(resourceJobRecord(plane.dispatchContext(input.jobId), input)).toMatchObject({ id: input.jobId, generation: 1, executor: "host" });
  await plane.cancel(input.jobId, "operator cancelled"); await submission;
  expect(waiting.cancel).toHaveBeenCalledWith(expect.objectContaining({ jobId: input.jobId, reason: "operator cancelled" }));
  expect(plane.getJob(input.jobId).record.lifecycle).toMatchObject({ status: "settled", result: { outcome: "cancelled" } });
  expect(() => resourceJobRecord(plane.dispatchContext(input.jobId), input)).toThrow("CANONICAL_MISMATCH");
});

test("refused in-flight cancellation does not swallow a dispatch failure", async () => {
  const plane = new JobControlPlane({ registry: defaultProviderRegistry() }), waiting = waitingAdapter(false); plane.registerAdapter(waiting.adapter);
  const submission = plane.submit({ request, idempotencyKey: "refused" });
  await vi.waitFor(() => expect(waiting.dispatches).toHaveLength(1)); const id = waiting.dispatches[0]!.jobId;
  expect((await plane.cancel(id)).accepted).toBe(false); await submission;
  expect(plane.getJob(id).record.lifecycle).toMatchObject({ status: "settled", result: { outcome: "failed" } });
});

test("dispatch context is detached from canonical state, binds correlation/request, and rejects fictitious jobs", async () => {
  const plane = new JobControlPlane({ registry: defaultProviderRegistry() }), waiting = waitingAdapter(); plane.registerAdapter(waiting.adapter);
  const submission = plane.submit({ request, idempotencyKey: "context" });
  await vi.waitFor(() => expect(waiting.dispatches).toHaveLength(1)); const input = waiting.dispatches[0]!;
  const copy = plane.dispatchContext(input.jobId); copy.record.correlationId = randomUUID() as typeof copy.record.correlationId;
  expect(plane.dispatchContext(input.jobId).record.correlationId).toBe(input.correlationId);
  expect(() => resourceJobRecord(plane.dispatchContext(input.jobId), { ...input, correlationId: randomUUID() as typeof input.correlationId })).toThrow("CANONICAL_MISMATCH");
  expect(() => resourceJobRecord(plane.dispatchContext(input.jobId), { ...input, request: { ...input.request, instruction: "changed" } })).toThrow("CANONICAL_MISMATCH");
  expect(() => plane.dispatchContext(randomUUID())).toThrow("Unknown job");
  await plane.cancel(input.jobId); await submission;
});

test("delegated parent and immutable attempt identity survive rehydrate; interrupted jobs never relaunch", async () => {
  const states = new Map<string, PersistedJobState>(), parent = randomUUID();
  const store = { async append(state: PersistedJobState) { states.set(state.record.id, structuredClone(state)); }, async load() { return [...states.values()].map(s => structuredClone(s)); } };
  const plane = new JobControlPlane({ registry: defaultProviderRegistry(), store });
  const adapter: JobDispatchAdapter = { provider: "codex", dispatch: vi.fn(async input => ({ schemaVersion: 1, jobId: input.jobId, acceptedAt: new Date().toISOString() })),
    cancel: async input => ({ accepted: true, jobId: input.jobId }), onReport: () => () => {} };
  plane.registerAdapter(adapter);
  const delegationId = randomUUID(), correlationId = randomUUID();
  const original = await plane.delegate({ request, delegationId, correlationId, parentSessionId: parent });
  const restored = new JobControlPlane({ registry: defaultProviderRegistry(), store }); restored.registerAdapter(adapter); await restored.recover();
  const dispatch = DispatchRequestSchema.parse({ jobId: original.job.id, correlationId, request });
  expect(restored.dispatchContext(original.job.id)).toMatchObject({ parentSessionId: parent, attemptGeneration: 1, record: { lifecycle: { status: "interrupted" } } });
  expect(() => resourceJobRecord(restored.dispatchContext(original.job.id), dispatch)).toThrow("CANONICAL_MISMATCH");
  await restored.pumpQueue();
  const repeated = await restored.delegate({ request, delegationId, correlationId, parentSessionId: parent });
  expect(repeated.deduplicated).toBe(true); expect(repeated.job.id).toBe(original.job.id); expect(adapter.dispatch).toHaveBeenCalledTimes(1);
});
