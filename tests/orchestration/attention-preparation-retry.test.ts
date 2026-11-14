import { afterEach, expect, it, vi } from "vitest";
import { OrchestratorAttentionStore } from "../../src/persistence/orchestrator-attention-store.js";
import { withBindingAuthority } from "../../src/persistence/binding-authority.js";
import { updateAttentionRefresh } from "../../src/orchestration/orchestrator-attention-succession.js";
import { attentionHarness, cleanupAttentionHarnesses, NOW, ACTOR } from "../support/attention-harness.js";
import { recoveryFixture, nextIdentity } from "./strigoi-worker-recovery-fixture.js";

const recoveries: Awaited<ReturnType<typeof recoveryFixture>>[] = [];
afterEach(async () => { for (const f of recoveries.splice(0)) f.liveness.dispose(); await cleanupAttentionHarnesses(); });

function racePreparation(store: OrchestratorAttentionStore, race: () => Promise<void>) {
  const update = store.update.bind(store);
  let ran = false;
  return vi.spyOn(store, "update").mockImplementation((id, change, admit) => update(id, async current => {
    const next = await change(current);
    if (!ran) { ran = true; await race(); }
    return next;
  }, admit));
}

it("does not return an armed scheduling snapshot discarded by a cancellation CAS retry", async () => {
  const f = await attentionHarness(), armed = await f.attention.arm(f.request());
  f.attention.stop(); await f.attention.flush();
  const concurrent = new OrchestratorAttentionStore(f.directory);
  racePreparation(f.store, async () => {
    await concurrent.update(armed.controllerId, async current => ({ ...current!, status: "cancelled", cancelledAt: NOW, cancelReason: "Operator cancelled" }));
  });
  expect(await f.attention.schedulingSnapshot(armed.controllerId)).toBeUndefined();
  expect(await f.store.get(armed.controllerId)).toMatchObject({ status: "cancelled", epoch: armed.epoch });
});

it("drops successor authority checks from a preparation discarded by operator cancellation", async () => {
  const f = await recoveryFixture(); recoveries.push(f);
  const armed = await f.attention.arm(f.request()); await f.seal(); await f.cutover();
  f.attention.stop(); await f.attention.flush();
  const concurrent = new OrchestratorAttentionStore(f.directory);
  racePreparation(f.store, async () => {
    await concurrent.update(armed.controllerId, async current => ({ ...current!, status: "cancelled", cancelledAt: f.now(), cancelReason: "Operator cancelled" }));
    await f.transfer();
  });
  await expect(f.attention.resumeForSuccessor(ACTOR, nextIdentity, f.transitionId)).resolves.toBeUndefined();
  expect(await f.store.get(armed.controllerId)).toMatchObject({ status: "cancelled", epoch: armed.epoch, actorSessionId: ACTOR });
});

it("drops provisional cancellation metadata when a store CAS retry observes an explicit tombstone", async () => {
  const f = await attentionHarness({ resident: true }), armed = await f.attention.arm(f.request());
  f.attention.stop(); await f.attention.flush();
  const concurrent = new OrchestratorAttentionStore(f.directory);
  racePreparation(f.store, async () => {
    await concurrent.update(armed.controllerId, async current => ({ ...current!, status: "cancelled", cancelledAt: NOW, cancelReason: "Operator cancelled" }));
  });
  const read = vi.fn(async () => { throw new Error("Obsolete succession check"); });
  const result = updateAttentionRefresh({ ...f.controlOptions, resident: { read },
    bindings: { ...f.controlOptions.bindings, withAuthority: work => withBindingAuthority(f.directory, work) } },
  armed.controllerId, async current => current?.status === "armed"
    ? { ...current, status: "cancelled", cancelledAt: NOW, cancelReason: "Orchestrator binding unavailable or replaced" }
    : current);
  await expect(result).resolves.toMatchObject({ status: "cancelled", cancelReason: "Operator cancelled" });
  expect(read).not.toHaveBeenCalled();
});
