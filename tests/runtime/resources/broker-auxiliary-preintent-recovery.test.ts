import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { BrokerRuntimeConfig } from "../../../src/config.js";
import type { brokerResourceRuntime } from "../../../src/runtime/resources/broker-resource-runtime.js";
import type { ResourceReservation } from "../../../src/domain/resource-budget.js";
import { brokerAuxiliaryRuntime } from "../../../src/runtime/resources/broker-auxiliary-runtime.js";
import { integrationNames } from "../../../src/runtime/execution/integration-service-recipe.js";
import { AgentActivityStore } from "../../../src/persistence/agent-activity-store.js";
import { realAuxiliaryAdmission } from "../execution/auxiliary-admission-fixture.js";
import { nativeManifestHash } from "../../../src/runtime/execution/native-tool-workspace.js";
import { workspaceManifest } from "../../../src/runtime/execution/workspace-manifest.js";
import type { NativeProcessSupervisor } from "../../../src/runtime/execution/native-tool-types.js";

const fault = vi.hoisted(() => ({ path: "", paths: [] as string[], reads: 0 }));
const processes = vi.hoisted(() => ({ engine: vi.fn(async () => { throw new Error("NO_ENGINE_COMMAND_AUTHORIZED_BY_TEST"); }), native: vi.fn() }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === fault.path || fault.paths.includes(String(args[0]))) {
      fault.reads++; throw Object.assign(new Error("temporary private read failure"), { code: "EACCES" });
    }
    return fs.readFile(...args);
  } };
});
vi.mock("../../../src/runtime/execution/orbstack-client.js", () => ({ OrbStackClient: class { command = processes.engine; } }));
vi.mock("../../../src/runtime/execution/native-process-supervisor.js", () => ({ MacosNativeProcessSupervisor: class { run = processes.native; } }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  fault.path = ""; fault.paths = []; fault.reads = 0;
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks(); processes.engine.mockClear(); processes.native.mockReset();
});
async function fixture(profile: "integration" | "native" = "integration") {
  const directory = await mkdtemp(join(tmpdir(), "aux-preintent-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source"); await mkdir(source); await writeFile(join(source, "input.swift"), "trusted");
  const installationId = randomUUID(), workerId = randomUUID();
  const identity = { brokerId: randomUUID(), executionId: randomUUID(), workerId, sessionId: workerId, generation: 1 };
  const binding = { workerId, executionId: identity.executionId, generation: 1 };
  const request = { requestId: randomUUID(), attemptId: workerId, profile, recipeId: profile === "integration" ? "postgres-fixture-v1" : "native-fixture" };
  const verifiers = new Map<string, (reservation: ResourceReservation, evidence: string) => Promise<boolean>>();
  const real = await realAuxiliaryAdmission(directory, installationId, async (reservation, evidence) => verifiers.get(reservation.request.demand.profileId)?.(reservation, evidence) ?? false);
  cleanups.unshift(() => real.store.close()); real.control.available = false;
  const activity = await AgentActivityStore.open(join(directory, "activity")); cleanups.unshift(() => activity.close());
  const resource = { admission: real.admission, bindings: real.bindings, assertOwner: () => real.store.assertOwner(),
    registerRecovery: vi.fn(), registerVerifier: (id: string, verifier: (reservation: ResourceReservation, evidence: string) => Promise<boolean>) => verifiers.set(id, verifier),
  } as unknown as NonNullable<Awaited<ReturnType<typeof brokerResourceRuntime>>>;
  const recipe = { id: "native-fixture", inputManifestSha256: nativeManifestHash(await workspaceManifest(source)), project: "Fixture.xcodeproj", scheme: "Fixture",
    developerDirectory: "/Applications/Xcode.app/Contents/Developer", simulatorRuntime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    simulatorDeviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", action: "test", timeoutMs: 10000, maxInputBytes: 1024, maxArtifactBytes: 1024 ** 2,
    demand: { memoryBytes: 1024 ** 3, cpuWeight: 100, pidLimit: 100, profileId: "native-fixture", profileVersion: "1" } };
  const config = { resourceManagement: { directory, installationId, nativeHelper: "/unused", auxiliaryProfiles: {
    integrationImage: `sha256:${"a".repeat(64)}`, nativeRecipes: [recipe] } }, containerRuntime: { endpoint: "unix:///unused" } } as unknown as BrokerRuntimeConfig;
  const authority = { identity, leaseVersion: 1, familyId: "canonical-family", writeAllowed: true, workspaceRoot: source };
  const authorize = vi.fn(async () => authority);
  const saved = async () => JSON.parse(await readFile(join(directory, "auxiliary-requests.json"), "utf8")) as Array<Record<string, any>>;
  let tick!: () => void;
  const open = async () => {
    const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      tick = callback; return { unref() { return this; } } as NodeJS.Timeout;
    }) as typeof setInterval);
    try {
      const runtime = await brokerAuxiliaryRuntime({ config, resource, activity, authorize });
      cleanups.unshift(() => runtime.close()); return runtime;
    } finally { interval.mockRestore(); }
  };
  const integrationRequest = { identity, attemptId: request.requestId, leaseVersion: 1, recipe: "postgres-fixture-v1" as const };
  return { directory, real, activity, request, binding, authority, authorize, saved, open, integrationRequest, sweep: () => tick(),
    manifest: join(directory, "integration", `${integrationNames(integrationRequest).key}.json`) };
}

test("actual integration leaf retries second authorization failure before any manifest exists", async () => {
  const f = await fixture(); let calls = 0;
  f.authorize.mockImplementation(async () => { if (++calls === 3) throw new Error("transient authority failure"); return f.authority; });
  const runtime = await f.open(); await runtime.request(f.binding, f.request);
  await vi.waitFor(async () => expect((await f.saved())[0]).toMatchObject({ state: "queued", cleanupPending: false, reason: "auxiliary-operation-unavailable" }));
  await expect(readFile(f.manifest)).rejects.toMatchObject({ code: "ENOENT" });
  await vi.waitFor(() => expect(runtime.health().active).toBe(0)); expect(f.real.store.read().entries).toHaveLength(0);
  f.sweep(); await vi.waitFor(() => expect(runtime.health()).toMatchObject({ active: 0, waiting: 1 }));
  expect(f.real.store.read().entries).toHaveLength(1); expect((await f.saved())[0]!.terminal).toBeUndefined();
  expect(await f.activity.read(f.request.requestId, 0, 10)).toHaveLength(0); expect(processes.engine).not.toHaveBeenCalled();
});

test.each([false, true])("unreadable existing intent persists bounded recovery debt and resumes, restart=%s", async restart => {
  const f = await fixture(), runtime = await f.open(); await runtime.request(f.binding, f.request);
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ active: 0, waiting: 1 }));
  const before = f.real.store.read(); let calls = 0;
  f.authorize.mockImplementation(async () => { if (++calls === 2) throw new Error("transient authority failure"); return f.authority; });
  fault.path = f.manifest; f.sweep();
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ active: 0, recovery: { pending: 1, retries: 1 } }));
  expect((await f.saved())[0]).toMatchObject({ state: "running", cleanupPending: true, recoveryPending: true, recoveryAttempts: 1 });
  expect(runtime.admissionHold()).toBe("auxiliary-capture-gap"); expect(f.real.store.read()).toEqual(before);
  const originalReads = fault.reads;
  await runtime.request(f.binding, f.request); f.sweep();
  await new Promise(resolve => setTimeout(resolve, 10)); expect(fault.reads).toBe(originalReads);
  const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now + 2500);
  f.sweep(); await vi.waitFor(() => expect(runtime.health().recovery.retries).toBe(2));
  expect(fault.reads).toBe(originalReads + 1); expect((await f.saved())[0]!.recoveryAfter).toBe(now + 6500);
  fault.path = "";
  let recovered = runtime;
  if (restart) { await runtime.close(); recovered = await f.open(); }
  else { clock.mockReturnValue(now + 7000); f.sweep(); await vi.waitFor(() => expect(runtime.health().recovery.pending).toBe(0)); }
  expect(recovered.admissionHold()).toBeNull(); expect((await f.saved())[0]).toMatchObject({ state: "waiting-capacity", recoveryPending: false, cleanupPending: false });
  expect(f.real.store.read()).toEqual(before); expect(await f.activity.read(f.request.requestId, 0, 10)).toHaveLength(0);
  expect(processes.engine).not.toHaveBeenCalled();
});

test("normalized canonical lease expiry aborts an active native helper", async () => {
  const f = await fixture("native"); f.real.control.available = true;
  processes.native.mockImplementation((async (_command, context) => {
    await new Promise<void>(resolve => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
    return { exitCode: null, signal: "SIGTERM", cancelled: true, timedOut: false, reason: "cancelled", identities: [], cleanup: "unproven", uncertainty: [] };
  }) satisfies NativeProcessSupervisor["run"]);
  const runtime = await f.open(); await runtime.request(f.binding, f.request);
  await vi.waitFor(() => expect(processes.native).toHaveBeenCalledTimes(1));
  f.authorize.mockRejectedValue(new Error("AUXILIARY_LEASE_STALE", { cause: { code: "LEASE_EXPIRED" } })); f.sweep();
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ active: 0, cleanupPending: 1 }));
  expect(processes.native.mock.calls[0]![1].signal.aborted).toBe(true);
  expect((await f.saved())[0]).toMatchObject({ state: "finished", terminal: { outcome: "cancelled" } });
  expect(f.real.admission.health().reservedBytes).toBe(1024 ** 3); // Native lifetime remains unproven after abort.
});

test("recovery retries share the two-per-sweep bound and preserve all held requests", async () => {
  const f = await fixture(), runtime = await f.open();
  const requests = [f.request, { ...f.request, requestId: randomUUID() }, { ...f.request, requestId: randomUUID() }];
  for (const request of requests) await runtime.request(f.binding, request);
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ active: 0, waiting: 3 }));
  const before = f.real.store.read();
  fault.paths = requests.map(request => join(f.directory, "integration", `${integrationNames({ ...f.integrationRequest, attemptId: request.requestId }).key}.json`));
  let calls = 0;
  f.authorize.mockImplementation(async () => { if (++calls > 3) throw new Error("transient authority failure"); return f.authority; });
  f.sweep(); await vi.waitFor(() => expect(runtime.health()).toMatchObject({ active: 0, recovery: { pending: 3, retries: 3 } }));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2500);
  f.sweep(); await vi.waitFor(() => expect(runtime.health().recovery.retries).toBe(5));
  await vi.waitFor(() => expect(fault.reads).toBe(5));
  expect(f.real.store.read()).toEqual(before); expect(processes.engine).not.toHaveBeenCalled();
  expect((await f.saved()).every(record => !record.terminal && record.recoveryPending)).toBe(true);
  clock.mockRestore();
});

test("normalized canonical lease expiry retires queued native admission before any helper starts", async () => {
  const f = await fixture("native"), runtime = await f.open(); await runtime.request(f.binding, f.request);
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ active: 0, waiting: 1 }));
  f.real.control.available = true; await f.real.admission.refresh();
  f.authorize.mockRejectedValue(new Error("AUXILIARY_LEASE_STALE", { cause: { code: "LEASE_EXPIRED" } })); f.sweep();
  await vi.waitFor(async () => expect((await f.saved())[0]).toMatchObject({ state: "finished", cleanupPending: false }));
  expect(f.real.admission.health()).toMatchObject({ queue: [], reservedBytes: 0 }); expect(processes.native).not.toHaveBeenCalled();
});
