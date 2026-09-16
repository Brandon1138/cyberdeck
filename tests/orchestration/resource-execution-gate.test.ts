import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import { ResourcePolicySchema } from "../../src/domain/resource-budget.js";
import type { ResourceRuntimeInspection } from "../../src/domain/resource-runtime.js";
import { ResourceReservationStore } from "../../src/persistence/resource-reservation-store.js";
import { ResourceRuntimeBindingStore } from "../../src/persistence/resource-runtime-binding-store.js";
import { ResourceAdmissionService } from "../../src/orchestration/resource-admission-service.js";
import { ResourceExecutionGate } from "../../src/orchestration/resource-execution-gate.js";

const GiB = 1024 ** 3;
const directories: string[] = [], stores: ResourceReservationStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const record = (id = "worker", generation = 1) => ({ id, generation, kind: "worker" }) as SessionRecord;
function runtime() {
  const listeners: (() => void)[] = [];
  const value: SessionRuntime = { pid: 42, write() {}, resize() {}, snapshot: () => Buffer.alloc(0),
    kill: vi.fn(), onOutput: () => () => {}, onExit: listener => { listeners.push(() => listener(0)); return () => {}; } };
  return { value, exit: () => listeners.forEach(listener => listener()) };
}
async function fixture(path?: string, recover = true) {
  if (!path) { path = await mkdtemp(join(tmpdir(), "resource-gate-test-")); directories.push(path); }
  const store = await ResourceReservationStore.open(path, "test"); stores.push(store);
  const bindings = await ResourceRuntimeBindingStore.open(path, () => store.assertOwner());
  let inspection: ResourceRuntimeInspection = { state: "running", inventoryComplete: true,
    identities: [{ kind: "native", pid: 42, startTime: "libproc:1234.000001" }] };
  let gate!: ResourceExecutionGate;
  const admission = new ResourceAdmissionService(store, ResourcePolicySchema.parse({ fixedBytes: GiB,
    uncertainBytes: GiB / 2, controlMarginBytes: GiB / 2, maxPids: 2048 }),
  () => ({ observedAt: Date.now(), availableBytes: 20 * GiB, pressure: "normal", attributionComplete: true }),
  (reservation, evidence) => gate.verifyTermination(reservation, evidence));
  const capture = vi.fn(async () => inspection.identities);
  const resolveFamily = vi.fn(() => "canonical-family");
  gate = new ResourceExecutionGate({ installationId: "test", admission, bindings, pollMs: 1,
    resolveFamily, resolveDemand: () => ({ memoryBytes: 6 * GiB, cpuWeight: 100,
      pidLimit: 32, profileId: "synthetic", profileVersion: "1" }), capture,
    inspect: async () => inspection });
  if (recover) await gate.reconcile();
  return { path, store, bindings, gate, admission, capture, resolveFamily, inspect: (value: ResourceRuntimeInspection) => { inspection = value; } };
}
describe("resource launch gate", () => {
  it("ordinary registry resume can retry after cancellation without advancing its canonical generation", async () => {
    const f = await fixture(), launched: ReturnType<typeof runtime>[] = [];
    const registry = new SessionRegistry({ config: BrokerRuntimeConfigSchema.parse({}),
      adapters: { codex: { id: "codex", buildLaunchSpec: record => ({ executable: "fixture", args: [], cwd: record.cwd, env: {} }),
        buildResumeSpec: record => ({ executable: "fixture", args: ["resume"], cwd: record.cwd, env: {} }) } },
      sessionRuntimeFactory: () => { const child = runtime(); launched.push(child); return child.value; },
      workerTurnObservation: new WorkerTurnObservationAdapter(), journal: { append: async () => {} },
      validateCwd: async () => {}, resourceExecution: f.gate });
    const session = await registry.start({ provider: "codex", cwd: "/tmp/resource-resume-fixture", detached: true, sandbox: "read-only" });
    f.inspect({ state: "terminated", inventoryComplete: true, identities: [] });
    launched[0]!.exit();
    await vi.waitFor(() => expect(registry.get(session.id).executionState).toBe("exited"));
    await f.gate.release(f.bindings.list()[0]!.request.requestId);
    f.inspect({ state: "running", inventoryComplete: true, identities: [{ kind: "native", pid: 42, startTime: "libproc:1234.000002" }] });
    await f.gate.start(record("blocker"), async () => runtime().value);
    const pending = registry.resume(session.id), rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
    await registry.stop(session.id); await rejected;
    expect(registry.get(session.id).generation).toBe(1); expect(launched).toHaveLength(1);
    f.inspect({ state: "terminated", inventoryComplete: true, identities: [] });
    await f.gate.release(f.admission.health().reservations[0]!.request.requestId);
    f.inspect({ state: "running", inventoryComplete: true, identities: [{ kind: "native", pid: 42, startTime: "libproc:1234.000003" }] });
    await registry.resume(session.id);
    expect(registry.get(session.id).generation).toBe(2); expect(launched).toHaveLength(2);
    f.inspect({ state: "terminated", inventoryComplete: true, identities: [] }); launched[1]!.exit();
    await vi.waitFor(() => expect(registry.get(session.id).executionState).toBe("exited"));
    await f.gate.release(f.admission.health().reservations[0]?.request.requestId ?? f.bindings.list().at(-1)!.request.requestId);
  });
  it("retries a cancelled queued resume after durable reopen without duplicating a launched generation", async () => {
    const f = await fixture();
    await f.gate.start(record(), async () => runtime().value);
    f.inspect({ state: "terminated", inventoryComplete: true, identities: [] });
    await f.gate.release(f.bindings.list()[0]!.request.requestId);
    f.inspect({ state: "running", inventoryComplete: true, identities: [{ kind: "native", pid: 42, startTime: "libproc:1234.000001" }] });
    await f.gate.start(record("blocker"), async () => runtime().value);
    const launch = vi.fn(async () => runtime().value);
    const resume = f.gate.start(record("worker", 2), launch), rejected = expect(resume).rejects.toThrow();
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
    f.gate.cancelStart("worker"); await rejected; expect(launch).not.toHaveBeenCalled();
    await f.store.close();
    const restored = await fixture(f.path, false);
    restored.inspect({ state: "terminated", inventoryComplete: true, identities: [] });
    await restored.gate.reconcile();
    restored.inspect({ state: "running", inventoryComplete: true, identities: [{ kind: "native", pid: 42, startTime: "libproc:1234.000002" }] });
    await restored.gate.start(record("worker", 2), launch);
    expect(launch).toHaveBeenCalledTimes(1);
    const active = restored.admission.health().reservations[0]!;
    restored.inspect({ state: "terminated", inventoryComplete: true, identities: [] });
    await restored.gate.release(active.request.requestId);
    await expect(restored.gate.start(record("worker", 2), launch)).rejects.toThrow("GENERATION_CONFLICT");
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it("allows new waiters during held recovery without treating them as surviving runtimes", async () => {
    const f = await fixture(undefined, false), launch = vi.fn(async () => runtime().value);
    const pending = f.gate.start(record(), launch);
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
    expect(launch).not.toHaveBeenCalled();
    await f.gate.reconcile(); await pending;
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it("does not inspect auxiliary reservations or reopen admission when their owner is missing", async () => {
    const f = await fixture();
    await f.admission.request({ requestId: "service", owner: { installationId: "test", workloadId: "service",
      familyId: "canonical-family", kind: "service", generation: 1 }, priority: "interactive",
      demand: { memoryBytes: 6 * GiB, cpuWeight: 100, pidLimit: 32, profileId: "service", profileVersion: "1" } });
    expect(await f.gate.reconcileOwned()).toBe(true);
    await expect(f.gate.reconcile()).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(f.admission.health()).toMatchObject({ hold: "reconciliation", reservedBytes: 6 * GiB });
    expect(f.bindings.list()).toEqual([]);
  });
  it("keeps startup admission closed when release of a proven prelaunch binding fails", async () => {
    const f = await fixture();
    const req = { requestId: "unreleased", owner: { installationId: "test", workloadId: "worker",
      familyId: "canonical-family", kind: "worker" as const, generation: 1 }, priority: "interactive" as const,
      demand: { memoryBytes: 6 * GiB, cpuWeight: 100, pidLimit: 32, profileId: "synthetic", profileVersion: "1" } };
    await f.bindings.put({ request: req, phase: "reserved", identities: [] });
    await f.admission.request(req); await f.store.close();
    const restored = await fixture(f.path, false);
    vi.spyOn(restored.admission, "release").mockRejectedValue(new Error("durable release failed"));
    await expect(restored.gate.reconcile()).rejects.toThrow("durable release failed");
    expect(restored.admission.health()).toMatchObject({ hold: "reconciliation", reservedBytes: 6 * GiB });
  });
  it("rechecks canonical family after waiting and releases before preparation on a handoff", async () => {
    const f = await fixture(), launch = vi.fn(async () => runtime().value);
    f.resolveFamily.mockReturnValueOnce("previous-family").mockReturnValue("new-family");
    await expect(f.gate.start(record(), launch)).rejects.toThrow("RESOURCE_CANONICAL_FAMILY_CHANGED");
    expect(launch).not.toHaveBeenCalled(); expect(f.admission.health().reservedBytes).toBe(0);
  });
  it("reserves before launch, queues visibly, cancels without spawning and never frees a live tree", async () => {
    const f = await fixture(), first = runtime(), launch = vi.fn(async () => {
      expect(f.gate.demand("worker", 1)?.memoryBytes).toBe(6 * GiB);
      expect(f.bindings.list()[0]?.phase).toBe("launching"); return first.value;
    });
    await f.gate.start(record(), launch);
    const secondLaunch = vi.fn(async () => runtime().value);
    const queued = f.gate.start(record("second"), secondLaunch);
    const rejected = expect(queued).rejects.toThrow();
    await vi.waitFor(() => expect(f.admission.health().queue).toHaveLength(1));
    expect(f.admission.health().queue[0]?.familyId).toBe("canonical-family");
    expect(f.gate.cancelStart("second")).toBe(true); await rejected;
    expect(secondLaunch).not.toHaveBeenCalled();
    first.exit();
    const id = f.bindings.list()[0]!.request.requestId;
    await expect(f.gate.release(id)).rejects.toThrow("TERMINATION_UNCONFIRMED");
    expect(f.admission.health().reservedBytes).toBe(6 * GiB);
    f.inspect({ state: "terminated", inventoryComplete: false, identities: [] });
    await expect(f.gate.release(id)).rejects.toThrow("TERMINATION_UNCONFIRMED");
    f.inspect({ state: "terminated", inventoryComplete: true, identities: [] });
    await f.gate.release(id); await f.gate.release(id);
    expect(f.admission.health().reservedBytes).toBe(0);
  });
  it("releases admitted cancellation before any preparation side effect", async () => {
    const f = await fixture();
    const put = f.bindings.put.bind(f.bindings);
    const save = vi.spyOn(f.bindings, "put").mockImplementation(async binding => {
      await put(binding); if (binding.phase === "reserved") f.gate.cancelStart("worker");
    });
    const launch = vi.fn(async () => runtime().value);
    await expect(f.gate.start(record(), launch)).rejects.toThrow("CANCELLED");
    expect(launch).not.toHaveBeenCalled();
    expect(f.admission.health().reservedBytes).toBe(0);
    expect(f.store.read().entries[0]?.terminationKind).toBe("never-launched");
    save.mockRestore(); await f.store.close();
    const restored = await fixture(f.path);
    await restored.gate.start(record(), launch); expect(launch).toHaveBeenCalledTimes(1);
  });
  it("retains crash-after-spawn uncertainty across real durable reopen", async () => {
    const f = await fixture(); f.capture.mockRejectedValue(new Error("crash before binding"));
    f.inspect({ state: "unknown", inventoryComplete: false, identities: [] });
    const child = runtime();
    await expect(f.gate.start(record(), async () => child.value)).rejects.toThrow("crash before binding");
    expect(child.value.kill).toHaveBeenCalledWith("SIGTERM");
    expect(f.bindings.list()[0]?.phase).toBe("launching");
    await f.store.close();
    const restored = await fixture(f.path, false);
    restored.inspect({ state: "unknown", inventoryComplete: false, identities: [] });
    await expect(restored.gate.reconcile()).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(restored.admission.health()).toMatchObject({ hold: "reconciliation", reservedBytes: 6 * GiB });
    // Authoritative recovery can discover a surviving child and bind its precise birth identity.
    restored.inspect({ state: "running", inventoryComplete: true,
      identities: [{ kind: "native", pid: 43, startTime: "libproc:1234.000002" }] });
    await restored.gate.reconcile();
    expect(restored.bindings.list()[0]?.identities[0]).toMatchObject({ pid: 43, startTime: "libproc:1234.000002" });
    expect(restored.admission.health().reservedBytes).toBe(6 * GiB);
  });
  it("recovers crash-after-reserve without inventing a launched process", async () => {
    const f = await fixture();
    const req = { requestId: "crash-before-launch", owner: { installationId: "test", workloadId: "worker",
      familyId: "canonical-family", kind: "worker" as const, generation: 1 }, priority: "interactive" as const,
      demand: { memoryBytes: 6 * GiB, cpuWeight: 100, pidLimit: 32, profileId: "synthetic", profileVersion: "1" } };
    await f.bindings.put({ request: req, phase: "queued", identities: [] });
    await f.admission.request(req); await f.store.close();
    const restored = await fixture(f.path, false); await restored.gate.reconcile();
    expect(restored.admission.health().reservedBytes).toBe(0);
    expect(restored.bindings.get(req.requestId)?.phase).toBe("terminated");
  });
  it("fences generations and stale exit observers after resume", async () => {
    const f = await fixture(), first = runtime(); await f.gate.start(record(), async () => first.value);
    const old = f.bindings.list()[0]!;
    await expect(f.gate.start(record("worker", 2), async () => runtime().value)).rejects.toThrow("GENERATION_CONFLICT");
    f.inspect({ state: "terminated", inventoryComplete: true, identities: [] }); await f.gate.release(old.request.requestId);
    f.inspect({ state: "running", inventoryComplete: true,
      identities: [{ kind: "native", pid: 42, startTime: "libproc:1234.000003" }] });
    await f.gate.start(record("worker", 2), async () => runtime().value);
    first.exit(); await f.gate.release(old.request.requestId);
    expect(f.gate.demand("worker", 2)?.memoryBytes).toBe(6 * GiB);
    expect(f.gate.demand("worker", 1)).toBeUndefined();
    const active = f.admission.health().reservations[0]!;
    await expect(f.admission.release({ reservationId: active.reservationId,
      terminationEvidenceId: old.request.requestId })).rejects.toThrow("TERMINATION_UNCONFIRMED");
    expect(await readFile(join(f.path, "resource-runtimes.json"), "utf8")).toContain("libproc:1234.000003");
  });
});
