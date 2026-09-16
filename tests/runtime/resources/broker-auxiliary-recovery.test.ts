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
  const real = await realAuxiliaryAdmission(directory, installationId, async (reservation, evidence) => verifiers.get(reservation.request.demand.profileId)?.(reservation, evidence) ?? false);
  cleanup.unshift(() => real.store.close()); real.control.available = false;
  const activity = await AgentActivityStore.open(join(directory, "activity")); cleanup.unshift(() => activity.close());
  const recipe = { id: "fixture", inputManifestSha256: nativeManifestHash(await workspaceManifest(source)), project: "Fixture.xcodeproj", scheme: "Fixture",
    developerDirectory: "/Applications/Xcode.app/Contents/Developer", simulatorRuntime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    simulatorDeviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", action: "test", timeoutMs: 1000, maxInputBytes: 1024, maxArtifactBytes: 1024 ** 2,
    demand: { memoryBytes: 1024 ** 3, cpuWeight: 100, pidLimit: 100, profileId: "native-fixture", profileVersion: "1" } };
  const config = { resourceManagement: { directory, installationId, nativeHelper: "/unused", auxiliaryProfiles: { nativeRecipes: [recipe] } } } as unknown as BrokerRuntimeConfig;
  const resource = { admission: real.admission, bindings: real.bindings, assertOwner: () => real.store.assertOwner(),
    registerVerifier: (id: string, verifier: (reservation: ResourceReservation, evidence: string) => Promise<boolean>) => verifiers.set(id, verifier) } as unknown as NonNullable<Awaited<ReturnType<typeof brokerResourceRuntime>>>;
  let stale = false, sweep!: () => void;
  const authorize = vi.fn(async () => { if (stale) throw new Error("STALE_AUTHORITY"); return { identity, leaseVersion: 1, familyId: "canonical-family", writeAllowed: true, workspaceRoot: source }; });
  const open = async () => {
    const original = globalThis.setInterval;
    const timer = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => { sweep = fn; return original(fn, ms); }) as typeof setInterval);
    try { const runtime = await brokerAuxiliaryRuntime({ config, resource, activity, authorize }); cleanup.unshift(() => runtime.close()); return runtime; }
    finally { timer.mockRestore(); }
  };
  return { directory, real, request, binding, activity, authorize, open, revoke: () => { stale = true; }, sweep: () => sweep() };
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
