import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { composeStrigoiRuntime } from "../../src/broker/strigoi-runtime.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { StartSessionRequestSchema, type SessionRecord } from "../../src/domain/session.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import { StrigoiAdmission } from "../../src/orchestration/strigoi-admission.js";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import type { ProviderLaunchSpec } from "../../src/providers/provider.js";

const roots: string[] = [], cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function gate() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function fixture(stage?: "prepare" | "initialize") {
  const root = await mkdtemp(join(tmpdir(), "strigoi-native-")); roots.push(root);
  const bindings = new OrchestratorStore(root), durable = new Map<string, SessionRecord>();
  const entered = gate(), release = gate(), writes = vi.fn(), inference = vi.fn();
  const adapter = new CodexProviderAdapter();
  const nativeBuild = vi.spyOn(adapter, "buildLaunchSpec");
  const wait = async (phase: typeof stage) => { if (phase === stage) { entered.resolve(); await release.promise; } };
  const spawn = vi.fn((spec: ProviderLaunchSpec): SessionRuntime => {
    const record = [...durable.values()].find((s) => s.executionState === "starting")!;
    expect(record).toMatchObject({ pid: 0, kind: "orchestrator", name: "Strigoi", generation: 1 });
    expect(spec.args).not.toContain("--");
    const exits = new Set<(code: number) => void>();
    return { pid: 123, write: writes, snapshot: () => Buffer.alloc(0), resize: () => {},
      kill: () => { for (const exit of exits) exit(0); }, onOutput: () => () => {},
      onExit: (cb) => { exits.add(cb); return () => { exits.delete(cb); }; } };
  });
  const registry = new SessionRegistry({
    adapters: { codex: { id: "codex", buildLaunchSpec: (r, p) => adapter.buildLaunchSpec(r, p), buildResumeSpec: () => { throw new Error("unexpected resume"); },
      prepareLaunch: async () => wait("prepare"), initializeSession: async () => wait("initialize"), submitInput: inference } },
    sessionRuntimeFactory: spawn, journal: { append: async () => {} }, workerTurnObservation: new WorkerTurnObservationAdapter(),
    store: { put: async (r) => { durable.set(r.id, structuredClone(r)); }, delete: async (id) => { durable.delete(id); } },
    config: BrokerRuntimeConfigSchema.parse({}),
  });
  await registry.ready();
  const manager = new OrchestratorManager(registry, bindings, undefined, { list: async () => ({ codex: "automatic" }) }, async () => []);
  const admission = new StrigoiAdmission(bindings.strigoi, bindings, registry), errors = vi.fn();
  const composition = await composeStrigoiRuntime({ repository: bindings.strigoi, bindings, registry, manager, admission, onError: errors });
  const resident = composition.lifecycle;
  cleanups.push(async () => { release.resolve(); composition.dispose(); await resident.reconcile(); await registry.stopAll(); });
  const selection = { provider: "codex" as const, model: "gpt-5.6-sol", cwd: root };
  return { root, selection, registry, bindings, admission, composition, resident, entered, release, durable, spawn, writes, inference, nativeBuild, errors };
}

describe("resident lifecycle through real registry and canonical binding authority", () => {
  it("stays disabled by default and starts asynchronously after core recovery", async () => {
    const f = await fixture("prepare"); f.composition.start(); await f.resident.reconcile();
    expect(f.spawn).not.toHaveBeenCalled();
    await f.resident.configure(f.selection, "configure");
    // start is deliberately synchronous: a missing provider cannot delay socket availability.
    expect(f.composition.start()).toBeUndefined(); await f.entered.promise;
    expect(f.registry.list()).toEqual([]); expect(f.spawn).not.toHaveBeenCalled();
    f.release.resolve(); await f.resident.reconcile(); expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("persists identity before one passive spawn and composes regular permission/native guidance", async () => {
    const f = await fixture(); await f.resident.configure(f.selection, "configure");
    await f.resident.reconcile(); await f.resident.reconcile();
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.writes).not.toHaveBeenCalled(); expect(f.inference).not.toHaveBeenCalled();
    expect(f.nativeBuild.mock.calls[0]![1]).toBeUndefined();
    expect(f.spawn.mock.calls[0]![0].args).toContain("--approve-for-me");
    const state = await f.bindings.strigoi.read();
    expect(state.activeGeneration).toBe(1); expect(state.transition?.successor?.sessionId).toBe(state.activeBinding?.sessionId);
    await expect(f.admission.run(state.activeBinding!.sessionId, "mutate", async () => "allowed")).resolves.toBe("allowed");
  });
  it.each(["prepare", "initialize"] as const)("suspends during %s and refuses late activation", async (stage) => {
    const f = await fixture(stage); await f.resident.configure(f.selection, "configure");
    const launch = f.resident.reconcile(); await f.entered.promise;
    await f.resident.setDesired("suspended", "suspend"); f.release.resolve(); await launch;
    const state = await f.bindings.strigoi.read();
    expect(state.desired).toBe("suspended"); expect(state.activeBinding).toBeUndefined();
    expect(f.spawn).toHaveBeenCalledTimes(stage === "prepare" ? 0 : 1);
    expect(f.registry.list().some((r) => r.exitCode === null && f.registry.ownsProcess(r.id))).toBe(false);
  });
  it("freezes and drains a permitted mutation before the suspension CAS", async () => {
    const f = await fixture(); await f.resident.configure(f.selection, "configure"); await f.resident.reconcile();
    const id = (await f.bindings.strigoi.read()).activeBinding!.sessionId, entered = gate(), finish = gate();
    const mutation = f.admission.run(id, "mutate", async () => { entered.resolve(); await finish.promise; });
    await entered.promise; const suspend = f.resident.setDesired("suspended", "suspend");
    // Reaching the closed barrier is observed directly, not inferred from elapsed time.
    await vi.waitFor(async () => { await expect(f.admission.run(id, "mutate", async () => {})).rejects.toMatchObject({ code: "STRIGOI_FROZEN" }); });
    expect((await f.bindings.strigoi.read()).desired).toBe("enabled");
    finish.resolve(); await mutation; await suspend;
    expect((await f.bindings.strigoi.read()).desired).toBe("suspended");
  });
  it("operator stop durably suspends; shutdown preserves enabled state", async () => {
    const f = await fixture(); await f.resident.configure(f.selection, "configure"); await f.resident.reconcile();
    await f.registry.stop((await f.bindings.strigoi.read()).activeBinding!.sessionId);
    expect((await f.bindings.strigoi.read()).desired).toBe("suspended");
    const other = await fixture(); await other.resident.configure(other.selection, "configure"); await other.resident.reconcile();
    other.composition.dispose(); await other.registry.stopAll();
    expect((await other.bindings.strigoi.read()).desired).toBe("enabled");
  });
  it("shutdown during initialization preserves desired state after the late result", async () => {
    const f = await fixture("initialize"); await f.resident.configure(f.selection, "configure");
    const launch = f.resident.reconcile(); await f.entered.promise; f.composition.dispose(); f.release.resolve(); await launch;
    expect((await f.bindings.strigoi.read()).desired).toBe("enabled");
    expect(f.registry.list().some((r) => r.exitCode === null && f.registry.ownsProcess(r.id))).toBe(false);
  });
  it("missing cwd is a permanent hold before provider preparation/spawn", async () => {
    const f = await fixture(); await f.resident.configure({ ...f.selection, cwd: join(f.root, "missing") }, "configure");
    await f.resident.reconcile(); expect(f.spawn).not.toHaveBeenCalled();
    expect((await f.bindings.strigoi.read()).hold?.code).toBe("INVALID_SESSION_CWD");
  });
  it("public input strips reservations and the internal reservation rejects mismatched ownership", async () => {
    const f = await fixture("prepare"); await f.resident.configure(f.selection, "configure");
    const pending = f.resident.reconcile(); await f.entered.promise;
    const state = await f.bindings.strigoi.read(), reservation = { sessionId: state.transition!.successor!.sessionId, transitionId: state.transition!.id };
    const request = StartSessionRequestSchema.parse({ ...f.selection, detached: true, sandbox: "workspace-write", launchReservation: reservation });
    expect(request).not.toHaveProperty("launchReservation");
    await expect(f.registry.start({ ...request, kind: "orchestrator" }, undefined, async () => {}, undefined, (apply) => apply(),
      { ...reservation, transitionId: "wrong" })).rejects.toMatchObject({ code: "STRIGOI_RESERVATION_UNAUTHORIZED" });
    await expect(f.registry.start({ ...request, kind: "orchestrator" }, undefined, async () => {}, undefined, (apply) => apply(), reservation)).rejects.toThrow("ALREADY_CLAIMED");
    f.release.resolve(); await pending; expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("public resume cannot bypass suspension", async () => {
    const f = await fixture(); await f.resident.configure(f.selection, "configure"); await f.resident.reconcile();
    const id = (await f.bindings.strigoi.read()).activeBinding!.sessionId;
    await f.registry.stop(id);
    await expect(f.registry.resume(id)).rejects.toMatchObject({ code: "STRIGOI_RESUME_REQUIRES_LIFECYCLE" });
    expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("a corrupt resident shard leaves the broker composition and ordinary stop usable", async () => {
    const f = await fixture(); await f.resident.configure(f.selection, "configure");
    await writeFile(f.bindings.strigoi.path, "corrupt\n");
    await expect(f.resident.beforeStop("ordinary-worker")).resolves.toBeUndefined();
    await expect(composeStrigoiRuntime({ repository: f.bindings.strigoi, bindings: f.bindings, registry: f.registry,
      manager: new OrchestratorManager(f.registry, f.bindings), admission: f.admission, onError: f.errors })).resolves.toBeDefined();
    expect(f.errors).toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  });
});
