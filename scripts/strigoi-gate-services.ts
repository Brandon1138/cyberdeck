import { composeProductionStrigoi } from "../src/broker/strigoi-production.js";
import { StrigoiAdmission } from "../src/orchestration/strigoi-admission.js";
import { InstructionQueue } from "../src/orchestration/instruction-queue.js";
import { WorkflowService } from "../src/orchestration/workflow-service.js";
import { OrchestratorManager } from "../src/orchestration/orchestrator-manager.js";
import { ObservedWorkerCoordinationService } from "../src/broker/observed-worker-coordination.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../src/broker/worker-lease-credential-custodian.js";
import { WorkerCoordinationStore } from "../src/persistence/worker-coordination-store.js";
import { OrchestratorNotificationStore } from "../src/persistence/orchestrator-notification-store.js";
import { OrchestratorAttentionControlPlane } from "../src/orchestration/orchestrator-attention-control.js";
import { OrchestratorSessionLiveness } from "../src/orchestration/orchestrator-session-liveness.js";
import { OrchestratorControllerDirectory } from "../src/orchestration/orchestrator-controller-directory.js";
import { WorkerControlService } from "../src/orchestration/worker-control-service.js";
import type { SessionRegistry } from "../src/broker/session-registry.js";
import type { ThreadTranscriptStore } from "../src/persistence/thread-transcript-store.js";
import type { composeStrigoiEvidence } from "../src/persistence/strigoi-evidence-runtime.js";
import type { AgentActivityStore } from "../src/persistence/agent-activity-store.js";

/** Same production participants/order as broker main; no broker discovery, Fleet or nvim. */
export async function composeGateServices(o: {
  root: string; registry: SessionRegistry; transcripts: ThreadTranscriptStore;
  evidence: ReturnType<typeof composeStrigoiEvidence>; activity: AgentActivityStore;
  readCapabilities?: ConstructorParameters<typeof OrchestratorManager>[4];
  onBinding?: ConstructorParameters<typeof OrchestratorManager>[5];
}) {
  const { registry, evidence, transcripts } = o, bindings = evidence.orchestratorStore;
  const errors: unknown[] = [];
  const admission = new StrigoiAdmission(bindings.strigoi, bindings, registry);
  const coordination = new ObservedWorkerCoordinationService({ store: new WorkerCoordinationStore(o.root) });
  await coordination.initialize();
  const credentials = new BrokerWorkerLeaseCredentialCustodian();
  const inbox = new OrchestratorNotificationStore(o.root); await inbox.load();
  const attention = new OrchestratorAttentionControlPlane({ store: evidence.attentionStore, bindings,
    resident: bindings.strigoi, strigoi: admission, registry, coordination, transcripts, inbox });
  const liveness = new OrchestratorSessionLiveness({ directory: new OrchestratorControllerDirectory(bindings), registry,
    coordination, custody: { credentials, subjects: coordination }, withAuthority: work => bindings.withAuthority(work), onError: e => errors.push(e) });
  const instructions = new InstructionQueue(registry, bindings, evidence.instructionStore, undefined, admission);
  const workers = new WorkerControlService({ coordination, credentials, registry, orchestrators: bindings, instructions, strigoi: admission, residentLiveness: liveness });
  const workflows = new WorkflowService(registry, bindings, evidence.workflowStore, instructions, admission);
  const manager = new OrchestratorManager(registry, bindings, undefined, { list: async () => ({ codex: "automatic" }) }, o.readCapabilities, async (binding, session) => {
    await attention.bindingChanged(binding); await liveness.bindingSession(binding, session); await o.onBinding?.(binding, session);
  });
  // composeProductionStrigoi quiesces resident delivery before any queue starts.
  const runtime = await composeProductionStrigoi({ evidence, registry, transcripts, manager, admission,
    instructions, workflows, workerControl: workers, attention, coordination, credentials, activity: o.activity, onError: e => errors.push(e) });
  return { runtime, admission, coordination, credentials, attention, liveness, instructions, workflows, workers, manager, errors,
    start: async (automaticLifecycle = false) => { await liveness.start(); await attention.start(); instructions.start(); if (automaticLifecycle) runtime.start(); },
    close: async () => { runtime.dispose(); instructions.stop(); await instructions.drain(); attention.stop(); await attention.flush(); liveness.dispose(); },
  };
}
