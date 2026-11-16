import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { ACTOR, WORKER, cleanupAttentionHarnesses } from "../support/attention-harness.js";
import { recoveryFixture, NEXT, nextIdentity } from "./strigoi-worker-recovery-fixture.js";

const THIRD = "55555555-5555-4555-8555-555555555555";
const third = { sessionId: THIRD, incarnation: 3, generation: 1 };
const fixtures: Awaited<ReturnType<typeof recoveryFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) f.liveness.dispose(); await cleanupAttentionHarnesses(); });

async function chain() {
  const f = await recoveryFixture(); fixtures.push(f);
  await f.report("Progress already consumed by A");
  const armed = await f.attention.arm(f.request());
  const page = await f.attention.readPage(ACTOR, armed.epoch, [], 1200);
  await f.attention.acknowledge(ACTOR, armed.epoch, page.receiptId);
  const consumed = (await f.store.get(armed.controllerId))!.coverage.consumed;
  const pendingId = randomUUID();
  await f.store.update(armed.controllerId, async record => ({ ...record!, pendingIntent: {
    epoch: armed.epoch, messageId: pendingId, coverage: record!.coverage.captured, createdAt: f.now() } }));
  const packet = await f.seal(); await f.death(); await f.cutover();
  f.attention.stop(); await f.attention.flush();
  const before = await f.repository.read(), id = randomUUID();
  f.records.set(NEXT, { ...f.records.get(NEXT)!, exitCode: 1, executionState: "exited" });
  await f.mutate({ successionHistory: [{ ...before.transition!, phase: "adopting", supersededBy: id }],
    transition: { id, predecessor: nextIdentity, expectedIncarnation: 2, reason: "runtime-recovery",
      recovery: true, phase: "requested", attempts: 0, packet } });
  const finish = async () => {
    f.records.set(THIRD, { ...f.records.get(NEXT)!, id: THIRD, exitCode: null, executionState: "active" });
    f.truths.set(THIRD, { ...f.truths.get(NEXT)!, state: "idle" });
    const binding = { ...f.successor, sessionId: THIRD, resident: { name: "strigoi" as const, incarnation: 3 },
      grant: { ...f.successor.grant, subjectSessionId: THIRD } };
    await f.mutate({ activeBinding: binding, incarnation: 3, retainedSessionIds: [ACTOR, NEXT, THIRD],
      transition: { ...(await f.repository.read()).transition!, successor: third, phase: "committed" } });
    await f.mutate({ transition: { ...(await f.repository.read()).transition!, phase: "reconciling" } });
    await f.liveness.bindingSession(binding, f.registry.get(THIRD));
    return binding;
  };
  return { ...f, armed, packet, consumed, pendingId, finish };
}

it("preserves A's wait across interrupted A→B→C, store restart, and C's production reconciliation", async () => {
  const f = await chain();
  expect(await f.attention.reconcile(f.armed.controllerId)).toMatchObject({ status: "armed", actorSessionId: ACTOR });
  const binding = await f.finish();
  const attention = f.makeAttention(); await attention.start(); await attention.bindingChanged(binding);
  expect(await attention.schedulingSnapshot(f.armed.controllerId)).toBeUndefined();
  expect(await f.store.get(f.armed.controllerId)).toMatchObject({ status: "armed", actorSessionId: ACTOR });
  await f.complete("Worker result during repeated replacement");
  const recovery = f.makeRecovery(f.workers, attention);
  await expect(recovery.reconcile(third, f.packet)).resolves.toEqual([]);
  const wait = (await f.store.get(f.armed.controllerId))!;
  expect(wait).toMatchObject({ status: "armed", actorSessionId: THIRD, coverage: { consumed: f.consumed },
    succession: { previousActor: ACTOR, previousEpoch: f.armed.epoch, pendingMessageId: f.pendingId } });
  expect(wait.epoch).not.toBe(f.armed.epoch);
  expect(wait.pendingIntent?.messageId).not.toBe(f.pendingId);
  await expect(recovery.reconcile(third, f.packet)).resolves.toEqual([]);
  expect((await f.store.get(f.armed.controllerId))?.epoch).toBe(wait.epoch);
  await f.mutate({ transition: { ...(await f.repository.read()).transition!, phase: "complete" } });
  await f.admission.reopen(third);
  expect((await attention.readPage(THIRD, wait.epoch, [], 1200)).workers[0]?.completion?.text)
    .toBe("Worker result during repeated replacement");
  expect(f.instructions.enqueue).not.toHaveBeenCalled(); expect(f.registry.resume).not.toHaveBeenCalled();
  expect(f.errors).toEqual([]);
});

it.each(["operator", "provider"])("keeps genuine %s cancellation authoritative across replacement chains", async mode => {
  const f = await chain();
  if (mode === "operator") await f.store.update(f.armed.controllerId, async record => ({ ...record!,
    status: "cancelled", pendingIntent: undefined, cancelledAt: f.now(), cancelReason: "Operator cancelled" }));
  else await f.transcripts.commitProviderTurns({ sessionId: ACTOR, provider: "codex", turnNumber: 1,
    turns: [{ providerTurnId: "cancelled-original", providerOccurredAt: f.now(), text: "Cancelled",
      transport: "provider-native", data: { outcome: "cancelled" } }] });
  await f.finish();
  await expect(f.recovery.reconcile(third, f.packet)).resolves.toEqual([]);
  expect(await f.store.get(f.armed.controllerId)).toMatchObject({ status: "cancelled", actorSessionId: ACTOR, epoch: f.armed.epoch });
});

it("holds missing ancestor attention evidence instead of treating it as cancelled", async () => {
  const f = await chain(); await f.finish();
  await unlink(f.store.path(f.armed.controllerId));
  expect(await f.recovery.reconcile(third, f.packet)).toMatchObject([{ code: "attention-evidence-missing", sourceIds: [f.armed.epoch] }]);
  expect(await f.store.get(f.armed.controllerId)).toBeUndefined();
});

it.each(["identity", "ambiguous", "completed"])("refuses %s lineage without cancelling the retained wait", async mode => {
  const f = await chain(); await f.finish();
  const state = await f.repository.read(), prior = state.successionHistory![0]!;
  await f.mutate({ successionHistory: mode === "ambiguous" ? [prior, { ...prior, id: randomUUID() }]
    : [{ ...prior, ...(mode === "identity" ? { successor: { ...nextIdentity, generation: 2 } } : { phase: "complete" as const }) }] });
  await expect(f.attention.reconcile(f.armed.controllerId)).rejects.toThrow("STRIGOI_INVALID_SUCCESSION_LINEAGE");
  expect(await f.store.get(f.armed.controllerId)).toMatchObject({ status: "armed", actorSessionId: ACTOR });
});

it("revalidates the ancestor link at the attention commit after source capture", async () => {
  const f = await chain(); await f.finish();
  const read = f.transcripts.readCompletionLedger.bind(f.transcripts);
  let changed = false;
  vi.spyOn(f.transcripts, "readCompletionLedger").mockImplementation(async id => {
    const value = await read(id);
    if (id === WORKER && !changed) {
      changed = true;
      const state = await f.repository.read();
      await f.mutate({ successionHistory: state.successionHistory!.map(link => ({ ...link, supersededBy: undefined })) });
    }
    return value;
  });
  await expect(f.attention.resumeForSuccessor(NEXT, third, (await f.repository.read()).transition!.id))
    .rejects.toThrow("STRIGOI_WAIT_CHANGED");
  expect(changed).toBe(true);
  expect(await f.store.get(f.armed.controllerId)).toMatchObject({ actorSessionId: ACTOR, epoch: f.armed.epoch, status: "armed" });
});
