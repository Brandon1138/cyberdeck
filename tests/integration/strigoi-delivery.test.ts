import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { successionFixture } from "../orchestration/strigoi-succession-fixture.js";
import { composeProductionStrigoi } from "../../src/broker/strigoi-production.js";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { WorkflowService } from "../../src/orchestration/workflow-service.js";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import { ObservedWorkerCoordinationService } from "../../src/broker/observed-worker-coordination.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../../src/broker/worker-lease-credential-custodian.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";
import { OrchestratorNotificationStore } from "../../src/persistence/orchestrator-notification-store.js";
import { OrchestratorAttentionControlPlane } from "../../src/orchestration/orchestrator-attention-control.js";
import { OrchestratorSessionLiveness } from "../../src/orchestration/orchestrator-session-liveness.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";
import { WorkerControlService } from "../../src/orchestration/worker-control-service.js";
import { orchestratorController } from "../../src/domain/orchestrator.js";

it.each(["routine", "workflow", "workflow-participant", "passive", "transfer"] as const)("runs the actual production composition with native turns and real worker/delivery participants (%s)", async mode => {
  const f = await successionFixture(true); f.runtime.dispose();
  const coordination = new ObservedWorkerCoordinationService({ store: new WorkerCoordinationStore(f.root) }); await coordination.initialize();
  const credentials = new BrokerWorkerLeaseCredentialCustodian();
  const inbox = new OrchestratorNotificationStore(f.root); await inbox.load();
  const admission = f.runtime.admission;
  const attention = new OrchestratorAttentionControlPlane({ store: f.evidence.attentionStore, bindings: f.bindings,
    resident: f.bindings.strigoi, strigoi: admission, registry: f.registry, coordination, transcripts: f.transcripts, inbox });
  const liveness = new OrchestratorSessionLiveness({ directory: new OrchestratorControllerDirectory(f.bindings), registry: f.registry,
    coordination, custody: { credentials, subjects: coordination }, withAuthority: work => f.bindings.withAuthority(work), onError: error => { throw error; } });
  const instructions = new InstructionQueue(f.registry, f.bindings, f.evidence.instructionStore, undefined, admission);
  const workers = new WorkerControlService({ coordination, credentials, registry: f.registry, orchestrators: f.bindings, instructions, strigoi: admission, residentLiveness: liveness });
  const workflows = new WorkflowService(f.registry, f.bindings, f.evidence.workflowStore, instructions, admission);
  const owner = f.original.activeBinding!, controller = orchestratorController(owner);
  let workerId: string | undefined, gapInput: string | undefined;
  const responses = new Set<string>(), messages: string[] = [];
  const respond = async (sessionId: string, text: string, turnNumber: number) => {
    const turns = f.nativeResults.get(sessionId) ?? [];
    turns.push({ providerTurnId: randomUUID(), providerOccurredAt: new Date().toISOString(), text, transport: "provider-native" });
    f.nativeResults.set(sessionId, turns);
    const response = await f.registry.waitForWorkerResults([{ sessionId, completionTarget: turnNumber }], 5000);
    expect(response.timedOut, JSON.stringify(response)).toBe(false);
  };
  const manager = new OrchestratorManager(f.registry, f.bindings, undefined, { list: async () => ({ codex: "automatic" }) }, async () => [], async (binding, session) => {
    await attention.bindingChanged(binding); await liveness.bindingSession(binding, session);
    if (binding.sessionId !== owner.sessionId && workerId && !gapInput) {
      gapInput = randomUUID(); await runtime.delivery.submit("Input accepted during cutover", gapInput);
      await respond(workerId, "Worker result during cutover", 1);
    }
  });
  const runtime = await composeProductionStrigoi({ evidence: f.evidence, registry: f.registry, transcripts: f.transcripts,
    manager, admission, instructions, workflows, workerControl: workers, attention, coordination, credentials, activity: f.activity });
  vi.spyOn(runtime.lifecycle, "wakeSuccession").mockImplementation(() => {});
  let transferOnSubmit = false;
  const submit = f.registry.submitInstruction.bind(f.registry);
  vi.spyOn(f.registry, "submitInstruction").mockImplementation(async (...args) => {
    if (transferOnSubmit && args[1] === "Queued follow-up for the worker") {
      transferOnSubmit = false;
      const recipient = orchestratorController({ ...owner, key: `fleet:peer:${workerId}`, kind: "peer", resident: undefined,
        sessionId: workerId!, grant: { ...owner.grant, subjectSessionId: workerId! } });
      await coordination.handoffBatch({ mutationId: randomUUID(), actor: controller, recipient, recipientSessionId: workerId!,
        directive: "Operator transfer wins", members: [{ subjectId: workerId! }], reason: "transfer during final preflight" });
    }
    const result = await submit(...args);
    if (result.state !== "rendered" || responses.has(args[4]!)) return result;
    responses.add(args[4]!); messages.push(args[1]);
    if (args[3]?.successionKind) {
      const path = JSON.parse(args[1].match(/page at ("[^"\n]+")./)![1]!) as string;
      const coverage: string[] = []; let next: string | undefined = path;
      while (next) {
        const page = JSON.parse(await readFile(next, "utf8"));
        expect(page.sources.length).toBeLessThanOrEqual(64);
        expect(Buffer.byteLength(page.sources.map((s: { text: string }) => s.text).join(""))).toBeLessThanOrEqual(32768);
        coverage.push(...page.sources.map((s: { coverageSourceId: string }) => s.coverageSourceId)); next = page.nextPath;
      }
      const s = await f.bindings.strigoi.read();
      await respond(args[0], JSON.stringify(args[3].successionKind === "checkpoint"
        ? { checkpoint: "Preserve the operator question and review the worker result." }
        : { identity: s.transition!.successor, packetHash: s.transition!.packet!.sha256,
          coverageId: s.transition!.packet!.coverageId, handledSourceIds: coverage, account: "Read original pages; continue queued input and review worker result." }), result.expectedTurn!);
    }
    return result;
  });
  try {
    await liveness.start(); await attention.start(); instructions.start(); await runtime.lifecycle.reconcile();
    expect(runtime.integration).toBe("composed");
    if (mode === "passive") {
      f.emitExit(); await liveness.flush(); await runtime.lifecycle.reconcile();
      let state = await f.bindings.strigoi.read();
      for (let i = 0; i < 4; i++) await runtime.succession!.advance(state.transition!.id);
      state = await f.bindings.strigoi.read();
      expect(state.transition).toMatchObject({ phase: "adopting", adoptionDeferred: true });
      expect(state.hold).toBeUndefined(); expect(messages).toEqual([]);
      expect(await runtime.demand.evidence(state.transition!.successor!)).toEqual([]);
      expect(await runtime.delivery.needsAdoption(state.transition!.successor!, state.transition!.packet!)).toBe(false);
      const id = randomUUID(); await runtime.delivery.submit("Durable work after passive recovery", id);
      expect(await runtime.delivery.needsAdoption(state.transition!.successor!, state.transition!.packet!)).toBe(true);
      for (let i = 0; i < 5; i++) await runtime.succession!.advance(state.transition!.id);
      state = await f.bindings.strigoi.read();
      expect(state.transition?.phase).toBe("complete"); expect(state.hold).toBeUndefined();
      expect(messages.filter(m => m === "Durable work after passive recovery")).toHaveLength(1);
      expect(f.spawn).toHaveBeenCalledTimes(2);
      return;
    }
    const conversation = await runtime.delivery.submit("Alfred, retain this unresolved question", randomUUID());
    expect(conversation.status, JSON.stringify({ conversation, truth: f.registry.workerTruth(owner.sessionId), state: await f.bindings.strigoi.read() })).toBe("rendered");
    await respond(owner.sessionId, "Question retained; awaiting worker result", 1); await instructions.flush(owner.sessionId);
    const worker = await f.registry.start({ provider: "codex", cwd: f.root, detached: true, sandbox: "workspace-write" }); workerId = worker.id;
    const registration = await coordination.registerSubject({ mutationId: randomUUID(), actor: controller, subjectId: worker.id, controller, lifecycle: "working", reason: "fixture existing work",
      origin: { creatorControllerId: controller.controllerId, creatorSessionId: owner.sessionId, taskId: worker.id, threadId: worker.id, createdAt: worker.createdAt },
      resources: { sessionId: worker.id, worktreePath: f.root, eventStreamId: worker.id } });
    const lease = registration.outcomes[0]!;
    credentials.set(controller.controllerId, worker.id, { leaseVersion: lease.leaseVersion!, leaseToken: lease.leaseToken! });
    await f.registry.attach(worker.id, "operator", "control", () => {});
    const outgoing = await instructions.enqueue({ actorSessionId: owner.sessionId, targetSessionId: worker.id, message: "Queued follow-up for the worker" });
    expect(outgoing.status).toBe("queued");
    await attention.arm({ actorSessionId: owner.sessionId, mutationId: randomUUID(), objective: "Review worker", nextAction: "Read exact result", targets: [{ sessionId: worker.id, completionTarget: 1 }] });
    let workflowIds: string[] | undefined;
    if (mode === "workflow" || mode === "workflow-participant") {
      let workflowOwner = owner.sessionId;
      if (mode === "workflow-participant") {
        const ordinary = await f.registry.start({ provider: "codex", cwd: f.root, kind: "orchestrator", detached: true, sandbox: "read-only" });
        const { resident: _resident, ...base } = owner;
        await f.bindings.put({ ...base, kind: "peer", key: `fleet:peer:${ordinary.id}`, sessionId: ordinary.id,
          grant: { ...base.grant, subjectSessionId: ordinary.id } });
        workflowOwner = ordinary.id;
      }
      const run = await workflows.create({ actorSessionId: workflowOwner, name: "session-bound decision", participantSessionIds: [owner.sessionId, worker.id] });
      const message = await workflows.send({ actorSessionId: mode === "workflow-participant" ? workflowOwner : worker.id,
        runId: run.id, targetSessionId: owner.sessionId, text: "Reply needed from old participant", wake: false });
      workflowIds = [run.id, message.messageId, owner.sessionId];
    }
    const transition = await runtime.succession!.renew(1, "routine continuation", "actual-production-renewal");
    for (let i = 0; i < 6; i++) await runtime.succession!.advance(transition.id);
    const state = await f.bindings.strigoi.read();
    expect(state.hold).toBeUndefined(); expect(state.transition?.phase).toBe("complete");
    if (workflowIds) expect(state.continuationHolds).toEqual([expect.objectContaining({ code: "STRIGOI_WORKFLOW_CONTINUATION_REQUIRED", sourceIds: workflowIds })]);
    transferOnSubmit = mode === "transfer";
    await f.registry.detach(worker.id, "operator"); await instructions.flush(worker.id);
    expect(messages.filter(m => m === "Queued follow-up for the worker")).toHaveLength(mode === "transfer" ? 0 : 1);
    expect(messages.filter(m => m === "Input accepted during cutover")).toHaveLength(1);
    const records = await instructions.list();
    expect(records.find(r => r.id === outgoing.id)).toMatchObject({ actorSessionId: owner.sessionId, continuations: [expect.objectContaining({ effectiveActorSessionId: state.activeBinding!.sessionId })] });
    expect((await runtime.delivery.submit("Input accepted during cutover", gapInput!)).id).toBe(records.find(r => r.messageId === gapInput)!.id);
    if (mode === "transfer") {
      expect(records.find(r => r.id === outgoing.id)).toMatchObject({ status: "queued", holdReason: "OWNERSHIP_LOST" });
      return;
    }
    const wait = (await f.evidence.attentionStore.get(controller.controllerId))!;
    expect(wait.actorSessionId).toBe(state.activeBinding!.sessionId);
    expect((await attention.readPage(wait.actorSessionId, wait.epoch, [], 1200)).workers[0]?.completion?.text).toBe("Worker result during cutover");
    expect(f.spawn).toHaveBeenCalledTimes(mode === "workflow-participant" ? 4 : 3);
    expect(f.turns.submit).not.toHaveBeenCalled(); expect(f.workers.reconcile).not.toHaveBeenCalled(); expect(f.delivery.reconcile).not.toHaveBeenCalled();
  } finally { runtime.dispose(); instructions.stop(); await instructions.drain(); attention.stop(); await attention.flush(); liveness.dispose(); await f.close(); }
}, 30000);
