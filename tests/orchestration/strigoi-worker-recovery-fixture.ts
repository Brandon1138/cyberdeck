import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../../src/broker/worker-lease-credential-custodian.js";
import { orchestratorController } from "../../src/domain/orchestrator.js";
import type { StrigoiState } from "../../src/domain/strigoi.js";
import { composeStrigoiEvidence } from "../../src/persistence/strigoi-evidence-runtime.js";
import { StrigoiAdmission } from "../../src/orchestration/strigoi-admission.js";
import { WorkerControlService } from "../../src/orchestration/worker-control-service.js";
import { StrigoiWorkerRecovery } from "../../src/orchestration/strigoi-worker-recovery.js";
import { OrchestratorAttentionControlPlane } from "../../src/orchestration/orchestrator-attention-control.js";
import { OrchestratorSessionLiveness } from "../../src/orchestration/orchestrator-session-liveness.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";
import { ACTOR, WORKER, OTHER, NOW, attentionHarness } from "../support/attention-harness.js";

export const NEXT = "44444444-4444-4444-8444-444444444444";
export const nextIdentity = { sessionId: NEXT, incarnation: 2, generation: 1 };
export async function recoveryFixture() {
  let nowMs = Date.parse(NOW);
  const now = () => new Date(nowMs).toISOString();
  const f = await attentionHarness({ resident: true, now });
  f.attention.stop(); await f.attention.flush();
  const evidence = composeStrigoiEvidence(f.directory), bindings = evidence.orchestratorStore, repository = bindings.strigoi, store = evidence.attentionStore;
  const mutate = (patch: Partial<StrigoiState>) => bindings.withAuthority(async () => {
    const state = await repository.read();
    return repository.compareAndSwap(state.revision, randomUUID(), { ...state, ...patch, revision: state.revision + 1, updatedAt: now() });
  });
  await mutate({ desired: "enabled", incarnation: 1, activeGeneration: 1, activeBinding: f.bound,
    retainedSessionIds: [ACTOR], selection: { provider: "codex", model: "test", cwd: "/repo" } });
  f.records.set(NEXT, { ...f.records.get(ACTOR)!, id: NEXT });
  f.truths.set(NEXT, { ...f.truths.get(ACTOR)!, state: "idle" });
  const registry = { ...f.registry, ownsProcess: () => true, stopRequestedAt: () => undefined,
    stop: vi.fn(async () => f.registry.get(WORKER)), forceStop: vi.fn<() => void>(), answerWorkerModal: vi.fn<() => void>() };
  const admission = new StrigoiAdmission(repository, bindings, registry);
  const credentials = new BrokerWorkerLeaseCredentialCustodian();
  for (const id of [WORKER, OTHER]) credentials.set(f.controller.controllerId, id, { leaseVersion: 1, leaseToken: f.tokens.get(id)! });
  const instructions = { enqueue: vi.fn<InstructionQueue["enqueue"]>() };
  const makeWorkers = (custody = credentials) => new WorkerControlService({ coordination: f.coordination,
    residentLiveness: { bindingSession: (...args) => liveness.bindingSession(...args) },
    registry: registry as never, orchestrators: bindings, credentials: custody, strigoi: admission, instructions, now: () => nowMs });
  const workers = makeWorkers();
  const makeAttention = () => {
    const control = new OrchestratorAttentionControlPlane({ ...f.controlOptions, store, bindings, resident: repository,
      strigoi: admission, registry, now });
    f.controls.push(control); return control;
  };
  const attention = makeAttention(); await attention.start();
  const packets = evidence.packets;
  const makeRecovery = (service = workers, control = attention) => new StrigoiWorkerRecovery({
    repository, packets, admission, workers: service, attention: control });
  const liveness = new OrchestratorSessionLiveness({ directory: new OrchestratorControllerDirectory(bindings),
    registry, coordination: f.coordination, custody: { credentials, subjects: f.coordination },
    withAuthority: (work) => bindings.withAuthority(work), onError: (e) => f.errors.push(e) });
  await liveness.start();
  const transitionId = randomUUID();
  const successor = { ...f.bound, sessionId: NEXT, resident: { name: "strigoi" as const, incarnation: 2 },
    grant: { ...f.bound.grant, subjectSessionId: NEXT } };
  async function seal() {
    const refs = await packets.copy({ kind: "worker-event", id: `ownership:${WORKER}`, revision: "captured" },
      JSON.stringify(f.coordination.getSubject(WORKER)), [WORKER]);
    const wait = await store.get(f.controller.controllerId);
    if (wait) refs.push(...await packets.copy({ kind: "attention", id: wait.epoch, revision: "captured" }, JSON.stringify(wait), [ACTOR, WORKER]));
    const packet = await packets.write({ sessionId: ACTOR, incarnation: 1, generation: 1 }, "Continue the owned work", refs, now());
    await admission.freeze({ sessionId: ACTOR, incarnation: 1, generation: 1 });
    await mutate({ transition: { id: transitionId, expectedIncarnation: 1, predecessor: { sessionId: ACTOR, incarnation: 1, generation: 1 },
      successor: nextIdentity, phase: "sealed", packet, reason: "renew", attempts: 0 } });
    return packet;
  }
  async function cutover() {
    const state = await repository.read();
    await mutate({ activeBinding: successor, activeGeneration: 1, incarnation: 2, retainedSessionIds: [ACTOR, NEXT],
      latestPacket: state.transition!.packet!, transition: { ...state.transition!, phase: "committed" } });
    await mutate({ transition: { ...state.transition!, phase: "reconciling" } });
    await attention.bindingChanged(successor);
    await liveness.bindingSession(successor, registry.get(NEXT));
  }
  async function death() {
    f.records.set(ACTOR, { ...f.records.get(ACTOR)!, exitCode: 0, executionState: "exited" });
    f.emit(ACTOR); await liveness.flush(); await attention.flush();
  }
  async function transfer() {
    const peer = { ...f.bound, sessionId: OTHER, key: `fleet:peer:${OTHER}`, kind: "peer" as const,
      resident: undefined, grant: { ...f.bound.grant, subjectSessionId: OTHER } };
    const { resident: _resident, ...binding } = peer;
    await bindings.put(binding);
    const controller = orchestratorController(binding);
    await f.coordination.handoffBatch({ mutationId: randomUUID(), actor: f.controller, recipient: controller,
      recipientSessionId: OTHER, directive: "Transferred by operator", members: [{ subjectId: WORKER }], reason: "transfer" });
    return controller;
  }
  return { ...f, store, evidence, registry, bindings, repository, mutate, admission, credentials, workers, makeWorkers, attention, makeAttention,
    packets, makeRecovery, recovery: makeRecovery(), liveness, seal, cutover, death, transfer, successor, transitionId, now,
    advance: (ms: number) => { nowMs += ms; }, instructions };
}
