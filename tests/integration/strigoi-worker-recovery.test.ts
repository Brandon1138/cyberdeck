import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { successionFixture } from "../orchestration/strigoi-succession-fixture.js";
import { ObservedWorkerCoordinationService } from "../../src/broker/observed-worker-coordination.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../../src/broker/worker-lease-credential-custodian.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import { OrchestratorNotificationStore } from "../../src/persistence/orchestrator-notification-store.js";
import { OrchestratorAttentionControlPlane } from "../../src/orchestration/orchestrator-attention-control.js";
import { OrchestratorSessionLiveness } from "../../src/orchestration/orchestrator-session-liveness.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";
import { WorkerControlService } from "../../src/orchestration/worker-control-service.js";
import { StrigoiWorkerRecovery } from "../../src/orchestration/strigoi-worker-recovery.js";
import { orchestratorController } from "../../src/domain/orchestrator.js";

it.each(["live", "done", "released"] as const)("runs real source inventory and worker/attention reconciliation through the driver without a routine hold (%s)", async (mode) => {
  const f = await successionFixture();
  const coordination = new ObservedWorkerCoordinationService({ store: new WorkerCoordinationStore(f.root) });
  await coordination.initialize();
  const credentials = new BrokerWorkerLeaseCredentialCustodian();
  const inbox = new OrchestratorNotificationStore(f.root); await inbox.load();
  const attention = new OrchestratorAttentionControlPlane({ store: f.evidence.attentionStore,
    bindings: f.bindings, resident: f.bindings.strigoi, strigoi: f.runtime.admission,
    registry: f.registry, coordination, transcripts: f.transcripts, inbox });
  const liveness = new OrchestratorSessionLiveness({ directory: new OrchestratorControllerDirectory(f.bindings),
    registry: f.registry, coordination, custody: { credentials, subjects: coordination },
    withAuthority: (work) => f.bindings.withAuthority(work), onError: (error) => { throw error; } });
  try {
    await liveness.start(); await attention.start();
    const owner = f.original.activeBinding!, controller = orchestratorController(owner);
    const worker = await f.registry.start({ provider: "codex", cwd: f.root, detached: true, sandbox: "workspace-write" });
    const registration = await coordination.registerSubject({ mutationId: randomUUID(), actor: controller,
      subjectId: worker.id, controller, lifecycle: "working", reason: "fixture dispatch",
      origin: { creatorControllerId: controller.controllerId, creatorSessionId: owner.sessionId, taskId: worker.id,
        threadId: worker.id, createdAt: worker.createdAt }, resources: { sessionId: worker.id, worktreePath: f.root, eventStreamId: worker.id } });
    const outcome = registration.outcomes[0]!;
    credentials.set(controller.controllerId, worker.id, { leaseToken: outcome.leaseToken!, leaseVersion: outcome.leaseVersion! });
    const workers = new WorkerControlService({ coordination, credentials, registry: f.registry, orchestrators: f.bindings,
      strigoi: f.runtime.admission, residentLiveness: liveness });
    const participant = new StrigoiWorkerRecovery({ repository: f.bindings.strigoi, packets: f.evidence.packets,
      admission: f.runtime.admission, workers, attention });
    f.workers.reconcile.mockImplementation((identity, packet) => participant.reconcile(identity, packet));
    f.setBindingObserver(async (binding, session) => {
      await attention.bindingChanged(binding); await liveness.bindingSession(binding, session);
      if (mode === "live" && binding.sessionId !== owner.sessionId) await f.transcripts.commitProviderTurns({ sessionId: worker.id,
        provider: "codex", turnNumber: 1, turns: [{ providerTurnId: "gap-result", providerOccurredAt: new Date().toISOString(),
          text: "Result arrived during cutover", transport: "provider-native" }] });
    });
    if (mode !== "live") {
      await f.transcripts.commitProviderTurns({ sessionId: worker.id, provider: "codex", turnNumber: 1,
        turns: [{ providerTurnId: "historical-result", providerOccurredAt: new Date().toISOString(),
          text: "Historical retained result", transport: "provider-native" }] });
      if (mode === "done") {
        await coordination.updateLifecycle({ mutationId: randomUUID(), actor: controller, controller,
          selector: { scope: "single", subjectId: worker.id }, subjectId: worker.id, leaseToken: outcome.leaseToken!, lifecycle: "done", reason: "Work finished before renewal" });
        f.emitExit(2);
        expect(f.registry.get(worker.id).exitCode).toBe(0);
      } else {
        await coordination.release({ mutationId: randomUUID(), actor: controller, controller,
          selector: { scope: "single", subjectId: worker.id }, leaseToken: outcome.leaseToken!, reason: "Released before renewal" });
      }
    }
    const historical = coordination.getSubject(worker.id)!;
    const renew = vi.spyOn(coordination, "renew"), adopt = vi.spyOn(coordination, "adoptBatch");
    const armed = mode === "live" ? await attention.arm({ actorSessionId: owner.sessionId, mutationId: randomUUID(),
      objective: "Review the live worker", nextAction: "Read its exact result", targets: [{ sessionId: worker.id, completionTarget: 1 }] }) : undefined;
    const transition = await f.runtime.succession!.renew(1, "routine worker continuation", "worker-renewal");
    const state = await f.drive(transition.id);
    expect(state.hold).toBeUndefined(); expect(state.transition?.phase).toBe("complete");
    expect(f.workers.reconcile).toHaveBeenCalledTimes(1);
    if (mode !== "live") {
      const refs = []; let cursor: string | undefined;
      do {
        const page = await f.evidence.packets.read(state.latestPacket!, cursor);
        refs.push(...page.sources); cursor = page.nextCursor;
      } while (cursor);
      expect(refs.some((ref) => ref.id === `ownership:${worker.id}`)).toBe(true);
      expect(refs.some((ref) => ref.text?.includes("Historical retained result"))).toBe(true);
      expect((await f.transcripts.readCompletionLedger(worker.id)).turns[0]?.text).toBe("Historical retained result");
      expect(coordination.getSubject(worker.id)).toMatchObject({ lifecycle: historical.lifecycle,
        lease: { state: historical.lease.state, version: historical.lease.version, controller: historical.lease.controller } });
      expect(renew).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled();
    } else {
      const wait = (await f.evidence.attentionStore.get(controller.controllerId))!;
      expect(wait.actorSessionId).toBe(state.activeBinding!.sessionId); expect(wait.epoch).not.toBe(armed!.epoch);
      expect((await attention.readPage(wait.actorSessionId, wait.epoch, [], 1200)).workers[0])
        .toMatchObject({ supervision: "held", completion: { text: "Result arrived during cutover" } });
      expect((await workers.lease({ actorSessionId: wait.actorSessionId, action: "renew", scope: "worker", workerId: worker.id, reason: "normal continuation" })).results[0]?.code).toBe("ALREADY_CONTROLLED");
      expect(credentials.get(controller.controllerId, worker.id)?.leaseToken).toBe(outcome.leaseToken);
    }
    expect(f.spawn).toHaveBeenCalledTimes(3); // initial Orc, existing worker, successor; no redispatch
    expect(f.inference).not.toHaveBeenCalled(); // deterministic special-turn receipts, no provider
  } finally {
    liveness.dispose(); attention.stop(); await attention.flush(); await f.close();
  }
});
