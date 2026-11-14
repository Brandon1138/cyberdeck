import { afterEach, describe, expect, it, vi } from "vitest";
import { StrigoiSuccession } from "../../src/orchestration/strigoi-succession.js";
import { successionFixture } from "./strigoi-succession-fixture.js";
const fixtures: Awaited<ReturnType<typeof successionFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function fixture() { const f = await successionFixture(); fixtures.push(f); return f; }

describe("serialized succession", () => {
  it("exposes the serialized renewal and replay interface", () => {
    expect(StrigoiSuccession.prototype.renew).toBeTypeOf("function");
    expect(StrigoiSuccession.prototype.advance).toBeTypeOf("function");
    expect(StrigoiSuccession.prototype.abort).toBeTypeOf("function");
  });
  it("orders sealed < confirmed retirement < passive launch < commit < adoption < release, atomically", async () => {
    const f = await fixture(), renewal = await f.runtime.succession!.renew(1, "renew", "renew-1");
    const state = await f.drive(renewal.id);
    expect(state.transition?.phase).toBe("complete");
    const first = (label: string) => f.trace.indexOf(label);
    expect(first("sealed")).toBeLessThan(first("confirmed-retirement"));
    expect(first("confirmed-retirement")).toBeLessThan(first("launch"));
    expect(first("launch")).toBeLessThan(first("committed"));
    expect(first("committed")).toBeLessThan(first("adoption"));
    expect(first("adoption")).toBeLessThan(first("release"));
    const committed = f.states.filter((s) => s.incarnation === 2)[0]!;
    expect(committed).toMatchObject({ activeBinding: { sessionId: committed.transition!.successor!.sessionId }, latestPacket: committed.transition!.packet, transition: { phase: "committed" } });
    expect(f.states.filter((s) => s.incarnation === 1).every((s) => s.activeBinding?.sessionId === f.original.activeBinding!.sessionId)).toBe(true);
    const replay = await f.runtime.succession!.renew(1, "renew", "renew-1");
    expect(replay.id).toBe(renewal.id); expect(replay.successor).toEqual(state.transition!.successor);
    expect(f.spawn).toHaveBeenCalledTimes(2); expect(f.inference).not.toHaveBeenCalled();
    const adoption = state.continuityReceipts!.find((r) => r.adoption)!.adoption!;
    await expect(f.runtime.continuity!.acknowledge({ ...adoption, identity: renewal.predecessor! }, "stale")).rejects.toThrow("STALE_INCARNATION");
  });
  it("waits 120 seconds without stopping ongoing work and resumes at the actual boundary", async () => {
    const f = await fixture(); f.setBoundary("busy");
    const t = await f.runtime.succession!.renew(1, "renew", "r");
    await f.drive(t.id, 1); f.tick(120_000);
    expect((await f.drive(t.id, 1)).hold?.code).toBe("awaiting-safe-boundary");
    expect(f.trace).not.toContain("stop"); expect(f.spawn).toHaveBeenCalledOnce();
    f.setBoundary("safe"); expect((await f.drive(t.id)).transition?.phase).toBe("complete");
  });
  it("never retries rendered/unknown checkpoint execution after timeout or reconstruction", async () => {
    const f = await fixture(); f.setAutoComplete(false);
    const t = await f.runtime.succession!.renew(1, "renew", "r");
    await f.drive(t.id, 1); f.tick(120_000); await f.reconstruct();
    const state = await f.drive(t.id);
    expect(state.hold?.code).toBe("checkpoint-outcome-unresolved");
    expect(f.submitted).toHaveLength(1); expect(f.trace).not.toContain("stop");
  });
  it("does not infer retirement from kill or completed checkpoint", async () => {
    const f = await fixture(); f.setAutoExit(false);
    const t = await f.runtime.succession!.renew(1, "renew", "r");
    expect((await f.drive(t.id)).hold?.code).toBe("retirement-unconfirmed");
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.trace.filter((s) => s === "stop")).toHaveLength(1);
    await f.reconstruct(); await f.drive(t.id); expect(f.spawn).toHaveBeenCalledOnce();
    f.emitExit(); expect((await f.drive(t.id)).transition?.phase).toBe("complete");
  });
  it("only retries terminated turns, at most twice", async () => {
    const f = await fixture(); f.setAutoComplete(false);
    const t = await f.runtime.succession!.renew(1, "renew", "r");
    await f.drive(t.id, 1);
    f.results.set(f.submitted[0]!.id, { outcome: "terminated" }); await f.drive(t.id, 1);
    f.results.set(f.submitted[1]!.id, { outcome: "terminated" });
    expect((await f.drive(t.id)).hold?.code).toBe("checkpoint-retries-exhausted");
    expect(f.submitted).toHaveLength(2);
  });
  it("waits for the human boundary after a proven refusal without spending the retry", async () => {
    const f = await fixture(); f.setAutoComplete(false);
    const t = await f.runtime.succession!.renew(1, "human attach race", "r");
    await f.drive(t.id, 1);
    f.results.set(f.submitted[0]!.id, { outcome: "terminated" }); f.setBoundary("busy");
    f.tick(120_000);
    expect((await f.drive(t.id)).hold?.code).toBe("awaiting-safe-boundary");
    expect(f.submitted).toHaveLength(1); expect(f.trace).not.toContain("stop");
    f.setBoundary("safe"); f.setAutoComplete(true);
    expect((await f.drive(t.id)).transition?.phase).toBe("complete");
    expect(f.submitted.map((s) => s.kind)).toEqual(["checkpoint", "checkpoint", "adoption"]);
  });
  it("keeps suspension across reconstruction and refuses late inference/launch", async () => {
    const f = await fixture(); const t = await f.runtime.succession!.renew(1, "renew", "r");
    await f.runtime.lifecycle.setDesired("suspended", "suspend");
    await f.reconstruct(true); const state = await f.drive(t.id);
    expect(state.desired).toBe("suspended"); expect(f.spawn).toHaveBeenCalledOnce(); expect(f.submitted).toHaveLength(0);
  });
  it("holds missing Task 7 participant and does not advertise readiness", async () => {
    const f = await fixture();
    f.workers.reconcile.mockResolvedValue([{ code: "workers-not-wired", detail: "Production seam not wired", sourceIds: [] }] as never);
    const t = await f.runtime.succession!.renew(1, "renew", "r");
    expect((await f.drive(t.id)).hold?.code).toBe("workers-not-wired");
    expect((await f.runtime.lifecycle.inspect()).readiness).toBe("held"); expect(f.trace).not.toContain("release");
  });
  it("resyncs a visible adoption receipt before releasing work", async () => {
    const f = await fixture(); const t = await f.runtime.succession!.renew(1, "renew", "r");
    await f.drive(t.id, 2);
    const ack = f.runtime.continuity!.acknowledge.bind(f.runtime.continuity!);
    vi.spyOn(f.runtime.continuity!, "acknowledge").mockImplementationOnce(async (...args) => { await ack(...args); throw new Error("lost ack reply"); });
    await expect(f.drive(t.id, 1)).rejects.toThrow("lost ack reply");
    const sync = vi.spyOn(f.bindings.strigoi, "confirmMutation");
    await f.reconstruct(); expect((await f.drive(t.id)).transition?.phase).toBe("complete");
    expect(sync.mock.calls.some(([id]) => id.startsWith("adopt:"))).toBe(true);
  });
  it("aborts before retirement and rejects rollback after retirement", async () => {
    const f = await fixture(); f.setBoundary("busy");
    const t = await f.runtime.succession!.renew(1, "abort", "r");
    await f.runtime.succession!.abort(t.id, "abort");
    await expect(f.runtime.admission.run(t.predecessor!.sessionId, "mutate", async () => "open")).resolves.toBe("open");
    f.setBoundary("safe"); const next = await f.runtime.succession!.renew(1, "forward", "r2"); await f.drive(next.id);
    await expect(f.runtime.succession!.abort(next.id, "unsafe")).rejects.toThrow("ABORT_UNSAFE");
  });
  it("allows the incumbent to finish mutations before its actual safe boundary", async () => {
    const f = await fixture(); f.setBoundary("busy"); const t = await f.runtime.succession!.renew(1, "busy", "r");
    await f.drive(t.id, 1);
    // Already-running work is allowed to finish while Task8 holds new ordinary turns.
    await expect(f.runtime.admission.run(t.predecessor!.sessionId, "mutate", async () => "finish existing work")).resolves.toBe("finish existing work");
    expect(f.delivery.hold).toHaveBeenCalled(); expect(f.trace).not.toContain("stop");
  });
  it.each(["before", "after"])("replays a lost %s-release result without redoing adoption", async (side) => {
    const f = await fixture(), reopen = vi.mocked(f.runtime.admission.reopen).getMockImplementation()!;
    vi.spyOn(f.runtime.admission, "reopen").mockImplementationOnce(async (...args) => {
      if (side === "after") await reopen(...args); throw new Error("release reply lost");
    });
    const t = await f.runtime.succession!.renew(1, "release", "r");
    await expect(f.drive(t.id)).rejects.toThrow("release reply lost");
    const attempts = f.submitted.length; await f.reconstruct();
    expect((await f.drive(t.id)).transition?.phase).toBe("complete"); expect(f.submitted).toHaveLength(attempts);
  });
  it("suspension during native initialization prevents activation", async () => {
    const f = await fixture();
    f.initialize.mockImplementationOnce(async () => { await f.runtime.lifecycle.setDesired("suspended", "during-initialize"); });
    const t = await f.runtime.succession!.renew(1, "suspend launch", "r");
    const state = await f.drive(t.id);
    expect(state.desired).toBe("suspended"); expect(state.incarnation).toBe(1);
    expect(f.submitted.map((r) => r.kind)).toEqual(["checkpoint"]);
    await f.reconstruct(true); await f.runtime.lifecycle.reconcile(); expect(f.spawn).toHaveBeenCalledTimes(2);
  });
  it("preserves a bounded launch failure episode and retries only after durable deadlines", async () => {
    const f = await fixture();
    f.spawn.mockImplementation(() => { throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }); });
    const t = await f.runtime.succession!.renew(1, "launch retries", "r");
    await f.drive(t.id); expect(f.spawn).toHaveBeenCalledTimes(2);
    for (const [index, delay] of [1000, 5000, 30000].entries()) {
      await f.reconstruct(); f.tick(delay - 1); await f.drive(t.id, 1); expect(f.spawn).toHaveBeenCalledTimes(Math.min(index + 2, 4));
      f.tick(1); await f.drive(t.id, 1);
    }
    expect((await f.bindings.strigoi.read()).hold?.code).toBe("launch-retries-exhausted"); expect(f.spawn).toHaveBeenCalledTimes(4);
  });
  it("records phase timing, packet bytes and attributable turn attempts with unknown usage", async () => {
    const f = await fixture(), t = await f.runtime.succession!.renew(1, "metrics", "r"); await f.drive(t.id);
    const events = await f.activity.read(t.id);
    const completed = events.find((e) => e.succession?.phase === "complete")!;
    expect(completed.succession).toMatchObject({ reason: "metrics", launchAttempts: 1, checkpointAttempts: 1, adoptionAttempts: 1, usage: null });
    expect(completed.succession!.packetManifestBytes).toBeGreaterThan(0);
    expect(completed.succession!.turns.map((t) => [t.kind, t.outcome, t.usage])).toEqual([["checkpoint", "completed", null], ["adoption", "completed", null]]);
    expect(completed.succession!.phaseTimes).toHaveProperty("sealed");
  });
  it("holds damaged required original evidence before retirement", async () => {
    const f = await fixture(), t = await f.runtime.succession!.renew(1, "corrupt evidence", "r");
    await f.drive(t.id, 1);
    vi.spyOn(f.evidence.sources, "capture").mockRejectedValue(new Error("original evidence corrupt"));
    expect((await f.drive(t.id)).hold?.code).toBe("continuity-evidence-unavailable");
    expect(f.trace).not.toContain("stop"); expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("surfaces a 120-second hold even when native submission never returns", async () => {
    const f = await fixture();
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((r) => { entered = r; }), pending = new Promise<void>((r) => { finish = r; });
    vi.mocked(f.turns.submit).mockImplementationOnce(async () => { entered(); await pending; });
    const t = await f.runtime.succession!.renew(1, "hung submission", "r");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const driving = f.drive(t.id, 1); await started; f.tick(120_000); await vi.advanceTimersByTimeAsync(120_000);
      expect((await driving).hold?.code).toBe("checkpoint-outcome-unresolved");
      await f.drive(t.id, 1); expect(f.turns.submit).toHaveBeenCalledOnce();
    } finally { finish(); vi.useRealTimers(); }
  });
  it("bounds reconciliation and never invokes a second participant while the first is unresolved", async () => {
    const f = await fixture(); let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((r) => { entered = r; }), pending = new Promise<void>((r) => { finish = r; });
    f.workers.reconcile.mockImplementationOnce(async () => { entered(); await pending; return []; });
    const t = await f.runtime.succession!.renew(1, "hung reconciliation", "r"); await f.drive(t.id, 2);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const drive = f.drive(t.id, 1); await started; f.tick(120_000); await vi.advanceTimersByTimeAsync(120_000);
      expect((await drive).hold?.code).toBe("reconciliation-outcome-unresolved");
      expect(f.workers.reconcile).toHaveBeenCalledOnce(); expect(f.delivery.reconcile).not.toHaveBeenCalled();
      await f.runtime.lifecycle.setDesired("suspended", "suspend-during-reconciliation"); finish();
    } finally { finish(); vi.useRealTimers(); }
    await f.drive(t.id, 1); expect(f.delivery.reconcile).not.toHaveBeenCalled();
    expect((await f.bindings.strigoi.read()).desired).toBe("suspended");
  });
  it("holds wrapped provider authentication failure immediately", async () => {
    const f = await fixture();
    f.initialize.mockRejectedValue(new Error("remote unavailable", { cause: Object.assign(new Error("login required"), { code: "AUTHENTICATION_REQUIRED" }) }));
    const t = await f.runtime.succession!.renew(1, "auth", "r");
    expect((await f.drive(t.id)).hold?.code).toBe("launch-configuration-failed");
    f.tick(60_000); await f.drive(t.id); expect(f.spawn).toHaveBeenCalledTimes(2);
  });
  it("holds participant exceptions without repeating unknown effects", async () => {
    const f = await fixture(); f.workers.reconcile.mockRejectedValueOnce(new Error("effect reply lost"));
    const t = await f.runtime.succession!.renew(1, "participant failure", "r");
    expect((await f.drive(t.id)).hold?.code).toBe("reconciliation-outcome-unresolved");
    expect(f.workers.reconcile).toHaveBeenCalledOnce(); expect(f.delivery.reconcile).not.toHaveBeenCalled();
  });
});
