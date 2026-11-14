import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { successionFixture } from "../orchestration/strigoi-succession-fixture.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import type { StrigoiPhase } from "../../src/domain/strigoi.js";
import * as privateFiles from "../../src/persistence/private-files.js";

const fixtures: Awaited<ReturnType<typeof successionFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function fixture() { const f = await successionFixture(); fixtures.push(f); return f; }

describe("succession durable boundary faults through the real registry/evidence composition", () => {
  it.each((["requested", "checkpointing", "sealed", "retiring", "launching", "committed", "adopting", "reconciling", "complete"] as StrigoiPhase[])
    .flatMap((phase) => ["before", "after"].map((side) => ({ phase, side }))))("reconfirms a visible record after failure $side actual fsync of $phase", async ({ phase, side }) => {
    const f = await fixture(), open = privateFiles.openPrivateAppendFile;
    let injected = false;
    const spy = vi.spyOn(privateFiles, "openPrivateAppendFile").mockImplementation(async (...args) => {
      const file = await open(...args);
      if (args[0] !== f.bindings.strigoi.path) return file;
      const sync = file.sync.bind(file), write = file.writeFile.bind(file); let hit = false;
      file.writeFile = async (...writeArgs) => {
        const state = JSON.parse(String(writeArgs[0])).state;
        hit = !injected && state.transition?.predecessor && state.transition.phase === phase;
        return write(...writeArgs);
      };
      file.sync = async () => {
        if (hit && !injected) { injected = true; if (side === "after") await sync(); throw new Error("injected fsync"); }
        return sync();
      };
      return file;
    });
    try {
      try { const t = await f.runtime.succession!.renew(1, "sync", "r"); await f.drive(t.id); } catch (e) { expect(String(e)).toContain("sync failed"); }
      expect(injected).toBe(true);
    } finally { spy.mockRestore(); }
    await f.reconstruct(); f.tick(120_000);
    const t = await f.runtime.succession!.renew(1, "sync", "r");
    const sync = vi.spyOn(f.bindings.strigoi, "confirmMutation");
    const state = await f.drive(t.id);
    expect(sync).toHaveBeenCalled();
    if (phase === "checkpointing") expect(state.hold).toMatchObject({ code: "checkpoint-outcome-unresolved", sourceIds: [f.original.activeBinding!.sessionId] });
    else { expect(state.transition?.phase).toBe("complete"); expect(state.hold).toBeUndefined(); }
    expect(f.spawn.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it.each((["requested", "checkpointing", "sealed", "retiring", "launching", "committed", "adopting", "reconciling", "complete"] as StrigoiPhase[])
    .flatMap((phase) => ["before", "after"].map((side) => ({ phase, side }))))("replays $side $phase append/fsync boundary", async ({ phase, side }) => {
    const f = await fixture(), real = vi.mocked(f.bindings.strigoi.compareAndSwap).getMockImplementation()!;
    let injected = false;
    vi.spyOn(f.bindings.strigoi, "compareAndSwap").mockImplementation(async (...args) => {
      if (!injected && args[2].transition?.predecessor && args[2].transition.phase === phase) {
        injected = true;
        if (side === "after") await real(...args);
        throw new Error("injected journal boundary");
      }
      return real(...args);
    });
    let id: string | undefined;
    try { id = (await f.runtime.succession!.renew(1, "fault", "r")).id; await f.drive(id); } catch (e) { expect(String(e)).toContain("injected journal boundary"); }
    expect(injected).toBe(true);
    await f.reconstruct();
    if (phase === "checkpointing" && side === "after") f.tick(120_000);
    id ??= (await f.runtime.succession!.renew(1, "fault", "r")).id;
    const state = await f.drive(id);
    if (phase === "checkpointing" && side === "after") expect(state.hold).toMatchObject({ code: "checkpoint-outcome-unresolved", sourceIds: [f.original.activeBinding!.sessionId] });
    else { expect(state.transition?.phase).toBe("complete"); expect(state.hold).toBeUndefined(); }
    expect(f.spawn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.registry.list().filter((s) => s.exitCode === null)).toHaveLength(1);
    const disk = await new OrchestratorStore(f.root).strigoi.read();
    expect(disk).toEqual(state);
  });
  it.each(["requested", "checkpointing", "sealed", "retiring", "launching", "committed", "adopting", "reconciling", "complete"] as StrigoiPhase[])("suspension wins after %s and after restart", async (phase) => {
    const f = await fixture(), real = vi.mocked(f.bindings.strigoi.compareAndSwap).getMockImplementation()!;
    let pause = false;
    vi.spyOn(f.bindings.strigoi, "compareAndSwap").mockImplementation(async (...args) => {
      const result = await real(...args);
      if (!pause && result.transition?.predecessor && result.transition.phase === phase) { pause = true; throw new Error("pause here"); }
      return result;
    });
    try { const t = await f.runtime.succession!.renew(1, "suspend", "r"); await f.drive(t.id); } catch (e) { expect(String(e)).toContain("pause here"); }
    expect(pause).toBe(true);
    await f.runtime.lifecycle.setDesired("suspended", "suspend");
    const before = f.spawn.mock.calls.length, submitted = f.submitted.length;
    await f.reconstruct(true); await f.runtime.lifecycle.reconcile();
    const state = await f.bindings.strigoi.read();
    expect(state.desired).toBe("suspended"); expect(f.spawn).toHaveBeenCalledTimes(before); expect(f.submitted).toHaveLength(submitted);
    expect((await f.runtime.lifecycle.inspect()).readiness).toBe("held");
  });
  it("recovers a committed incarnation with durable retirement but no owned runtime, using existing checkpoint and original tail", async () => {
    const f = await fixture(), old = f.original.activeBinding!.sessionId;
    const identity = { sessionId: old, incarnation: 1, generation: f.original.activeGeneration! };
    await f.evidence.sources.record("turn", "original-question", { role: "user", text: "Keep this exact unresolved question" }, [old]);
    await f.runtime.continuity!.checkpoint(identity, "Earlier understanding", [], "checkpoint");
    await f.evidence.sources.record("turn", "uncovered-tail", { role: "user", text: "An original instruction after checkpoint" }, [old]);
    f.emitExit(); await vi.waitFor(async () => { expect(await f.registry.residentRetirement(old, 1)).toBe("confirmed"); });
    await f.reconstruct(true); await f.runtime.lifecycle.reconcile();
    const t = (await f.bindings.strigoi.read()).transition!;
    const state = await f.drive(t.id);
    expect(state.transition?.phase).toBe("complete"); expect(state.incarnation).toBe(2);
    expect(f.submitted.map((s) => s.kind)).toEqual(["adoption"]);
    let cursor: string | undefined; const text: string[] = [];
    do { const page = await f.evidence.packets.read(state.latestPacket!, cursor); text.push(...page.sources.map((s) => s.text!)); cursor = page.nextCursor; } while (cursor);
    expect(text.join("\n")).toContain("Keep this exact unresolved question"); expect(text.join("\n")).toContain("An original instruction after checkpoint");
    await expect(f.registry.delete(old)).rejects.toThrow("REFERENCED");
  });
  it("captures original crash evidence without inventing a model checkpoint", async () => {
    const f = await fixture(), old = f.original.activeBinding!.sessionId;
    await f.evidence.sources.record("turn", "operator-original", { role: "user", text: "Only original evidence survived" }, [old]);
    f.emitExit(); await vi.waitFor(async () => expect(await f.registry.residentRetirement(old, 1)).toBe("confirmed"));
    await f.reconstruct(true); await f.runtime.lifecycle.reconcile();
    const state = await f.drive((await f.bindings.strigoi.read()).transition!.id);
    expect(state.transition?.phase).toBe("complete");
    expect((await f.evidence.packets.read(state.latestPacket!)).packet.prose).toContain("No model checkpoint");
    expect(f.submitted.map((s) => s.kind)).toEqual(["adoption"]);
  });
  it("holds a recovered unknown-exit sentinel instead of treating missing runtime as proven absence", async () => {
    const f = await fixture(); await f.reconstruct(true); await f.runtime.lifecycle.reconcile();
    const state = await f.bindings.strigoi.read();
    expect(state.hold?.code).toBe("retirement-unconfirmed"); expect(f.spawn).toHaveBeenCalledOnce();
    expect(state.transition?.packet).toBeDefined(); expect(state.transition?.phase).toBe("retiring");
  });
  it("restores passive residence without inference until a durable obligation requires adoption", async () => {
    const f = await fixture(), old = f.original.activeBinding!.sessionId;
    f.delivery.needsAdoption.mockResolvedValue(false);
    f.emitExit(); await vi.waitFor(async () => expect(await f.registry.residentRetirement(old, 1)).toBe("confirmed"));
    await f.reconstruct(true); await f.runtime.lifecycle.reconcile();
    const t = (await f.bindings.strigoi.read()).transition!;
    const state = await f.drive(t.id);
    expect(state.transition).toMatchObject({ phase: "adopting", adoptionDeferred: true }); expect(f.submitted).toHaveLength(0);
    expect((await f.runtime.lifecycle.inspect()).adoption).toBe("pending");
    f.delivery.needsAdoption.mockResolvedValue(true);
    expect((await f.drive(t.id)).transition?.phase).toBe("complete"); expect(f.submitted.map((r) => r.kind)).toEqual(["adoption"]);
  });
  it("retains input arriving after seal outside the earlier adoption coverage", async () => {
    const f = await fixture(), old = f.original.activeBinding!.sessionId;
    const stop = f.registry.stopResidentProcess.bind(f.registry);
    vi.spyOn(f.registry, "stopResidentProcess").mockImplementationOnce(async (id) => {
      await f.evidence.sources.record("turn", "cutover-input", { role: "user", text: "Accepted during cutover" }, [old]);
      return stop(id);
    });
    const t = await f.runtime.succession!.renew(1, "input", "r"), state = await f.drive(t.id);
    const pending = await f.runtime.continuity!.pending(state.transition!.successor!);
    expect(pending.some((s) => s.id === "cutover-input")).toBe(true);
    expect(state.continuityReceipts!.find((r) => r.adoption)?.adoption?.handledSourceIds).toEqual([]);
  });
  it("does not relaunch when process creation succeeds but the launch response is lost", async () => {
    const f = await fixture(), start = f.registry.start.bind(f.registry);
    vi.spyOn(f.registry, "start").mockImplementationOnce(async (...args) => { await start(...args); throw new Error("lost spawn response"); });
    const t = await f.runtime.succession!.renew(1, "lost launch", "r");
    expect((await f.drive(t.id)).transition?.phase).toBe("complete"); expect(f.spawn).toHaveBeenCalledTimes(2);
  });
  it("never concurrently retries unknown initialized execution, including after restart", async () => {
    const f = await fixture();
    // Retire the incumbent first; only the failed successor refuses observed exit.
    f.setAutoExit(true);
    const initialize = f.initialize.getMockImplementation();
    f.initialize.mockImplementationOnce(async () => { f.setAutoExit(false); await initialize?.(); throw new Error("initialize failed"); });
    const t = await f.runtime.succession!.renew(1, "unknown launch", "r");
    const state = await f.drive(t.id);
    expect(state.hold?.code).toBe("launch-ownership-unresolved");
    await f.reconstruct(true); await f.drive(t.id); expect(f.spawn).toHaveBeenCalledTimes(2);
    expect((await f.bindings.strigoi.read()).transition?.successor).toEqual(state.transition?.successor);
  });
  it("records one authoritative cutover in the journal and preserves the latest effective grant", async () => {
    const f = await fixture(), old = await f.bindings.strigoi.read();
    await f.bindings.strigoi.compareAndSwap(old.revision, "narrow", { ...old, revision: old.revision + 1,
      activeBinding: { ...old.activeBinding!, grant: { ...old.activeBinding!.grant, capabilities: ["thread.read"] } } });
    const t = await f.runtime.succession!.renew(1, "grant", "r"); const state = await f.drive(t.id);
    expect(state.activeBinding?.grant.capabilities).toEqual(["thread.read"]);
    const rows = (await readFile(f.bindings.strigoi.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line).state);
    expect(rows.filter((s, i) => i > 0 && s.incarnation !== rows[i - 1].incarnation && s.incarnation === 2)).toHaveLength(1);
  });
  it("drains admitted work outside canonical authority before sealing", async () => {
    const f = await fixture(), t = await f.runtime.succession!.renew(1, "drain", "r");
    await f.drive(t.id, 1); // checkpoint submitted
    let entered!: () => void, finish!: () => void;
    const start = new Promise<void>((r) => { entered = r; }), done = new Promise<void>((r) => { finish = r; });
    const admitted = f.runtime.admission.run(t.predecessor!.sessionId, "mutate", async () => { entered(); await done; });
    await start;
    const freeze = vi.spyOn(f.runtime.admission, "freeze");
    const advance = f.drive(t.id);
    await vi.waitFor(() => expect(freeze).toHaveBeenCalled());
    await f.bindings.withAuthority(async () => {
      expect((await f.bindings.strigoi.read()).transition?.phase).toBe("checkpointing");
    });
    finish(); await admitted; expect((await advance).transition?.phase).toBe("complete");
  });
  it.each(["continue", "abort"])("holds a shared admission drain beyond 120 seconds, allowing %s without duplicate effects", async (action) => {
    const f = await fixture(), t = await f.runtime.succession!.renew(1, "long drain", "r");
    await f.drive(t.id, 1);
    let entered!: () => void, finish!: () => void, freezing!: () => void;
    const started = new Promise<void>((r) => { entered = r; }), pending = new Promise<void>((r) => { finish = r; });
    const frozen = new Promise<void>((r) => { freezing = r; });
    const effect = vi.fn();
    const admitted = f.runtime.admission.run(t.predecessor!.sessionId, "mutate", async () => { entered(); await pending; effect(); });
    await started;
    const freeze = f.runtime.admission.freeze.bind(f.runtime.admission);
    const freezingCalls = vi.spyOn(f.runtime.admission, "freeze").mockImplementation((identity) => { const work = freeze(identity); freezing(); return work; });
    const capture = vi.spyOn(f.evidence.sources, "capture");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const driving = f.drive(t.id, 1); await frozen;
      f.tick(120_001); await vi.advanceTimersByTimeAsync(120_001);
      expect((await driving).hold?.code).toBe("awaiting-safe-boundary");
      expect((await f.runtime.lifecycle.inspect()).readiness).toBe("held");
      await f.bindings.withAuthority(async () => { expect((await f.bindings.strigoi.read()).transition?.phase).toBe("checkpointing"); });
      await f.drive(t.id, 2);
      expect(freezingCalls).toHaveBeenCalledOnce(); expect(capture).not.toHaveBeenCalled();
      expect(f.trace).not.toContain("stop"); expect(effect).not.toHaveBeenCalled();
      await expect(f.runtime.admission.run(t.predecessor!.sessionId, "mutate", async () => {})).rejects.toThrow("FROZEN");
      if (action === "abort") {
        await f.runtime.succession!.abort(t.id, "abort-held-drain");
        expect((await f.bindings.strigoi.read()).transition?.phase).toBe("aborted");
        await f.runtime.lifecycle.reconcile(); // No serialization slot or reopen waits on the mutation.
        await expect(f.runtime.admission.run(t.predecessor!.sessionId, "mutate", async () => {})).rejects.toThrow("FROZEN");
      }
      finish(); await admitted;
      await f.runtime.lifecycle.reconcile();
      const state = await f.drive(t.id);
      expect(effect).toHaveBeenCalledOnce();
      if (action === "continue") {
        expect(state.transition?.phase).toBe("complete"); expect(capture).toHaveBeenCalledOnce();
        expect(f.trace.filter((v) => v === "stop")).toHaveLength(1); expect(f.spawn).toHaveBeenCalledTimes(2);
        expect(f.submitted.map((s) => s.kind)).toEqual(["checkpoint", "adoption"]);
      } else {
        expect(state.transition?.phase).toBe("aborted"); expect(state.incarnation).toBe(1);
        expect(capture).not.toHaveBeenCalled(); expect(f.trace).not.toContain("stop"); expect(f.spawn).toHaveBeenCalledOnce();
        await expect(f.runtime.admission.run(t.predecessor!.sessionId, "mutate", async () => "open")).resolves.toBe("open");
      }
    } finally { finish(); await admitted; vi.useRealTimers(); }
  });
  it.each(["after-drain", "during-drain"])("fences aborted mutation admission when a modal opens %s and releases only after close", async (timing) => {
    const f = await fixture(), t = await f.runtime.succession!.renew(1, "abort modal", "r");
    const actor = t.predecessor!.sessionId, effect = vi.fn(async () => "admitted");
    const reopen = vi.mocked(f.runtime.admission.reopen); reopen.mockClear();
    let modal = false, entered!: () => void, finish!: () => void;
    const truth = f.registry.workerTruth.bind(f.registry);
    vi.spyOn(f.registry, "workerTruth").mockImplementation((id) => ({ ...truth(id), modalOpen: modal }));
    const started = new Promise<void>((r) => { entered = r; }), pending = new Promise<void>((r) => { finish = r; });
    const admitted = f.runtime.admission.run(actor, "mutate", async () => { entered(); await pending; });
    await started;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await f.runtime.succession!.abort(t.id, "abort-modal");
      await expect(f.runtime.admission.run(actor, "mutate", effect)).rejects.toThrow("FROZEN");
      if (timing === "during-drain") modal = true;
      // Reconciliation can time out but must leave the original permit and barrier intact.
      const waiting = f.runtime.lifecycle.reconcile();
      await vi.advanceTimersByTimeAsync(120_001); await waiting;
      await expect(f.runtime.admission.run(actor, "mutate", effect)).rejects.toThrow("FROZEN");
      finish(); await admitted;
      await f.runtime.lifecycle.reconcile();
      if (timing === "after-drain") {
        await expect(f.runtime.admission.run(actor, "mutate", effect)).resolves.toBe("admitted");
        effect.mockClear(); reopen.mockClear(); modal = true;
      } else {
        await expect(f.runtime.admission.run(actor, "mutate", effect)).rejects.toThrow("FROZEN");
      }
      await f.runtime.lifecycle.reconcile();
      await expect(f.runtime.admission.run(actor, "mutate", effect)).rejects.toThrow("FROZEN");
      expect((await f.bindings.strigoi.read()).hold?.code).toBe("provider-permission-modal");
      expect((await f.runtime.lifecycle.inspect()).readiness).toBe("held");
      await f.runtime.succession!.advance(t.id);
      await expect(f.runtime.admission.run(actor, "mutate", effect)).rejects.toThrow("FROZEN");
      expect(effect).not.toHaveBeenCalled(); expect(reopen).not.toHaveBeenCalled();
      modal = false; await f.runtime.lifecycle.reconcile();
      const state = await f.bindings.strigoi.read();
      expect(state.hold).toBeUndefined(); expect(state.transition?.phase).toBe("aborted");
      expect(state.activeBinding).toEqual(f.original.activeBinding); expect(state.incarnation).toBe(1);
      await expect(f.runtime.admission.run(actor, "mutate", effect)).resolves.toBe("admitted");
      expect(effect).toHaveBeenCalledOnce(); expect(f.spawn).toHaveBeenCalledOnce();
      expect(f.trace).not.toContain("stop"); expect(f.trace).not.toContain("sealed"); expect(f.submitted).toHaveLength(0);
    } finally { finish(); await admitted; vi.useRealTimers(); }
  });
  it.each(["suspend", "dispose"])("rechecks the lifecycle epoch after drain when %s arrives during the wait", async (action) => {
    const f = await fixture(), t = await f.runtime.succession!.renew(1, "fenced drain", "r");
    await f.drive(t.id, 1);
    let entered!: () => void, finish!: () => void, freezing!: () => void;
    const started = new Promise<void>((r) => { entered = r; }), pending = new Promise<void>((r) => { finish = r; });
    const frozen = new Promise<void>((r) => { freezing = r; });
    const admitted = f.runtime.admission.run(t.predecessor!.sessionId, "mutate", async () => { entered(); await pending; });
    await started;
    const freeze = f.runtime.admission.freeze.bind(f.runtime.admission);
    vi.spyOn(f.runtime.admission, "freeze").mockImplementation((identity) => { const work = freeze(identity); freezing(); return work; });
    const capture = vi.spyOn(f.evidence.sources, "capture");
    const driving = f.drive(t.id, 1); await frozen;
    const suspension = action === "suspend" ? f.runtime.lifecycle.setDesired("suspended", "during-drain") : Promise.resolve(f.runtime.dispose());
    finish(); await admitted; await suspension; await driving;
    expect(capture).not.toHaveBeenCalled(); expect(f.trace).not.toContain("sealed"); expect(f.spawn).toHaveBeenCalledOnce();
    // Explicit suspension stops the provider after drain; succession itself never seals/retires it.
    expect(f.trace.filter((v) => v === "stop")).toHaveLength(action === "suspend" ? 1 : 0);
    expect((await f.bindings.strigoi.read()).transition?.phase).toBe("checkpointing");
    await expect(f.runtime.admission.run(t.predecessor!.sessionId, "mutate", async () => {})).rejects.toThrow("FROZEN");
  });
});
