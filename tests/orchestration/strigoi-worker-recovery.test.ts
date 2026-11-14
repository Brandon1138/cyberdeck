import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import { WorkerControlService } from "../../src/orchestration/worker-control-service.js";
import { OrchestratorSessionLiveness } from "../../src/orchestration/orchestrator-session-liveness.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerWorkerLeaseCredentialCustodian } from "../../src/broker/worker-lease-credential-custodian.js";
import { attentionLivenessFloor } from "../../src/orchestration/orchestrator-attention-policy.js";
import { ACTOR, WORKER, OTHER, cleanupAttentionHarnesses } from "../support/attention-harness.js";
import { recoveryFixture, NEXT, nextIdentity } from "./strigoi-worker-recovery-fixture.js";
import { deferred } from "./strigoi-admission-fixture.js";

const fixtures: Awaited<ReturnType<typeof recoveryFixture>>[] = [];
async function fixture() { const f = await recoveryFixture(); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) f.liveness.dispose(); await cleanupAttentionHarnesses(); });

describe("Strigoi production worker recovery", () => {
  it("continues an owned live worker and armed wait with usable custody, exact consumption and pending result refs", async () => {
    const f = await fixture();
    await f.report("Already handled progress");
    const armed = await f.attention.arm(f.request());
    const first = await f.attention.readPage(ACTOR, armed.epoch, [], 1200);
    await f.attention.acknowledge(ACTOR, armed.epoch, first.receiptId);
    const consumed = (await f.store.get(armed.controllerId))!.coverage.consumed;
    const pendingId = randomUUID(), instructionId = randomUUID();
    await f.store.update(armed.controllerId, async (record) => ({ ...record!, pendingIntent: {
      epoch: armed.epoch, messageId: pendingId, instructionId, coverage: record!.coverage.captured, createdAt: f.now() } }));
    const packet = await f.seal();
    await f.death();
    await f.complete("Result produced in succession gap"); await f.attention.flush();
    expect(await f.attention.schedulingSnapshot(armed.controllerId)).toBeUndefined();
    await f.cutover();
    const token = f.credentials.get(f.controller.controllerId, WORKER);
    await expect(f.recovery.reconcile(nextIdentity, packet)).resolves.toEqual([]);
    const next = (await f.store.get(armed.controllerId))!;
    expect(next).toMatchObject({ status: "armed", actorSessionId: NEXT, recovery: "ready", receipts: [], readSequence: 0,
      coverage: { consumed }, succession: { previousActor: ACTOR, previousEpoch: armed.epoch, pendingMessageId: pendingId, pendingInstructionId: instructionId } });
    expect(next.epoch).not.toBe(armed.epoch);
    expect(next.pendingIntent?.epoch).toBe(next.epoch);
    expect(next.pendingIntent?.messageId).not.toBe(pendingId);
    expect(next.pendingIntent?.instructionId).toBeUndefined();
    expect(next.consumption).toBeUndefined();
    expect(f.credentials.get(f.controller.controllerId, WORKER)).toEqual(token);
    const state = await f.repository.read(); await f.mutate({ transition: { ...state.transition!, phase: "complete" } });
    await f.admission.reopen(nextIdentity);
    const page = await f.attention.readPage(NEXT, next.epoch, [], 1200);
    expect(page.workers[0]?.completion?.text).toBe("Result produced in succession gap");
    expect(page.workers[0]?.supervision).toBe("held");
    await expect(f.recovery.reconcile(nextIdentity, packet)).resolves.toEqual([]);
    expect((await f.store.get(next.controllerId))?.epoch).toBe(next.epoch);
    await expect(f.attention.acknowledge(NEXT, next.epoch, first.receiptId)).rejects.toMatchObject({ code: "STALE_ATTENTION_RECEIPT" });
    expect((await f.workers.lease({ actorSessionId: NEXT, action: "renew", scope: "worker", workerId: WORKER, reason: "continue" })).results[0]?.code).toBe("ALREADY_CONTROLLED");
    expect(f.instructions.enqueue).not.toHaveBeenCalled();
    expect(f.registry.resume).not.toHaveBeenCalled();
  });

  it("never reclaims a worker transferred away during sealing, even after the recipient dies", async () => {
    const f = await fixture(); const armed = await f.attention.arm(f.request()); const packet = await f.seal();
    const recipient = await f.transfer();
    await f.coordination.observeControllerLiveness({ mutationId: randomUUID(), actor: recipient, controller: recipient,
      state: "disconnected", reason: "recipient died" });
    f.advance(60_000); await f.cutover();
    const holds = await f.recovery.reconcile(nextIdentity, packet);
    expect(holds.map((hold) => hold.code)).toContain("worker-ownership-changed");
    expect(holds.map((hold) => hold.code)).toContain("attention-authority-changed");
    expect(f.coordination.getSubject(WORKER)?.lease.controller?.controllerId).toBe(recipient.controllerId);
    expect((await f.store.get(armed.controllerId))?.actorSessionId).toBe(ACTOR);
  });

  it("revalidates transfer inside the existing adoption transaction, even if the new owner is already orphaned", async () => {
    const f = await fixture(); const packet = await f.seal(); await f.death(); f.advance(60_000); await f.cutover();
    f.credentials.delete(f.controller.controllerId, WORKER);
    const adopt = f.coordination.adoptBatch.bind(f.coordination);
    vi.spyOn(f.coordination, "adoptBatch").mockImplementationOnce(async (input) => {
      const recipient = await f.transfer();
      await f.coordination.observeControllerLiveness({ mutationId: randomUUID(), actor: recipient, controller: recipient,
        state: "disconnected", reason: "recipient died" }); f.advance(60_000);
      return adopt(input);
    });
    expect((await f.recovery.reconcile(nextIdentity, packet)).map((h) => h.code)).toContain("worker-recovery-conflict");
    expect(f.coordination.getSubject(WORKER)?.lease.controller?.controllerId).not.toBe(f.controller.controllerId);
    expect(f.credentials.get(f.controller.controllerId, WORKER)).toBeUndefined();
  });

  it("recovers only eligible captured prior ownership after lost custody, repeatedly without trusting durable receipts", async () => {
    const f = await fixture(); const packet = await f.seal(); await f.death(); f.advance(60_000); await f.cutover();
    const custody = new BrokerWorkerLeaseCredentialCustodian(); const workers = f.makeWorkers(custody);
    const recovery = f.makeRecovery(workers);
    const otherVersion = f.coordination.getSubject(OTHER)!.lease.version;
    await expect(recovery.reconcile(nextIdentity, packet)).resolves.toEqual([]);
    const first = custody.get(f.controller.controllerId, WORKER)!; expect(first.leaseVersion).toBe(2);
    expect(f.coordination.getSubject(OTHER)!.lease.version).toBe(otherVersion);
    custody.delete(f.controller.controllerId, WORKER);
    expect((await recovery.reconcile(nextIdentity, packet)).map((h) => h.code)).toContain("worker-custody-unavailable");
    expect(custody.get(f.controller.controllerId, WORKER)).toBeUndefined();
    // A later real disconnect makes the same prior lease eligible; no serialized token is read.
    await f.coordination.observeControllerLiveness({ mutationId: randomUUID(), actor: f.controller, controller: f.controller,
      session: { sessionId: NEXT, generation: 1 }, state: "disconnected", reason: "broker lost execution" }); f.advance(60_000);
    await expect(recovery.reconcile(nextIdentity, packet)).resolves.toEqual([]);
    expect(custody.get(f.controller.controllerId, WORKER)!.leaseVersion).toBe(3);
    expect(custody.get(f.controller.controllerId, WORKER)!.leaseToken).not.toBe(first.leaseToken);
  });

  it("adopts an expired planned lease and refreshes attention lease versions without losing results", async () => {
    const f = await fixture(); const armed = await f.attention.arm(f.request()); const packet = await f.seal();
    await f.death(); f.advance(60_000); await f.complete("late completion"); await f.cutover();
    await expect(f.recovery.reconcile(nextIdentity, packet)).resolves.toEqual([]);
    const next = (await f.store.get(armed.controllerId))!;
    expect(next.authorities[0]?.leaseVersion).toBe(2);
    const state = await f.repository.read(); await f.mutate({ transition: { ...state.transition!, phase: "complete" } });
    await f.admission.reopen(nextIdentity);

    expect((await f.attention.readPage(NEXT, next.epoch, [], 1200)).workers[0]).toMatchObject({ supervision: "held", completion: { text: "late completion" } });
  });

  it("makes a deadline elapsed in the gap actionable after a real attention store restart", async () => {
    const f = await fixture(); const deadline = new Date(Date.parse(f.now()) + 1000).toISOString();
    const armed = await f.attention.arm(f.request({ reviewAt: deadline })); const packet = await f.seal();
    await f.death(); f.advance(2000); await f.cutover(); f.attention.stop(); await f.attention.flush();
    const attention = f.makeAttention(); await attention.start();
    await expect(f.makeRecovery(f.workers, attention).reconcile(nextIdentity, packet)).resolves.toEqual([]);
    const snapshot = (await attention.schedulingSnapshot(armed.controllerId))!;
    expect(snapshot.record.statement.reviewAt).toBe(deadline);
    expect(attentionLivenessFloor({ ...snapshot, now: f.now() })).toEqual({ outcome: "FALLBACK_WAKE", reason: "review-deadline" });
  });

  it.each(["explicit", "provider"])("never revives an operator-cancelled wait (%s)", async (mode) => {
    const f = await fixture(); const armed = await f.attention.arm(f.request());
    if (mode === "explicit") await f.attention.cancel({ actorSessionId: ACTOR, epoch: armed.epoch, reason: "Operator cancelled" });
    const packet = await f.seal();
    if (mode === "provider") await f.transcripts.commitProviderTurns({ sessionId: ACTOR, provider: "codex", turnNumber: 1,
      turns: [{ providerTurnId: "cancelled-owner", providerOccurredAt: f.now(), text: "Cancelled", transport: "provider-native", data: { outcome: "cancelled" } }] });
    await f.death(); await f.cutover();
    await expect(f.recovery.reconcile(nextIdentity, packet)).resolves.toEqual([]);
    expect(await f.store.get(armed.controllerId)).toMatchObject({ status: "cancelled", actorSessionId: ACTOR, epoch: armed.epoch });
  });

  it.each([
    { pause: "ledger", providerCancel: false }, { pause: "source", providerCancel: false }, { pause: "commit-stop", providerCancel: false },
    { pause: "source", providerCancel: true }, { pause: "commit-stop", providerCancel: true },
  ])("revalidates pre-seal refresh at $pause across cutover (provider cancellation: $providerCancel)", async ({ pause, providerCancel }) => {
    const f = await fixture(); const armed = await f.attention.arm(f.request());
    f.attention.stop(); await f.attention.flush();
    await f.mutate({ transition: { id: f.transitionId, expectedIncarnation: 1,
      predecessor: { sessionId: ACTOR, incarnation: 1, generation: 1 }, phase: "checkpointing", reason: "renew", attempts: 0 } });
    const entered = deferred(), release = deferred();
    if (pause === "commit-stop") {
      f.stopped.add(ACTOR);
      const update = f.store.update.bind(f.store);
      vi.spyOn(f.store, "update").mockImplementationOnce((id, change, admit) => update(id, async (current) => {
        const next = await change(current); entered.resolve(); await release.promise; return next;
      }, admit));
    } else {
      const read = f.transcripts.readCompletionLedger.bind(f.transcripts);
      let paused = false;
      vi.spyOn(f.transcripts, "readCompletionLedger").mockImplementation(async (id) => {
        if (!paused && id === (pause === "ledger" ? ACTOR : WORKER)) {
          paused = true; entered.resolve(); await release.promise;
        }
        return read(id);
      });
    }
    const refresh = f.attention.reconcile(armed.controllerId);
    await entered.promise;
    // seal() reads the attention store, whose refresh is deliberately still in flight.
    // Use an already copied immutable packet and commit through the actual repository.
    const packet = await f.packets.write({ sessionId: ACTOR, incarnation: 1, generation: 1 }, "race", [], f.now());
    const state = await f.repository.read();
    await f.mutate({ transition: { ...state.transition!, successor: nextIdentity, phase: "sealed", packet } });
    await f.mutate({ activeBinding: f.successor, incarnation: 2, activeGeneration: 1, latestPacket: packet,
      transition: { ...state.transition!, successor: nextIdentity, phase: "committed", packet } });
    await f.mutate({ transition: { ...(await f.repository.read()).transition!, phase: "reconciling" } });
    if (providerCancel) await f.transcripts.commitProviderTurns({ sessionId: ACTOR, provider: "codex", turnNumber: 1,
      turns: [{ providerTurnId: "cancel-during-cutover", providerOccurredAt: f.now(), text: "Cancelled",
        transport: "provider-native", data: { outcome: "cancelled" } }] });
    release.resolve();
    expect(await refresh).toMatchObject({ status: providerCancel ? "cancelled" : "armed", epoch: armed.epoch });
    await f.attention.resumeForSuccessor(ACTOR, nextIdentity, f.transitionId);
    expect(await f.store.get(armed.controllerId)).toMatchObject(providerCancel
      ? { status: "cancelled", actorSessionId: ACTOR, epoch: armed.epoch }
      : { status: "armed", actorSessionId: NEXT });
    expect(f.errors).toEqual([]);
  });

  it.each(["explicit", "provider"])("preserves genuine %s cancellation racing a pre-seal refresh", async (mode) => {
    const f = await fixture(); const armed = await f.attention.arm(f.request());
    f.attention.stop(); await f.attention.flush();
    const read = f.transcripts.readCompletionLedger.bind(f.transcripts), entered = deferred(), release = deferred();
    vi.spyOn(f.transcripts, "readCompletionLedger").mockImplementationOnce(async (id) => {
      entered.resolve(); await release.promise; return read(id);
    });
    const refresh = f.attention.reconcile(armed.controllerId); await entered.promise;
    const queued = deferred(), update = f.store.update.bind(f.store);
    if (mode === "explicit") vi.spyOn(f.store, "update").mockImplementationOnce((...args) => {
      queued.resolve(); return update(...args);
    });
    const cancelled = mode === "explicit"
      ? f.attention.cancel({ actorSessionId: ACTOR, epoch: armed.epoch, reason: "Operator cancelled during refresh" })
      : f.transcripts.commitProviderTurns({ sessionId: ACTOR, provider: "codex", turnNumber: 1,
        turns: [{ providerTurnId: "racing-cancel", providerOccurredAt: f.now(), text: "Cancelled", transport: "provider-native", data: { outcome: "cancelled" } }] });
    if (mode === "provider") await cancelled; else await queued.promise;
    release.resolve(); await refresh; await cancelled;
    const packet = await f.seal(); await f.cutover();
    await expect(f.recovery.reconcile(nextIdentity, packet)).resolves.toEqual([]);
    expect(await f.store.get(armed.controllerId)).toMatchObject({ status: "cancelled", epoch: armed.epoch, actorSessionId: ACTOR });
  });

  it("still holds a lease released after sealing outstanding work", async () => {
    const f = await fixture(); const packet = await f.seal();
    await f.coordination.release({ mutationId: randomUUID(), actor: f.controller, controller: f.controller,
      selector: { scope: "single", subjectId: WORKER }, leaseToken: f.tokens.get(WORKER)!, reason: "Operator released outstanding work" });
    await f.cutover();
    expect((await f.recovery.reconcile(nextIdentity, packet)).map((h) => h.code)).toContain("worker-ownership-changed");
  });

  it.each(["working", "failed", "stopped"] as const)("still holds unfinished interruption captured before seal (%s)", async (lifecycle) => {
    const f = await fixture();
    await f.coordination.updateLifecycle({ mutationId: randomUUID(), actor: f.controller, controller: f.controller,
      selector: { scope: "single", subjectId: WORKER }, subjectId: WORKER, leaseToken: f.tokens.get(WORKER)!, lifecycle,
      reason: "Observed unfinished worker" });
    f.records.set(WORKER, { ...f.records.get(WORKER)!, exitCode: 1, attentionState: "interrupted" });
    const packet = await f.seal(); await f.cutover();
    expect((await f.recovery.reconcile(nextIdentity, packet)).map((h) => h.code)).toContain("worker-interrupted");
    expect(f.registry.resume).not.toHaveBeenCalled(); expect(f.instructions.enqueue).not.toHaveBeenCalled();
  });

  it("retains interrupted worker results and never re-dispatches or starts its process", async () => {
    const f = await fixture(); const packet = await f.seal(); await f.complete("result before broker death");
    f.records.set(WORKER, { ...f.records.get(WORKER)!, exitCode: 1, attentionState: "interrupted" });
    await f.cutover();
    expect((await f.recovery.reconcile(nextIdentity, packet)).map((h) => h.code)).toContain("worker-interrupted");
    expect((await f.transcripts.readCompletionLedger(WORKER)).turns[0]?.text).toBe("result before broker death");
    expect(f.registry.resume).not.toHaveBeenCalled(); expect(f.instructions.enqueue).not.toHaveBeenCalled();
  });

  it.each(["suspend", "revoke"])("rechecks %s while recovery waits for canonical authority", async (mode) => {
    const f = await fixture(); const packet = await f.seal(); await f.death(); f.advance(60_000); await f.cutover();
    const entered = deferred(), release = deferred();
    const blocker = f.bindings.withAuthority(async () => {
      entered.resolve(); await release.promise;
      if (mode === "suspend") await f.mutate({ desired: "suspended" });
      else await f.mutate({ activeBinding: { ...f.successor, grant: { ...f.successor.grant, capabilities: [] } } });
    });
    await entered.promise;
    const work = f.recovery.reconcile(nextIdentity, packet); const settled = work.then((holds) => holds, (error: unknown) => error);
    release.resolve(); await blocker;
    const result = await settled;
    if (mode === "suspend") expect(result).toMatchObject({ message: "STRIGOI_STALE_RECOVERY" });
    else expect(result).toMatchObject([{ code: "worker-grant-changed" }]);
    expect(f.coordination.getSubject(WORKER)!.lease.version).toBe(1);
  });
  it("retains the death grace when successor activation precedes lost-custody eligibility", async () => {
    const f = await fixture(); const packet = await f.seal(); await f.death();
    f.credentials.delete(f.controller.controllerId, WORKER);
    await f.cutover();
    expect(f.coordination.listControllerLiveness().find((e) => e.controller.controllerId === f.controller.controllerId))
      .toMatchObject({ state: "disconnected", session: { sessionId: ACTOR } });
    expect((await f.recovery.reconcile(nextIdentity, packet)).map((h) => h.code)).toContain("worker-custody-unavailable");
    f.advance(60_000);
    await expect(f.recovery.reconcile(nextIdentity, packet)).resolves.toEqual([]);
    expect(f.credentials.get(f.controller.controllerId, WORKER)?.leaseVersion).toBe(2);
    expect(f.coordination.getSubject(WORKER)?.lease.state).toBe("active");
    await f.liveness.bindingSession(f.successor, f.registry.get(NEXT));
    expect(f.coordination.listControllerLiveness().find((e) => e.controller.controllerId === f.controller.controllerId))
      .toMatchObject({ state: "connected", session: { sessionId: NEXT } });
  });

  it("discards queued predecessor death and removal after an atomic cutover without an authority/tail deadlock", async () => {
    const f = await fixture(); const packet = await f.seal();
    const entered = deferred(), release = deferred();
    const cutover = f.bindings.withAuthority(async () => {
      entered.resolve(); await release.promise;
      const state = await f.repository.read();
      await f.mutate({ activeBinding: f.successor, incarnation: 2, activeGeneration: 1, latestPacket: packet,
        transition: { ...state.transition!, phase: "committed" } });
      // This callback is deliberately inside the cutover authority while an older edge waits.
      await f.liveness.bindingSession(f.successor, f.registry.get(NEXT));
    });
    await entered.promise;
    f.records.set(ACTOR, { ...f.records.get(ACTOR)!, exitCode: 0, executionState: "exited" }); f.emit(ACTOR);
    release.resolve(); await cutover; await f.liveness.flush();
    await f.liveness.bindingRemoved(f.bound); await f.liveness.bindingSession(f.bound);
    f.emit(NEXT); await f.liveness.flush(); f.advance(300_000);
    expect(f.coordination.listControllerLiveness().find((e) => e.controller.controllerId === f.controller.controllerId))
      .toMatchObject({ state: "connected", session: { sessionId: NEXT } });
    expect(f.coordination.getSubject(WORKER)?.lease).toMatchObject({ state: "active", version: 1 });
    expect(f.errors).toEqual([]);
  });

  it.each(["transfer", "revoke", "suspend", "generation"])("rechecks %s after asynchronous attention source capture", async (mode) => {
    const f = await fixture(); const armed = await f.attention.arm(f.request()); const packet = await f.seal(); await f.cutover();
    f.attention.stop(); await f.attention.flush();
    const read = f.transcripts.readCompletionLedger.bind(f.transcripts), entered = deferred(), release = deferred();
    vi.spyOn(f.transcripts, "readCompletionLedger").mockImplementationOnce(read).mockImplementationOnce(read)
      .mockImplementationOnce(async (id) => { entered.resolve(); await release.promise; return read(id); });
    const pending = f.recovery.reconcile(nextIdentity, packet).then((value) => value, (error: unknown) => error);
    await entered.promise;
    if (mode === "transfer") await f.transfer();
    if (mode === "revoke") await f.mutate({ activeBinding: { ...f.successor, grant: { ...f.successor.grant, capabilities: [] } } });
    if (mode === "suspend") await f.mutate({ desired: "suspended" });
    if (mode === "generation") f.records.set(NEXT, { ...f.records.get(NEXT)!, generation: 2 });
    release.resolve(); const outcome = await pending;
    if (mode === "transfer" || mode === "revoke") expect(outcome).toMatchObject([{ code: "attention-authority-changed" }]);
    else expect(outcome).toMatchObject({ message: "STRIGOI_STALE_RECOVERY" });
    expect(await f.store.get(armed.controllerId)).toMatchObject({ epoch: armed.epoch, actorSessionId: ACTOR });
  });

  it("holds missing current attention evidence instead of restoring a possibly cancelled packet snapshot", async () => {
    const f = await fixture(); const armed = await f.attention.arm(f.request()); const packet = await f.seal();
    await f.cutover(); f.attention.stop(); await f.attention.flush();
    await unlink(f.store.path(armed.controllerId));
    expect(await f.recovery.reconcile(nextIdentity, packet)).toMatchObject([{ code: "attention-evidence-missing", sourceIds: [armed.epoch] }]);
    expect(await f.store.get(armed.controllerId)).toBeUndefined();
  });

  it("reconstructs coordination and credential custody twice from durable journals without replaying receipt authority", async () => {
    const f = await fixture(); const packet = await f.seal(); await f.death(); f.advance(60_000); await f.cutover();
    f.liveness.dispose(); f.attention.stop(); await f.attention.flush();
    const restart = async () => {
      const coordination = new WorkerCoordinationService({ store: new WorkerCoordinationStore(f.directory), now: f.now });
      await coordination.initialize();
      const custody = new BrokerWorkerLeaseCredentialCustodian();
      const liveness = new OrchestratorSessionLiveness({ directory: new OrchestratorControllerDirectory(f.bindings),
        registry: f.registry, coordination, custody: { credentials: custody, subjects: coordination },
        withAuthority: (work) => f.bindings.withAuthority(work), onError: (error) => { throw error; } });
      const workers = new WorkerControlService({ coordination, credentials: custody, registry: f.registry as never,
        orchestrators: f.bindings, strigoi: f.admission, residentLiveness: liveness });
      await expect(f.makeRecovery(workers).reconcile(nextIdentity, packet)).resolves.toEqual([]);
      expect(coordination.getSubject(WORKER)?.lease.state).toBe("active");
      const token = custody.get(f.controller.controllerId, WORKER)!;
      expect((await coordination.renew({ mutationId: randomUUID(), actor: f.controller, controller: f.controller,
        selector: { scope: "single", subjectId: WORKER }, leaseToken: token.leaseToken, leaseVersion: token.leaseVersion,
        reason: "prove recovered executable authority" })).outcomes[0]?.code).toBe("ALREADY_CONTROLLED");
      return { coordination, custody };
    };
    const first = await restart(); const firstToken = first.custody.get(f.controller.controllerId, WORKER)!;
    await first.coordination.observeControllerLiveness({ mutationId: randomUUID(), actor: f.controller, controller: f.controller,
      state: "disconnected", session: { sessionId: NEXT, generation: 1 }, reason: "confirmed second broker execution loss" });
    f.advance(60_000);
    const second = await restart();
    expect(second.custody.get(f.controller.controllerId, WORKER)).toMatchObject({ leaseVersion: firstToken.leaseVersion + 1 });
    expect(second.custody.get(f.controller.controllerId, WORKER)?.leaseToken).not.toBe(firstToken.leaseToken);
    const persisted = JSON.stringify(await new WorkerCoordinationStore(f.directory).load());
    expect(persisted).not.toContain(firstToken.leaseToken);
    expect(persisted).not.toContain(second.custody.get(f.controller.controllerId, WORKER)!.leaseToken);
    expect(f.instructions.enqueue).not.toHaveBeenCalled();
  });

});
