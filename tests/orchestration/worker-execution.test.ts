import { randomUUID } from "node:crypto";
import { mkdtemp, rm, appendFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { SessionRecordSchema, StartSessionRequestSchema, type SessionRecord } from "../../src/domain/session.js";
import { DispatchRequestSchema } from "../../src/domain/dispatch.js";
import { JobRequestSchema } from "../../src/domain/job.js";
import { resolveWorkerExecution } from "../../src/domain/worker-execution.js";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { WorkerExecutionStore } from "../../src/persistence/worker-execution-store.js";
import { enforceJobExecutionPolicy } from "../../src/orchestration/job-execution-policy.js";
import { WorkerExecutionService } from "../../src/orchestration/worker-execution-service.js";
import { HostExecutor } from "../../src/runtime/execution/host-executor.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import type { ProviderLaunchSpec } from "../../src/orchestration/session/provider-ports.js";
import type { WorkerExecutionPort } from "../../src/orchestration/session/execution-ports.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function store() {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-execution-test-"));
  directories.push(directory);
  return { directory, store: await WorkerExecutionStore.open(directory) };
}
const launch: ProviderLaunchSpec = { executable: "fixture", args: [], cwd: "/tmp", env: {} };
function record(): SessionRecord {
  return { id: randomUUID(), provider: "codex", cwd: "/tmp", sandbox: "read-only", detached: true,
    generation: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    executionState: "starting", attachmentState: "detached", pid: 0, exitCode: null, childIds: [] };
}
function runtime(): SessionRuntime {
  const listeners = new Set<(code: number) => void>();
  return { pid: 1234, write: vi.fn(), resize: vi.fn(), snapshot: () => Buffer.alloc(0),
    kill: () => { for (const listener of listeners) listener(0); },
    onOutput: () => () => {}, onExit: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

describe("worker execution seam", () => {
  it("keeps old records host-native and preserves requested isolation through schemas", () => {
    expect(SessionRecordSchema.parse(record()).executor).toBe("host");
    expect(StartSessionRequestSchema.parse({ ...record(), executor: "orbstack-container" }).executor).toBe("orbstack-container");
    expect(() => JobRequestSchema.parse({ schemaVersion: 1, ...record(), instruction: "test", executor: "orbstack-container" })).toThrow("JOB_EXECUTOR_UNSUPPORTED");
    expect(() => resolveWorkerExecution({ executor: "host", executionProfile: "untrusted" })).toThrow("EXECUTION_PROFILE_REFUSED");
    expect(() => resolveWorkerExecution({ executor: "orbstack-container", kind: "orchestrator" })).toThrow("ORCHESTRATOR_EXECUTOR_UNSUPPORTED");
    expect(resolveWorkerExecution({ kind: "orchestrator" }, { defaultExecutor: "orbstack-container", containerProfile: "ordinary", hostProfile: "host-compatible" }).executor).toBe("host");
  });
  it("uses the real registry coordinator and persists an unavailable container intent without host spawn", async () => {
    const fixture = await store();
    const hostStart = vi.fn(runtime);
    const executions = new WorkerExecutionService(fixture.store, { host: new HostExecutor(hostStart) });
    const registry = new SessionRegistry({
      adapters: { codex: { id: "codex", buildLaunchSpec: () => launch, buildResumeSpec: () => launch } },
      executions, sessionRuntimeFactory: hostStart, journal: { append: async () => {} },
      workerTurnObservation: new WorkerTurnObservationAdapter(), validateCwd: async () => {},
      config: BrokerRuntimeConfigSchema.parse({ workerExecution: { defaultExecutor: "orbstack-container" } }),
    });
    await registry.ready();
    await expect(registry.start({ provider: "codex", cwd: "/tmp", sandbox: "read-only", detached: true })).rejects.toThrow("EXECUTOR_UNAVAILABLE");
    expect(hostStart).not.toHaveBeenCalled();
    const reopened = await WorkerExecutionStore.open(fixture.directory);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0]).toMatchObject({ phase: "failed", failure: "prepare", request: { executor: "orbstack-container" } });
  });
  it("refuses unbound job dispatch under required isolation without invoking its adapter", async () => {
    const dispatch = vi.fn();
    const guarded = enforceJobExecutionPolicy({ provider: "codex", dispatch, cancel: vi.fn(), onReport: vi.fn() },
      { defaultExecutor: "orbstack-container", hostProfile: "host-compatible", containerProfile: "ordinary" });
    await expect(guarded.dispatch(DispatchRequestSchema.parse({ schemaVersion: 1, jobId: randomUUID(), correlationId: randomUUID(),
      request: { schemaVersion: 1, provider: "codex", cwd: "/tmp", sandbox: "read-only", instruction: "fixture" },
    }))).rejects.toThrow("JOB_EXECUTOR_UNSUPPORTED");
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("preserves execution identity and bytes across stopped process generations", async () => {
    const fixture = await store();
    const factory = vi.fn(runtime);
    const service = new WorkerExecutionService(fixture.store, { host: new HostExecutor(factory) });
    const session = record();
    const first = await service.start(session, launch, 2048);
    const executionId = session.execution!.executionId;
    expect(factory).toHaveBeenCalledWith(launch, 2048);
    await expect(service.start(session, launch, 2048)).rejects.toThrow("EXECUTION_NOT_QUIESCENT");
    first.kill();
    session.generation = 2;
    await service.start(session, launch, 2048);
    expect(session.execution).toMatchObject({ executionId, workerId: session.id, generation: 2 });
  });
  it("preserves crash tails and rejects corrupted committed frames", async () => {
    const fixture = await store();
    const service = new WorkerExecutionService(fixture.store, {});
    await expect(service.start({ ...record(), executor: "orbstack-container" }, launch, 1)).rejects.toThrow();
    await appendFile(join(fixture.directory, "worker-executions.jsonl"), '{"torn":');
    const reopened = await WorkerExecutionStore.open(fixture.directory);
    expect(reopened.list()).toHaveLength(1);
    const evidence = (await readdir(fixture.directory)).find((file) => file.startsWith("execution-torn-tail-"))!;
    expect(await readFile(join(fixture.directory, evidence), "utf8")).toBe('{"torn":');
    await appendFile(join(fixture.directory, "worker-executions.jsonl"), '{}\n');
    await expect(WorkerExecutionStore.open(fixture.directory)).rejects.toThrow();
  });
  it.each(["ready-write", "start", "running-write"])("stops prepared resources after %s fails", async (boundary) => {
    const fixture = await store();
    const originalPut = fixture.store.put.bind(fixture.store);
    vi.spyOn(fixture.store, "put").mockImplementation(async (value) => {
      if (value.phase === (boundary === "ready-write" ? "ready" : boundary === "running-write" ? "running" : "never")) throw new Error("primary-failure");
      await originalPut(value);
    });
    const backend = new HostExecutor(runtime);
    if (boundary === "start") vi.spyOn(backend, "start").mockRejectedValue(new Error("primary-failure"));
    const stop = vi.spyOn(backend, "stop");
    const service = new WorkerExecutionService(fixture.store, { host: backend });
    const session = record();
    await expect(service.start(session, launch, 1)).rejects.toThrow("primary-failure");
    expect(stop).toHaveBeenCalledOnce();
    expect(fixture.store.get(session.id)).toMatchObject({ phase: "failed", cleanupFailed: false });
  });
  it("retains the binding and refuses destruction until collection is complete", async () => {
    const fixture = await store(), session = { ...record(), executor: "orbstack-container" as const };
    const ref = { brokerId: fixture.store.brokerId, executionId: randomUUID(), workerId: session.id, sessionId: session.id,
      generation: 1, executor: "orbstack-container" as const, workspaceId: "/private/clone" };
    await fixture.store.put({ schemaVersion: 1, ref, phase: "stopped", request: { executor: "orbstack-container", profile: "ordinary" }, updatedAt: new Date().toISOString() });
    const collect = vi.fn().mockResolvedValueOnce({ complete: false, manifestRef: "/evidence/incomplete" }).mockResolvedValue({ complete: true, manifestRef: "/evidence/complete" });
    const destroy = vi.fn().mockRejectedValueOnce(new Error("daemon-offline")).mockResolvedValue(undefined);
    const backend = { stop: async () => ({ ref, state: "stopped" }), collect, destroy } as unknown as WorkerExecutionPort;
    const service = new WorkerExecutionService(fixture.store, { "orbstack-container": backend });
    await expect(service.retire(session.id)).rejects.toThrow("EXECUTION_COLLECTION_INCOMPLETE");
    expect(destroy).not.toHaveBeenCalled();
    await expect(service.retire(session.id)).rejects.toThrow("daemon-offline");
    expect(fixture.store.get(session.id)).toMatchObject({ phase: "failed", manifestRef: "/evidence/complete" });
    await service.retire(session.id);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(fixture.store.get(session.id)).toMatchObject({ phase: "destroyed", manifestRef: "/evidence/complete" });
    await service.retire(session.id);
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
