import { OrchestratorPeerService, type OrchestratorPeerServiceDeps } from "../orchestration/orchestrator-peer-service.js";
import { WorkerControlService, type WorkerControlOptions } from "../orchestration/worker-control-service.js";
import { WorkflowService } from "../orchestration/workflow-service.js";
import type { WorkflowRepository } from "../orchestration/persistence-ports.js";
import type { InstructionQueue } from "../orchestration/instruction-queue.js";
import type { StrigoiAdmission } from "../orchestration/strigoi-admission.js";

/** Composition only: these services must receive the same barrier as attention and instructions. */
export function composeOrchestratorMutationServices(options: {
  workflowStore: WorkflowRepository;
  registry: WorkerControlOptions["registry"];
  orchestratorStore: OrchestratorPeerServiceDeps["bindings"];
  orchestrators: OrchestratorPeerServiceDeps["manager"];
  instructions: InstructionQueue;
  journal: NonNullable<OrchestratorPeerServiceDeps["audit"]>;
  coordination: WorkerControlOptions["coordination"];
  workerLeaseCredentials: NonNullable<WorkerControlOptions["credentials"]>;
  modalAnswerPolicy: NonNullable<WorkerControlOptions["modalPolicy"]>;
  strigoiAdmission: StrigoiAdmission;
}) {
  const { registry, orchestratorStore, instructions, strigoiAdmission: strigoi } = options;
  return {
    orchestratorPeers: new OrchestratorPeerService({ registry, bindings: orchestratorStore,
      manager: options.orchestrators, instructions, audit: options.journal, strigoi }),
    workerControl: new WorkerControlService({ registry, orchestrators: orchestratorStore, instructions,
      coordination: options.coordination, credentials: options.workerLeaseCredentials,
      modalPolicy: options.modalAnswerPolicy, strigoi }),
    workflows: new WorkflowService(registry, orchestratorStore,
      options.workflowStore, instructions, strigoi),
  };
}
