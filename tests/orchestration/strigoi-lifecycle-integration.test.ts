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
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function gate() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function fixture(stage?: "prepare" | "initialize") {
  const root = await mkdtemp(join(tmpdir(), "strigoi-native-")); roots.push(root);
  const bindings = new OrchestratorStore(root), durable = new Map<string, SessionRecord>();
  const entered = gate(), release = gate(), writes = vi.fn(), inference = vi.fn();
  const adapter = new CodexProviderAdapter();
  const nativeBuild = vi.spyOn(adapter, "buildLaunchSpec");
  const wait = async (phase: typeof stage) => { if (phase === stage) { entered.resolve(); await release.promise; } };
  let reportExit = true, emitExit = () => {};
  const initialize = vi.fn(async () => wait("initialize"));
  const spawn = vi.fn((spec: ProviderLaunchSpec): SessionRuntime => {
    const record = [...durable.values()].find((s) => s.executionState === "starting")!;
    expect(record).toMatchObject({ pid: 0, kind: "orchestrator", name: "Strigoi", generation: 1 });
    expect(spec.args).not.toContain("--");
    const exits = new Set<(code: number) => void>();
    emitExit = () => { for (const exit of exits) exit(0); };
    return { pid: 123, write: writes, snapshot: () => Buffer.alloc(0), resize: () => {},
      kill: () => { if (reportExit) for (const exit of exits) exit(0); }, onOutput: () => () => {},
      onExit: (cb) => { exits.add(cb); return () => { exits.delete(cb); }; } };
  });
  const registryOptions = {
    adapters: { codex: { id: "codex", buildLaunchSpec: (r: SessionRecord, p?: string) => adapter.buildLaunchSpec(r, p), buildResumeSpec: () => { throw new Error("unexpected resume"); },
      prepareLaunch: async () => wait("prepare"), initializeSession: initialize, submitInput: inference } },
    sessionRuntimeFactory: spawn, journal: { append: async () => {} }, workerTurnObservation: new WorkerTurnObservationAdapter(),
    store: { put: async (r: SessionRecord) => { durable.set(r.id, structuredClone(r)); }, delete: async (id: string) => { durable.delete(id); } },
    config: BrokerRuntimeConfigSchema.parse({}),
  } satisfies ConstructorParameters<typeof SessionRegistry>[0];
  const registry = new SessionRegistry(registryOptions);
  await registry.ready();
  const manager = new OrchestratorManager(registry, bindings, undefined, { list: async () => ({ codex: "automatic" }) }, async () => []);
  const admission = new StrigoiAdmission(bindings.strigoi, bindings, registry), errors = vi.fn();
  const composition = await composeStrigoiRuntime({ repository: bindings.strigoi, bindings, registry, manager, admission, onError: errors });
  const resident = composition.lifecycle;
  const reconstruct = async (recoverRegistry = false) => {
    composition.dispose();
    const nextRegistry = recoverRegistry ? new SessionRegistry({ ...registryOptions, recoveredSessions: [...durable.values()] }) : registry;
    await nextRegistry.ready();
    const recoveredBindings = new OrchestratorStore(root);
    const next = await composeStrigoiRuntime({ repository: recoveredBindings.strigoi, bindings: recoveredBindings, registry: nextRegistry,
      manager: new OrchestratorManager(nextRegistry, recoveredBindings, undefined, { list: async () => ({ codex: "automatic" }) }, async () => []),
      admission: new StrigoiAdmission(recoveredBindings.strigoi, recoveredBindings, nextRegistry), onError: errors });
    cleanups.push(async () => { next.dispose(); await next.lifecycle.reconcile(); if (recoverRegistry) await nextRegistry.stopAll(); });
    return next.lifecycle;
  };
  cleanups.push(async () => { release.resolve(); composition.dispose(); await resident.reconcile(); await registry.stopAll(); });
  const selection = { provider: "codex" as const, model: "gpt-5.6-sol", cwd: root };
  return { reconstruct, initialize, emitExit: () => emitExit(), setReportExit: (value: boolean) => { reportExit = value; }, root, selection, registry, bindings, admission, composition, resident, entered, release, durable, spawn, writes, inference, nativeBuild, errors };
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
  it("settles cancellation during preparation durably while suspended, then reconstructs and resumes", async () => {
    const f = await fixture("prepare"); await f.resident.configure(f.selection, "configure");
    const launch = f.resident.reconcile(); await f.entered.promise;
    const old = (await f.bindings.strigoi.read()).transition!.successor!.sessionId;
    await f.resident.setDesired("suspended", "suspend"); f.release.resolve(); await launch;
    expect(await f.bindings.strigoi.read()).toMatchObject({ desired: "suspended", transition: { phase: "requested", attempts: 1 } });
    expect((await f.bindings.strigoi.read()).transition?.successor).toBeUndefined();
    expect(f.spawn).not.toHaveBeenCalled();
    const restarted = await f.reconstruct(true); await restarted.reconcile(); expect(f.spawn).not.toHaveBeenCalled();
    await restarted.setDesired("enabled", "resume"); await restarted.reconcile();
    const state = (await restarted.inspect()).state;
    expect(state.activeBinding?.sessionId).not.toBe(old); expect(state.transition?.attempts).toBe(1);
    expect(state.activeGeneration).toBe(1); expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.inference).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled();
  });
  it("settles suspension during the initial reservation validation before coordinator preparation", async () => {
    const f = await fixture(); await f.resident.configure(f.selection, "configure");
    const validate = f.resident.validateReservation.bind(f.resident), entered = gate(), release = gate();
    vi.spyOn(f.resident, "validateReservation").mockImplementationOnce(async (reservation) => {
      entered.resolve(); await release.promise; await validate(reservation);
    });
    const launch = f.resident.reconcile(); await entered.promise;
    await f.resident.setDesired("suspended", "suspend"); release.resolve(); await launch;
    expect((await f.resident.inspect()).state.transition?.successor).toBeUndefined();
    expect((await f.resident.inspect()).state.desired).toBe("suspended"); expect(f.spawn).not.toHaveBeenCalled();
    const restarted = await f.reconstruct(true); await restarted.setDesired("enabled", "resume"); await restarted.reconcile();
    expect(f.spawn).toHaveBeenCalledOnce(); expect((await restarted.inspect()).state.activeBinding).toBeDefined();
  });
  it("activates matching owned execution when the launch response is lost", async () => {
    const f = await fixture(); const start = f.registry.start.bind(f.registry);
    vi.spyOn(f.registry, "start").mockImplementationOnce(async (...args) => { await start(...args); throw new Error("response lost"); });
    await f.resident.configure(f.selection, "configure"); await f.resident.reconcile();
    const state = (await f.resident.inspect()).state;
    expect(state.activeBinding).toBeDefined(); expect(state.hold).toBeUndefined(); expect(state.activeGeneration).toBe(1);
    await expect(f.admission.run(state.activeBinding!.sessionId, "mutate", async () => "allowed")).resolves.toBe("allowed");
    await f.resident.reconcile(); expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.inference).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled();
  });
  it("persists process creation failures and retry deadlines through reconstruction, then exhausts the episode", async () => {
    vi.useFakeTimers(); const f = await fixture();
    f.spawn.mockImplementation(() => { throw Object.assign(new Error("process creation failed"), { code: "EAGAIN" }); });
    await f.resident.configure(f.selection, "configure"); let resident = f.resident;
    for (const [index, delay] of [1000, 5000, 30000].entries()) {
      await resident.reconcile();
      const state = (await resident.inspect()).state;
      expect(state.transition?.successor).toBeUndefined(); expect(state.hold).toBeUndefined();
      expect(state.transition?.attempts).toBe(index + 1);
      expect(Date.parse(state.transition!.nextAttemptAt!) - Date.now()).toBe(delay);
      resident.dispose(); resident = await f.reconstruct(true); await resident.reconcile();
      await vi.advanceTimersByTimeAsync(delay - 1); await resident.reconcile();
      expect(f.spawn).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1); await resident.reconcile();
    }
    expect(f.spawn).toHaveBeenCalledTimes(3);
    expect((await resident.inspect()).state.hold?.code).toBe("launch-retries-exhausted");
    await resident.setDesired("enabled", "retry-episode"); await resident.reconcile();
    expect(f.spawn).toHaveBeenCalledTimes(4); expect((await resident.inspect()).state.transition?.attempts).toBe(1);
  });
  it("holds when admission loses the result after actual process creation", async () => {
    const f = await fixture(); const start = f.registry.start.bind(f.registry);
    vi.spyOn(f.registry, "start").mockImplementationOnce((request, prompt, activate, instruction, admit, reservation) =>
      start(request, prompt, activate, instruction, async (apply) => {
        await admit!(apply); throw new Error("admission response lost after creation");
      }, reservation));
    await f.resident.configure(f.selection, "configure"); await f.resident.reconcile();
    const state = (await f.resident.inspect()).state;
    expect(f.spawn).toHaveBeenCalledOnce(); expect(state.hold?.code).toBe("launch-ownership-unresolved");
    expect(state.transition?.successor).toBeDefined(); expect(state.transition?.nextAttemptAt).toBeUndefined();
    const restarted = await f.reconstruct(true); await restarted.reconcile();
    expect((await restarted.inspect()).state.hold?.code).toBe("launch-ownership-unresolved");
    expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("requires the exact transition and generation for owned outcome evidence", async () => {
    const f = await fixture(); await f.resident.configure(f.selection, "configure"); await f.resident.reconcile();
    const state = (await f.resident.inspect()).state;
    const reservation = { sessionId: state.activeBinding!.sessionId, transitionId: state.transition!.id };
    expect(f.registry.launchOutcome(reservation, state.activeGeneration!)).toMatchObject({ kind: "owned" });
    expect(f.registry.launchOutcome({ ...reservation, transitionId: "different" }, state.activeGeneration!)).toEqual({ kind: "unresolved" });
    expect(f.registry.launchOutcome(reservation, state.activeGeneration! + 1)).toEqual({ kind: "unresolved" });
  });
  it.each([true, false])("requires observed termination after initialization failure (observed=%s)", async (observed) => {
    const f = await fixture(); f.setReportExit(observed);
    f.initialize.mockRejectedValue(new Error("initialization failed"));
    await f.resident.configure(f.selection, "configure"); await f.resident.reconcile();
    const state = (await f.resident.inspect()).state;
    expect(f.spawn).toHaveBeenCalledOnce();
    if (observed) {
      expect(state.transition?.successor).toBeUndefined(); expect(state.transition?.nextAttemptAt).toBeDefined();
      expect(state.hold).toBeUndefined();
    } else {
      expect(state.hold?.code).toBe("launch-ownership-unresolved"); expect(state.transition?.successor).toBeDefined();
      expect(state.transition?.nextAttemptAt).toBeUndefined();
      // Recovery terminalizes a provisional record, but that is still not observed process death.
      const restarted = await f.reconstruct(true);
      await restarted.setDesired("enabled", "resume"); await restarted.reconcile();
      expect((await restarted.inspect()).state.hold?.code).toBe("launch-ownership-unresolved");
      expect(f.spawn).toHaveBeenCalledOnce();
    }
  });
  it("settles an unresolved failure when the exact detached runtime later confirms termination", async () => {
    const f = await fixture(); f.setReportExit(false); f.initialize.mockRejectedValue(new Error("initialize failed"));
    await f.resident.configure(f.selection, "configure"); f.composition.start(); await f.resident.reconcile();
    expect((await f.resident.inspect()).state.hold?.code).toBe("launch-ownership-unresolved");
    f.emitExit();
    // The coordinator publishes late evidence even after initialization cleanup detached the normal observer.
    await vi.waitFor(async () => { expect((await f.resident.inspect()).state.transition?.successor).toBeUndefined(); });
    const state = (await f.resident.inspect()).state;
    expect(state.hold).toBeUndefined(); expect(state.transition?.nextAttemptAt).toBeDefined();
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.inference).not.toHaveBeenCalled();
  });
  it("rechecks a held assigned launch and activates matching owned evidence after lifecycle reconstruction", async () => {
    const f = await fixture(); const start = f.registry.start.bind(f.registry);
    const evidence = f.registry.launchOutcome.bind(f.registry);
    const inspect = vi.spyOn(f.registry, "launchOutcome").mockReturnValue({ kind: "unresolved" });
    vi.spyOn(f.registry, "start").mockImplementationOnce(async (...args) => { await start(...args); throw new Error("response lost"); });
    await f.resident.configure(f.selection, "configure"); await f.resident.reconcile();
    expect((await f.resident.inspect()).state.hold?.code).toBe("launch-ownership-unresolved");
    inspect.mockImplementation(evidence);
    const restarted = await f.reconstruct(); await restarted.reconcile();
    expect((await restarted.inspect()).state.activeBinding).toBeDefined();
    expect((await restarted.inspect()).state.hold).toBeUndefined(); expect(f.spawn).toHaveBeenCalledOnce();
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
