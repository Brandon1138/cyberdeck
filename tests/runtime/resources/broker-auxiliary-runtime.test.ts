import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { BrokerRuntimeConfig } from "../../../src/config.js";
import type { brokerResourceRuntime } from "../../../src/runtime/resources/broker-resource-runtime.js";
import { AgentActivityStore } from "../../../src/persistence/agent-activity-store.js";
const mocks = vi.hoisted(() => ({ run: vi.fn(), recover: vi.fn(async () => []), verify: vi.fn(async () => true), cleanup: vi.fn(async () => ({ cleanupComplete: true })) }));
vi.mock("../../../src/runtime/execution/integration-service-executor.js", () => ({ IntegrationServiceExecutor: class {
  run = mocks.run; reconcileAll = mocks.recover; verifyTermination = mocks.verify; cancelPending = mocks.cleanup;
} }));
vi.mock("../../../src/runtime/execution/native-tool-executor.js", () => ({ NativeToolExecutor: class { recover = mocks.cleanup; } }));
import { brokerAuxiliaryRuntime } from "../../../src/runtime/resources/broker-auxiliary-runtime.js";

const paths: string[] = [], runtimes: Awaited<ReturnType<typeof brokerAuxiliaryRuntime>>[] = [], stores: AgentActivityStore[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); for (const store of stores.splice(0)) await store.close();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); vi.clearAllMocks(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "auxiliary-runtime-")); paths.push(directory);
  const workerId = randomUUID(), identity = { brokerId: randomUUID(), workerId, sessionId: workerId, executionId: randomUUID(), generation: 2 };
  const binding = { workerId, executionId: identity.executionId, generation: 2 };
  const request = { requestId: randomUUID(), attemptId: workerId, profile: "integration" as const, recipeId: "postgres-fixture-v1" };
  const activity = await AgentActivityStore.open(join(directory, "activity")); stores.push(activity);
  const resource = { assertOwner: vi.fn(), registerVerifier: vi.fn(), admission: {}, bindings: {} } as unknown as NonNullable<Awaited<ReturnType<typeof brokerResourceRuntime>>>;
  const config = { resourceManagement: { directory, installationId: randomUUID(), nativeHelper: "/unused",
    auxiliaryProfiles: { nativeRecipes: [], integrationImage: `sha256:${"a".repeat(64)}` } }, containerRuntime: { endpoint: "unix:///unused" } } as unknown as BrokerRuntimeConfig;
  const authorize = vi.fn(async () => ({ identity, leaseVersion: 3, familyId: "canonical-family", workspaceRoot: directory, writeAllowed: true }));
  const open = async () => { const runtime = await brokerAuxiliaryRuntime({ config, resource, activity, authorize }); runtimes.push(runtime); return runtime; };
  return { directory, request, binding, activity, resource, authorize, open };
}
test("persists receipt before work, retains a capacity wait, and refuses identity collisions", async () => {
  mocks.run.mockResolvedValue({ state: "waiting-capacity", reason: "observed-budget", queuedAt: new Date().toISOString() });
  const f = await fixture(), runtime = await f.open();
  expect(await runtime.request(f.binding, f.request)).toMatchObject({ state: "queued" });
  await vi.waitFor(() => expect(runtime.health().waiting).toBe(1));
  const persisted = JSON.parse(await readFile(join(f.directory, "auxiliary-requests.json"), "utf8"));
  expect(persisted[0]).toMatchObject({ state: "waiting-capacity", leaseVersion: 3, familyId: "canonical-family" });
  expect(JSON.stringify(persisted)).not.toContain("leaseToken");
  await expect(runtime.request({ ...f.binding, generation: 3 }, f.request)).rejects.toThrow("AUXILIARY_REQUEST_CONFLICT");
  await expect(runtime.request(f.binding, { ...f.request, attemptId: randomUUID() })).rejects.toThrow("AUXILIARY_REQUEST_CONFLICT");
});
test("two concurrent request-id owners cannot overwrite the persisted authority", async () => {
  mocks.run.mockResolvedValue({ state: "waiting-capacity", reason: "observed-budget", queuedAt: new Date().toISOString() });
  const f = await fixture(), runtime = await f.open();
  const outcomes = await Promise.allSettled([runtime.request(f.binding, f.request), runtime.request(f.binding, { ...f.request, attemptId: randomUUID() })]);
  expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(r => r.status === "rejected")).toHaveLength(1);
});
test("terminal-before-projection crash replays the exact receipt without repeating the service", async () => {
  mocks.run.mockResolvedValue({ state: "completed", outcome: "verified-pass", manifestRef: "private-evidence", cleanupComplete: true });
  const f = await fixture(), runtime = await f.open();
  vi.spyOn(f.activity, "append").mockRejectedValueOnce(new Error("capture unavailable"));
  await runtime.request(f.binding, f.request);
  await vi.waitFor(() => expect(runtime.admissionHold()).toBe("auxiliary-capture-gap"));
  await runtime.close(); runtimes.splice(runtimes.indexOf(runtime), 1);
  const reopened = await f.open();
  expect(reopened.admissionHold()).toBeNull();
  expect(await reopened.request(f.binding, f.request)).toMatchObject({ state: "finished", outcome: "succeeded", artifactRef: `profile:${f.request.requestId}` });
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(await f.activity.read(f.request.requestId, 0, 10)).toMatchObject([{ kind: "profile.settled", generation: 2, causationId: f.request.attemptId }]);
});
test("periodic cleanup retries are bounded and preserve verified terminal results without rerunning the profile", async () => {
  mocks.run.mockResolvedValue({ state: "completed", outcome: "verified-pass", manifestRef: "private-evidence", cleanupComplete: false });
  mocks.cleanup.mockResolvedValue({ cleanupComplete: true });
  const f = await fixture(), timer = vi.spyOn(globalThis, "setInterval"), runtime = await f.open();
  const sweep = timer.mock.calls.at(-1)![0] as () => void; timer.mockRestore();
  const requests = [f.request, { ...f.request, requestId: randomUUID() }, { ...f.request, requestId: randomUUID() }];
  for (const request of requests) await runtime.request(f.binding, request);
  await vi.waitFor(() => expect(runtime.health()).toMatchObject({ active: 0, cleanupPending: 3 }));
  const before = JSON.parse(await readFile(join(f.directory, "auxiliary-requests.json"), "utf8"));
  f.authorize.mockRejectedValue(new Error("authority revoked after completion"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
  try {
    sweep(); await vi.waitFor(() => expect(runtime.health()).toMatchObject({ cleanupPending: 1, cleanupRetries: 2 }));
    expect(mocks.cleanup).toHaveBeenCalledTimes(2);
    sweep(); await vi.waitFor(() => expect(runtime.health()).toMatchObject({ cleanupPending: 0, cleanupRetries: 3 }));
    expect(mocks.run).toHaveBeenCalledTimes(3);
    const after = JSON.parse(await readFile(join(f.directory, "auxiliary-requests.json"), "utf8"));
    expect(after.map((r: any) => ({ terminal: r.terminal, result: r.result }))).toEqual(before.map((r: any) => ({ terminal: r.terminal, result: r.result })));
    expect(after.every((r: any) => r.terminal.outcome === "succeeded")).toBe(true);
  } finally { clock.mockRestore(); }
});
test("failed selective cleanup backs off before retrying and never changes task outcome", async () => {
  mocks.run.mockResolvedValue({ state: "completed", outcome: "verified-fail", manifestRef: "private-evidence", cleanupComplete: false });
  mocks.cleanup.mockResolvedValueOnce({ cleanupComplete: false }).mockResolvedValue({ cleanupComplete: true });
  const f = await fixture(), timer = vi.spyOn(globalThis, "setInterval"), runtime = await f.open();
  const sweep = timer.mock.calls.at(-1)![0] as () => void; timer.mockRestore();
  await runtime.request(f.binding, f.request); await vi.waitFor(() => expect(runtime.health()).toMatchObject({ active: 0, cleanupPending: 1 }));
  const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now + 5000);
  try {
    sweep(); await vi.waitFor(() => expect(runtime.health().cleanupRetries).toBe(1));
    await vi.waitFor(() => expect(mocks.cleanup).toHaveBeenCalledTimes(1));
    sweep(); await new Promise(resolve => setTimeout(resolve, 20)); expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 10000); sweep(); await vi.waitFor(() => expect(runtime.health().cleanupPending).toBe(0));
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(await f.activity.read(f.request.requestId, 0, 10)).toMatchObject([{ outcome: "failed" }]);
  } finally { clock.mockRestore(); }
});
