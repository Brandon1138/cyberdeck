import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import type { BrokerRuntimeConfig } from "../../../src/config.js";
import type { brokerResourceRuntime } from "../../../src/runtime/resources/broker-resource-runtime.js";
import { brokerAuxiliaryRuntime } from "../../../src/runtime/resources/broker-auxiliary-runtime.js";
import { AgentActivityStore } from "../../../src/persistence/agent-activity-store.js";
import { realAuxiliaryAdmission } from "../execution/auxiliary-admission-fixture.js";
import { nativeManifestHash } from "../../../src/runtime/execution/native-tool-workspace.js";
import { workspaceManifest } from "../../../src/runtime/execution/workspace-manifest.js";
import type { ResourceReservation } from "../../../src/domain/resource-budget.js";

const child = vi.hoisted(() => ({ run: vi.fn(async () => { throw new Error("NO_NATIVE_PROCESS_AUTHORIZED_BY_TEST"); }) }));
vi.mock("../../../src/runtime/execution/native-process-supervisor.js", () => ({ MacosNativeProcessSupervisor: class { run = child.run; } }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); vi.restoreAllMocks(); child.run.mockClear(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "auxiliary-recovery-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source"); await mkdir(source); await writeFile(join(source, "input.swift"), "trusted source");
  const installationId = randomUUID(), workerId = randomUUID(), identity = { brokerId: randomUUID(), workerId, sessionId: workerId, executionId: randomUUID(), generation: 1 };
  const binding = { workerId, executionId: identity.executionId, generation: 1 };
  const request = { requestId: randomUUID(), attemptId: workerId, profile: "native" as const, recipeId: "fixture" };
  const verifiers = new Map<string, (reservation: ResourceReservation, evidence: string) => Promise<boolean>>();
  const recovery = new Map<string, (reservation: ResourceReservation) => Promise<boolean>>();
  const real = await realAuxiliaryAdmission(directory, installationId, async (reservation, evidence) => verifiers.get(reservation.request.demand.profileId)?.(reservation, evidence) ?? false);
  cleanup.unshift(() => real.store.close()); real.control.available = false;
  const activity = await AgentActivityStore.open(join(directory, "activity")); cleanup.unshift(() => activity.close());
  const recipe = { id: "fixture", inputManifestSha256: nativeManifestHash(await workspaceManifest(source)), project: "Fixture.xcodeproj", scheme: "Fixture",
    developerDirectory: "/Applications/Xcode.app/Contents/Developer", simulatorRuntime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    simulatorDeviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", action: "test", timeoutMs: 1000, maxInputBytes: 1024, maxArtifactBytes: 1024 ** 2,
    demand: { memoryBytes: 1024 ** 3, cpuWeight: 100, pidLimit: 100, profileId: "native-fixture", profileVersion: "1" } };
  const config = { resourceManagement: { directory, installationId, nativeHelper: "/unused", auxiliaryProfiles: { nativeRecipes: [recipe] } } } as unknown as BrokerRuntimeConfig;
  const resource = { admission: real.admission, bindings: real.bindings, assertOwner: () => real.store.assertOwner(),
    registerVerifier: (id: string, verifier: (reservation: ResourceReservation, evidence: string) => Promise<boolean>) => verifiers.set(id, verifier),
    registerRecovery: (id: string, checker: (reservation: ResourceReservation) => Promise<boolean>) => recovery.set(id, checker),
  } as unknown as NonNullable<Awaited<ReturnType<typeof brokerResourceRuntime>>>;
  let stale = false, sweep!: () => void;
  const authorize = vi.fn(async () => { if (stale) throw new Error("AUXILIARY_LEASE_STALE"); return { identity, leaseVersion: 1, familyId: "canonical-family", writeAllowed: true, workspaceRoot: source }; });
  const open = async () => {
    const original = globalThis.setInterval;
    const timer = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => { sweep = fn; return original(fn, ms); }) as typeof setInterval);
    try { const runtime = await brokerAuxiliaryRuntime({ config, resource, activity, authorize }); cleanup.unshift(() => runtime.close()); return runtime; }
    finally { timer.mockRestore(); }
  };
  return { directory, real, request, binding, activity, authorize, open, recovery, revoke: () => { stale = true; }, sweep: () => sweep() };
}

test.each([false, true])("stale authority retires actual auxiliary admission, refresh already admitted=%s", async admitted => {
  const f = await fixture(), runtime = await f.open(); await runtime.request(f.binding, f.request);
  await vi.waitFor(() => expect(runtime.health().waiting).toBe(1));
  if (admitted) { f.real.control.available = true; await f.real.admission.refresh(); expect(f.real.admission.health().reservedBytes).toBe(1024 ** 3); }
  f.revoke(); f.sweep();
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ active: 0, cleanupPending: 0, waiting: 0 }));
  expect(f.real.admission.health()).toMatchObject({ reservedBytes: 0, queue: [] }); expect(child.run).not.toHaveBeenCalled();
  const saved = JSON.parse(await readFile(join(f.directory, "auxiliary-requests.json"), "utf8"));
  expect(saved[0]).toMatchObject({ state: "finished", cleanupPending: false, terminal: { outcome: "unknown" } });
});

test.each(["queued", "auto-admitted", "reserved", "running-receipt"])("startup preserves legitimate %s native work and its exact ledger identity", async phase => {
  const f = await fixture(), runtime = await f.open(); await runtime.request(f.binding, f.request);
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ waiting: 1, active: 0 })); await runtime.close();
  if (phase !== "queued") { f.real.control.available = true; await f.real.admission.refresh(); }
  if (phase === "reserved") await f.real.bindings.put({ ...f.real.bindings.get(`native-${f.request.requestId}`)!, phase: "reserved" });
  if (phase === "running-receipt") {
    const path = join(f.directory, "auxiliary-requests.json"), records = JSON.parse(await readFile(path, "utf8"));
    records[0].state = "running"; records[0].cleanupPending = true; await writeFile(path, JSON.stringify(records));
  }
  const before = f.real.store.read(), reopened = await f.open();
  expect(f.real.store.read()).toEqual(before); expect(child.run).not.toHaveBeenCalled();
  expect(reopened.health()).toMatchObject({ active: 0, waiting: 1, cleanupPending: 0, recovery: { inventoryReady: true } });
  const checker = f.recovery.get("native-fixture")!;
  expect(await checker(before.entries[0]!)).toBe(true);
  await f.real.admission.reconcile(async held => (await Promise.all(held.map(checker))).every(Boolean));
  expect(f.real.store.read()).toEqual(before); expect(await f.activity.read(f.request.requestId, 0, 10)).toHaveLength(0);
  const record = JSON.parse(await readFile(join(f.directory, "auxiliary-requests.json"), "utf8"))[0];
  expect(record.terminal).toBeUndefined(); expect(record.state).toBe("waiting-capacity");
});

test("unavailable canonical authority holds recovery without retiring the pending request", async () => {
  const f = await fixture(), runtime = await f.open(); await runtime.request(f.binding, f.request);
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ waiting: 1, active: 0 })); await runtime.close();
  f.real.control.available = true; await f.real.admission.refresh();
  const before = f.real.store.read(), authority = await f.authorize();
  f.authorize.mockRejectedValue(new Error("registry temporarily unavailable"));
  const reopened = await f.open();
  expect(await reopened.recoveryReady(before.entries[0]!)).toBe(false);
  expect(reopened.health().recovery).toMatchObject({ inventoryReady: true, held: 1 });
  expect(f.real.store.read()).toEqual(before); expect(await f.activity.read(f.request.requestId, 0, 10)).toHaveLength(0);
  f.authorize.mockResolvedValue(authority);
  expect(await reopened.recoveryReady(before.entries[0]!)).toBe(true);
  expect(f.real.store.read()).toEqual(before); expect(child.run).not.toHaveBeenCalled();
});

test("unknown native launch lifetime remains an owner recovery hold", async () => {
  const f = await fixture(), runtime = await f.open(); await runtime.request(f.binding, f.request);
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ waiting: 1, active: 0 })); await runtime.close();
  f.real.control.available = true; await f.real.admission.refresh();
  const key = `native-${f.request.requestId}`;
  await f.real.bindings.put({ ...f.real.bindings.get(key)!, phase: "launching" });
  const before = f.real.store.read(), reopened = await f.open();
  expect(await reopened.recoveryReady(before.entries[0]!)).toBe(false);
  expect(reopened.health()).toMatchObject({ cleanupPending: 1, recovery: { inventoryReady: true, held: 1 } });
  expect(f.real.store.read()).toEqual(before); expect(child.run).not.toHaveBeenCalled();
});

test("transient authority failure inside a queued executor does not retire its immutable request", async () => {
  const f = await fixture(), runtime = await f.open(); await runtime.request(f.binding, f.request);
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ waiting: 1, active: 0 }));
  const before = f.real.store.read(), authority = await f.authorize(); let calls = 0;
  f.authorize.mockImplementation(async () => { if (++calls === 2) throw new Error("authority storage unavailable"); return authority; });
  f.sweep(); await vi.waitFor(async () => {
    const record = JSON.parse(await readFile(join(f.directory, "auxiliary-requests.json"), "utf8"))[0];
    expect(record).toMatchObject({ state: "queued", reason: "auxiliary-operation-unavailable", cleanupPending: false });
  });
  expect(f.real.store.read()).toEqual(before); expect(child.run).not.toHaveBeenCalled();
  expect(await f.activity.read(f.request.requestId, 0, 10)).toHaveLength(0);
});

test.each([false, true])("startup selectively retires explicitly revoked authority, auto-admitted=%s", async admitted => {
  const f = await fixture(), runtime = await f.open(); await runtime.request(f.binding, f.request);
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ waiting: 1, active: 0 })); await runtime.close();
  if (admitted) { f.real.control.available = true; await f.real.admission.refresh(); }
  f.revoke(); const reopened = await f.open();
  expect(reopened.health()).toMatchObject({ waiting: 0, cleanupPending: 0 });
  expect(f.real.admission.health()).toMatchObject({ reservedBytes: 0, queue: [] }); expect(child.run).not.toHaveBeenCalled();
  expect(await f.activity.read(f.request.requestId, 0, 10)).toHaveLength(1);
});

test("terminal projection failure retains durable retirement debt and restart cleans it without stale authority", async () => {
  const f = await fixture(), runtime = await f.open(); await runtime.request(f.binding, f.request);
  await vi.waitFor(() => expect(runtime.health().waiting).toBe(1));
  f.real.control.available = true; await f.real.admission.refresh(); f.revoke();
  const release = vi.spyOn(f.real.admission, "release").mockRejectedValue(new Error("ledger unavailable"));
  const append = vi.spyOn(f.activity, "append").mockImplementation(async () => {
    const saved = JSON.parse(await readFile(join(f.directory, "auxiliary-requests.json"), "utf8"));
    expect(saved[0]).toMatchObject({ cleanupPending: true, state: "finished" });
    throw new Error("projection failed after durable terminal");
  });
  f.sweep(); await vi.waitFor(() => expect(runtime.admissionHold()).toBe("auxiliary-capture-gap"));
  expect(f.real.admission.health().reservedBytes).toBe(1024 ** 3);
  const original = JSON.parse(await readFile(join(f.directory, "auxiliary-requests.json"), "utf8"))[0].terminal;
  await runtime.close(); release.mockRestore(); append.mockRestore();
  const authorityCalls = f.authorize.mock.calls.length, reopened = await f.open();
  expect(reopened.health().cleanupPending).toBe(0); expect(f.real.admission.health()).toMatchObject({ reservedBytes: 0, queue: [] });
  expect(f.authorize).toHaveBeenCalledTimes(authorityCalls); expect(child.run).not.toHaveBeenCalled();
  const saved = JSON.parse(await readFile(join(f.directory, "auxiliary-requests.json"), "utf8"))[0];
  expect(saved.terminal).toEqual(original); expect(await f.activity.read(f.request.requestId, 0, 10)).toHaveLength(1);
});
