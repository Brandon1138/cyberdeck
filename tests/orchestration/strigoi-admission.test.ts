import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { StrigoiAdmission } from "../../src/orchestration/strigoi-admission.js";
import { describe, expect, it, vi } from "vitest";
import { fixture, deferred, identity, actor, target, successor } from "./strigoi-admission-fixture.js";

describe("Strigoi shared admission", () => {
  it("closes synchronously, rejects a second mutation and drains the admitted mutation", async () => {
    const f = fixture(), entered = deferred(), finish = deferred(), frozen = vi.fn();
    const first = f.admission.run(actor, "mutate", async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const freezing = f.admission.freeze(identity).then(frozen);
    await expect(f.admission.run(actor, "mutate", vi.fn())).rejects.toMatchObject({ code: "STRIGOI_FROZEN" });
    expect(frozen).not.toHaveBeenCalled();
    finish.resolve(); await first; await freezing;
    expect(frozen).toHaveBeenCalledOnce();
  });
  it("rejects old actors after cutover without applying and accepts the new identity", async () => {
    const f = fixture(), apply = vi.fn(async () => 1);
    f.set({ ...f.state(), incarnation: 2, activeBinding: { ...f.state().activeBinding!, sessionId: successor,
      resident: { name: "strigoi", incarnation: 2 } } });
    await expect(f.admission.run(actor, "mutate", apply)).rejects.toMatchObject({ code: "STRIGOI_STALE_INCARNATION" });
    expect(apply).not.toHaveBeenCalled();
    await expect(f.admission.run(successor, "mutate", apply)).resolves.toBe(1);
  });
  it("rechecks grants at delayed final writes", async () => {
    const f = fixture(), preflight = deferred(), entered = deferred(), write = vi.fn();
    const delivery = (async () => { entered.resolve(); await preflight.promise; return f.admission.instruction(f.record)(write); })();
    await entered.promise;
    f.state().activeBinding!.grant.capabilities = [];
    preflight.resolve();
    await expect(delivery).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    expect(write).not.toHaveBeenCalled();
  });
  it("allows nested admitted mutations to finish during concurrent freeze", async () => {
    const f = fixture(), entered = deferred(), finish = deferred();
    const first = f.admission.run(actor, "mutate", async () => {
      entered.resolve(); await finish.promise;
      return f.admission.run(actor, "mutate", async () => 42);
    });
    await entered.promise;
    const freezes = [f.admission.freeze(identity), f.admission.freeze(identity)];
    finish.resolve(); await expect(first).resolves.toBe(42); await Promise.all(freezes);
  });
  it("permits read-only recovery while suspended, never a mutation", async () => {
    const f = fixture(); f.state().desired = "suspended";
    await expect(f.admission.run(actor, "recovery", async () => "inspection")).resolves.toBe("inspection");
    await expect(f.admission.run(actor, "mutate", vi.fn())).rejects.toMatchObject({ code: "STRIGOI_SUSPENDED" });
  });
  it("preserves nonresident calls", async () => {
    const f = fixture();
    await expect(f.admission.run(target, "mutate", async () => 7)).resolves.toBe(7);
  });
  it("uses generation as well as session and incarnation", async () => {
    const f = fixture(), apply = vi.fn(); f.state().activeGeneration = 2;
    await expect(f.admission.run(actor, "mutate", apply)).rejects.toMatchObject({ code: "STRIGOI_STALE_INCARNATION" });
    expect(apply).not.toHaveBeenCalled();
  });
  it("closes pending authority reads even if freeze precedes admission counting", async () => {
    const f = fixture(), entered = deferred(), finish = deferred(), apply = vi.fn();
    vi.spyOn(f.repository, "read").mockImplementation(async () => { entered.resolve(); await finish.promise; return f.state(); });
    const pending = f.admission.run(actor, "mutate", apply);
    await entered.promise; await f.admission.freeze(identity); finish.resolve();
    await expect(pending).rejects.toMatchObject({ code: "STRIGOI_FROZEN" });
    expect(apply).not.toHaveBeenCalled();
  });
  it.each(["sealed", "retiring", "launching", "committed", "adopting", "reconciling"] as const)(
    "restores the durable %s phase hold without an in-memory freeze", async (phase) => {
      const f = fixture();
      f.state().transition = { id: "transition", expectedIncarnation: 1, reason: "renew", phase, attempts: 0 };
      await expect(f.admission.run(actor, "mutate", vi.fn())).rejects.toMatchObject({ code: "STRIGOI_RECOVERING" });
      await expect(f.admission.run(actor, "recovery", async () => "read")).resolves.toBe("read");
    });
  it("propagates corrupt lookup errors without applying an unknown actor", async () => {
    const f = fixture(), apply = vi.fn();
    vi.spyOn(f.bindings, "findBySessionId").mockRejectedValue(Object.assign(new Error("corrupt"), { code: "STRIGOI_CORRUPT_STATE" }));
    await expect(f.admission.run(target, "mutate", apply)).rejects.toMatchObject({ code: "STRIGOI_CORRUPT_STATE" });
    expect(apply).not.toHaveBeenCalled();
  });
  it("preserves established unrelated bindings on resident-only corruption", async () => {
    const f = fixture();
    vi.spyOn(f.bindings, "findBySessionId").mockResolvedValue({ ...f.state().activeBinding!, kind: "primary", key: "fleet", sessionId: target });
    vi.spyOn(f.repository, "read").mockRejectedValue(Object.assign(new Error("corrupt"), { code: "STRIGOI_CORRUPT_STATE" }));
    await expect(f.admission.run(target, "mutate", async () => 9)).resolves.toBe(9);
  });
  it("cannot turn a historical resident into an ordinary caller by rebinding it", async () => {
    const f = fixture(), apply = vi.fn();
    f.set({ ...f.state(), incarnation: 2, activeBinding: { ...f.state().activeBinding!, sessionId: successor,
      resident: { name: "strigoi", incarnation: 2 } } });
    vi.spyOn(f.bindings, "findBySessionId").mockResolvedValue({ ...f.state().activeBinding!, kind: "primary", key: "fleet", sessionId: actor });
    await expect(f.admission.run(actor, "mutate", apply)).rejects.toMatchObject({ code: "STRIGOI_STALE_INCARNATION" });
    expect(apply).not.toHaveBeenCalled();
  });
  it("does not let a read/recovery classification mint an inherited mutation permit", async () => {
    const f = fixture(); await f.admission.freeze(identity);
    await expect(f.admission.run(actor, "recovery", () => f.admission.run(actor, "mutate", vi.fn())))
      .rejects.toMatchObject({ code: "STRIGOI_FROZEN" });
  });
  it("reopens only the drained current identity, and concurrent freeze beats reopening", async () => {
    const f = fixture();
    await f.admission.freeze(identity); await f.admission.reopen(identity);
    await expect(f.admission.run(actor, "mutate", async () => 1)).resolves.toBe(1);
    const entered = deferred(), finish = deferred();
    vi.spyOn(f.repository, "read").mockImplementation(async () => { entered.resolve(); await finish.promise; return f.state(); });
    const reopening = f.admission.reopen(identity);
    await entered.promise; await f.admission.freeze(identity); finish.resolve();
    await expect(reopening).rejects.toMatchObject({ code: "STRIGOI_FROZEN" });
  });

  it("uses the real authority shard across fsynced cutover and a fresh admission instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strigoi-admission-"));
    try {
      const f = fixture(), bindings = new OrchestratorStore(directory), repository = bindings.strigoi;
      const first = await repository.compareAndSwap(0, "activate", f.state());
      const admission = new StrigoiAdmission(repository, bindings, f.registry);
      await expect(admission.run(actor, "mutate", async () => 1)).resolves.toBe(1);
      await admission.freeze(identity);
      const packet = { artifactId: "packet", sha256: "a".repeat(64), coverageId: "coverage" };
      const nextIdentity = { sessionId: successor, incarnation: 2, generation: 1 };
      const second = await repository.compareAndSwap(1, "cutover", { ...first, revision: 2, incarnation: 2,
        activeBinding: { ...first.activeBinding!, sessionId: successor, resident: { name: "strigoi", incarnation: 2 },
          grant: { ...first.activeBinding!.grant, subjectSessionId: successor } },
        retainedSessionIds: [actor, successor], latestPacket: packet,
        transition: { id: "renew", reason: "test", expectedIncarnation: 1, phase: "committed", attempts: 0,
          predecessor: identity, successor: nextIdentity, packet } });
      const restartedBindings = new OrchestratorStore(directory);
      const restarted = new StrigoiAdmission(restartedBindings.strigoi, restartedBindings, f.registry);
      await expect(restarted.run(actor, "mutate", vi.fn())).rejects.toMatchObject({ code: "STRIGOI_STALE_INCARNATION" });
      await expect(restarted.run(successor, "mutate", vi.fn())).rejects.toMatchObject({ code: "STRIGOI_RECOVERING" });
      await expect(restarted.run(successor, "recovery", async () => 2)).resolves.toBe(2);
      await repository.compareAndSwap(2, "ready", { ...second, revision: 3, transition: { ...second.transition!, phase: "complete" } });
      await expect(restarted.run(successor, "mutate", async () => 3)).resolves.toBe(3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

});
