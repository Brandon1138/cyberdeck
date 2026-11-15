import { afterEach, expect, it, vi } from "vitest";
import { successionFixture } from "./strigoi-succession-fixture.js";
const fixtures: Awaited<ReturnType<typeof successionFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function passiveRecovery() {
  const f = await successionFixture(); fixtures.push(f);
  f.delivery.needsAdoption.mockResolvedValue(false);
  f.emitExit(); await new Promise(r => setTimeout(r, 20));
  await f.runtime.lifecycle.reconcile();
  const state = await f.bindings.strigoi.read();
  expect(state.transition).toMatchObject({ phase: "adopting", adoptionDeferred: true });
  return f;
}
it("replaces an observed-dead deferred successor across restart, preserving packet evidence without inference", async () => {
  const f = await passiveRecovery(), before = await f.bindings.strigoi.read();
  const retired = before.activeBinding!.sessionId;
  f.emitExit(2); await new Promise(r => setTimeout(r, 20));
  await f.runtime.lifecycle.reconcile();
  const retry = await f.bindings.strigoi.read();
  expect(retry.transition!.nextAttemptAt).toBeDefined();
  await f.reconstruct(true); // new registry; only observed exit survives, no inherited runtime
  f.tick(1001); await f.drive(before.transition!.id);
  const after = await f.bindings.strigoi.read();
  expect(after.incarnation).toBe(3);
  expect(after.transition).toMatchObject({ phase: "adopting", adoptionDeferred: true, recoveryAttempts: 1 });
  expect(after.retainedSessionIds).toContain(retired);
  expect(after.successionHistory).toContainEqual(expect.objectContaining({ packet: before.latestPacket, supersededBy: expect.any(String) }));
  expect((after.continuityReceipts ?? []).filter(r => r.adoption)).toEqual([]);
  expect(f.submitted).toEqual([]);
  await expect(f.runtime.admission.run(retired, "mutate", async () => {})).rejects.toThrow();
  f.delivery.needsAdoption.mockResolvedValue(true);
  await f.drive(after.transition!.id);
  expect((await f.bindings.strigoi.read()).transition?.phase).toBe("complete");
  expect(f.submitted.map(t => t.kind)).toEqual(["adoption"]);
});
it("unknown ownership or a stale generation never authorizes a replacement", async () => {
  const f = await passiveRecovery();
  await f.reconstruct(true); // fixture OS handle was not inherited; PID is not evidence
  await f.runtime.lifecycle.reconcile();
  const held = await f.bindings.strigoi.read();
  expect(held.hold?.code).toBe("successor-unavailable");
  expect(held.hold?.detail).toContain("legacy identities need operator reconciliation");
  expect(f.spawn).toHaveBeenCalledTimes(2); expect(f.submitted).toEqual([]);
});
it("persists replacement retry limits and backoff through repeated reconstruction", async () => {
  const f = await passiveRecovery();
  for (let n = 0; n < 3; n++) {
    f.emitExit(n + 2); await new Promise(r => setTimeout(r, 20));
    await f.runtime.lifecycle.reconcile();
    const pending = await f.bindings.strigoi.read();
    const count = f.spawn.mock.calls.length;
    await f.reconstruct(true); await f.runtime.lifecycle.reconcile();
    expect(f.spawn).toHaveBeenCalledTimes(count);
    expect((await f.bindings.strigoi.read()).transition?.nextAttemptAt).toBe(pending.transition?.nextAttemptAt);
    f.tick(30001); await f.runtime.lifecycle.reconcile();
  }
  f.emitExit(5); await new Promise(r => setTimeout(r, 20));
  await f.runtime.lifecycle.reconcile();
  expect((await f.bindings.strigoi.read()).hold?.code).toBe("recovery-retries-exhausted");
  await f.reconstruct(true); await f.runtime.lifecycle.reconcile();
  expect(f.spawn).toHaveBeenCalledTimes(5); expect(f.submitted).toEqual([]);
});
it.each(["suspended", "disabled"] as const)("%s survives restart during replacement backoff", async desired => {
  const f = await passiveRecovery();
  f.emitExit(2); await new Promise(r => setTimeout(r, 20));
  await f.runtime.lifecycle.reconcile();
  await f.runtime.lifecycle.setDesired(desired, `operator:${desired}`);
  await f.reconstruct(true); f.tick(60000); await f.runtime.lifecycle.reconcile();
  expect((await f.bindings.strigoi.read()).desired).toBe(desired);
  expect(f.spawn).toHaveBeenCalledTimes(2); expect(f.submitted).toEqual([]);
});
it("activity recording failure cannot prevent durable recovery", async () => {
  const f = await passiveRecovery();
  vi.spyOn(f.activity, "append").mockRejectedValue(new Error("activity degraded"));
  f.emitExit(2); await new Promise(r => setTimeout(r, 20));
  await f.runtime.lifecycle.reconcile(); f.tick(1001); await f.runtime.lifecycle.reconcile();
  expect((await f.bindings.strigoi.read()).incarnation).toBe(3);
});

it.each(["before", "after"])("replays an interrupted replacement intent %s durable publication", async side => {
  const f = await passiveRecovery();
  f.emitExit(2); await new Promise(r => setTimeout(r, 20));
  await f.runtime.lifecycle.reconcile(); f.tick(1001);
  const original = vi.mocked(f.bindings.strigoi.compareAndSwap).getMockImplementation()!;
  let injected = false;
  vi.mocked(f.bindings.strigoi.compareAndSwap).mockImplementation(async (...args) => {
    if (!injected && args[2].transition?.expectedIncarnation === 2) {
      injected = true; if (side === "after") await original(...args); throw new Error("lost replacement intent response");
    }
    return original(...args);
  });
  await expect(f.runtime.lifecycle.reconcile()).rejects.toThrow("lost replacement intent response");
  await f.reconstruct(true); f.tick(30001); await f.runtime.lifecycle.reconcile();
  expect(injected).toBe(true);
  expect((await f.bindings.strigoi.read()).incarnation).toBe(3);
  expect(f.spawn).toHaveBeenCalledTimes(3); expect(f.submitted).toEqual([]);
});
