import { StrigoiControl } from "../orchestration/strigoi-control.js";
import type { StrigoiDeliveryOptions } from "../orchestration/strigoi-delivery.js";
import type { StrigoiContinuityOptions } from "../orchestration/strigoi-continuity.js";
import type { OrchestratorBindingRepository, ThreadTranscriptReader } from "../orchestration/persistence-ports.js";
import type { WorkerTurnTranscriptPort } from "../orchestration/session/worker-turn-ports.js";
import type { OrchestratorAttention } from "../domain/orchestrator-attention.js";
import { orchestratorController } from "../domain/orchestrator.js";
import { StrigoiContinuity } from "../orchestration/strigoi-continuity.js";
import { StrigoiWorkerRecovery } from "../orchestration/strigoi-worker-recovery.js";
import { StrigoiDelivery } from "../orchestration/strigoi-delivery.js";
import { StrigoiDemand } from "../orchestration/strigoi-demand.js";
import { StrigoiTurns } from "../orchestration/strigoi-turns.js";
import type { InstructionQueue } from "../orchestration/instruction-queue.js";
import type { WorkflowService } from "../orchestration/workflow-service.js";
import type { WorkerControlService } from "../orchestration/worker-control-service.js";
import type { OrchestratorAttentionControlPlane } from "../orchestration/orchestrator-attention-control.js";
import type { WorkerCoordinationService } from "./worker-coordination.js";
import type { WorkerLeaseCredentialCustodian } from "./worker-lease-credential-custodian.js";
import type { StrigoiAdmission } from "../orchestration/strigoi-admission.js";
import type { AgentActivityPort } from "../orchestration/agent-activity-port.js";
import { composeStrigoiRuntime } from "./strigoi-runtime.js";

/** Complete internal composition. Construct before queue.start; start only after broker listen. */
export async function composeProductionStrigoi(o: {
  evidence: Pick<StrigoiContinuityOptions, "packets" | "sources"> & {
    orchestratorStore: OrchestratorBindingRepository & { strigoi: StrigoiContinuityOptions["repository"] };
    attentionStore: { list(): Promise<OrchestratorAttention[]> };
    verify(): Promise<void>; beforeDelete(id: string): Promise<void>; withDeletion<T>(id: string, commit: () => Promise<T>): Promise<T>;
    turnPrompt: ConstructorParameters<typeof StrigoiTurns>[2];
    observeInstruction: NonNullable<StrigoiDeliveryOptions["observeInstruction"]>;
  }; transcripts: ThreadTranscriptReader & WorkerTurnTranscriptPort;
  registry: Parameters<typeof composeStrigoiRuntime>[0]["registry"];
  manager: Parameters<typeof composeStrigoiRuntime>[0]["manager"] & Pick<import("../orchestration/orchestrator-manager.js").OrchestratorManager, "validateResidentSelection">; admission: StrigoiAdmission;
  instructions: InstructionQueue; workflows: WorkflowService; workerControl: WorkerControlService;
  attention: OrchestratorAttentionControlPlane; coordination: WorkerCoordinationService;
  credentials: WorkerLeaseCredentialCustodian; activity: AgentActivityPort;
  onError?: (error: unknown) => void;
}) {
  const { orchestratorStore: bindings, packets, sources } = o.evidence, repository = bindings.strigoi;
  const shared = { repository, bindings, admission: o.admission, packets, sources };
  const continuity = new StrigoiContinuity(shared);
  const workers = new StrigoiWorkerRecovery({ ...shared, workers: o.workerControl, attention: o.attention });
  const demand = new StrigoiDemand({ repository, transcripts: o.transcripts,
    subjects: () => o.coordination.listSubjects(), waits: () => o.evidence.attentionStore.list(),
    completionTurns: async id => {
      if (!o.transcripts.readCompletionLedger) throw new Error("STRIGOI_COMPLETION_EVIDENCE_UNAVAILABLE");
      return (await o.transcripts.readCompletionLedger(id)).canonicalTurns;
    } });
  const delivery = new StrigoiDelivery({ repository, bindings, admission: o.admission, registry: o.registry,
    instructions: o.instructions, workflows: o.workflows, demand: async identity => (await demand.evidence(identity)).length > 0,
    observeInstruction: o.evidence.observeInstruction,
    authorizeWorker: async (actor, target, apply) => {
      const binding = await bindings.findBySessionId(actor);
      if (!binding) throw Object.assign(new Error("ACTOR_NOT_AUTHORIZED"), { code: "ACTOR_NOT_AUTHORIZED" });
      const controller = orchestratorController(binding), subject = o.coordination.getSubject(target);
      const credential = o.credentials.get(controller.controllerId, target);
      if (!subject || !credential || subject.lease.controller?.controllerId !== controller.controllerId
        || subject.lease.state !== "active" || subject.lease.version !== credential.leaseVersion) {
        throw Object.assign(new Error("OWNERSHIP_LOST"), { code: "OWNERSHIP_LOST" });
      }
      return o.coordination.withInstructionAuthority(target, controller, credential.leaseToken, credential.leaseVersion, apply);
    } });
  const turns = new StrigoiTurns(o.registry, o.transcripts, o.evidence.turnPrompt);
  const runtime = await composeStrigoiRuntime({ ...shared, registry: o.registry, manager: o.manager, continuity,
    verifyContinuity: o.evidence.verify, beforeDelete: o.evidence.beforeDelete, withDeletion: o.evidence.withDeletion,
    ...(o.onError ? { onError: o.onError } : {}),
    succession: { packets, sources, turns, workers, delivery, activity: o.activity } });
  const control = new StrigoiControl({ repository, registry: o.registry, admission: o.admission, lifecycle: runtime.lifecycle, continuity, succession: runtime.succession!, delivery, validateSelection: s => o.manager.validateResidentSelection(s) });
  return { ...runtime, control, delivery, demand, turns, packets, sources };
}
