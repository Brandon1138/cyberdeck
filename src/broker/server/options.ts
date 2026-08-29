import type { Socket } from "node:net";
import type { JobControlPlane } from "../../control-plane/job-control-plane.js";
import type { ControlPlaneRuntime } from "../../control-plane/runtime.js";
import type { LocalWorkerTelemetrySnapshot } from "../../domain/local-worker-control.js";
import type { AgentControlService } from "../../orchestration/agent-control-service.js";
import type { InstructionQueue } from "../../orchestration/instruction-queue.js";
import type { LocalWorkerControlService } from "../../orchestration/local-worker-control-service.js";
import type { OrchestratorManager } from "../../orchestration/orchestrator-manager.js";
import type { WorkerCapabilityCatalog } from "../../orchestration/worker-capability-catalog.js";
import type { WorkerControlService } from "../../orchestration/worker-control-service.js";
import type { WorkerHandoffService } from "../../orchestration/worker-handoff-service.js";
import type { WorkflowService } from "../../orchestration/workflow-service.js";
import type { FleetProjectService } from "../fleet-project-service.js";
import type { NvimBindingService } from "../nvim-binding-service.js";
import type { AttachmentMode, SessionRegistry } from "../session-registry.js";
import type { WorkerCoordinationService } from "../worker-coordination.js";
import type { WorkerEventChannel } from "../worker-event-channel.js";
import type {
  FleetDetachRecordPort,
  FleetPreferenceReadPort,
  OrchestratorBindingListPort,
  ScoutEgressPort,
  ThreadTranscriptReadPort,
  WorkerPreferenceReadPort,
} from "./store-ports.js";

export interface ConnectionContext {
  id: string;
  socket: Socket;
  attachments: Map<string, {
    mode: AttachmentMode;
    detachIdentity?: string | undefined;
  }>;
  localWorkerTelemetry?: {
    unsubscribe: () => void;
    lastSentAt: number;
    pending?: LocalWorkerTelemetrySnapshot;
    timer?: ReturnType<typeof setTimeout>;
  };
}
export interface BrokerServerOptions {
  socketPath: string;
  registry: SessionRegistry;
  transcripts?: ThreadTranscriptReadPort;
  orchestrators?: OrchestratorManager;
  agentControl?: AgentControlService;
  instructions?: InstructionQueue;
  workflows?: WorkflowService;
  controlPlane?: JobControlPlane;
  /** Supplies the reconciliation view; queue/budget queries work from the control plane alone. */
  controlPlaneRuntime?: Pick<ControlPlaneRuntime, "lastReconciliation">;
  fleetDetaches?: FleetDetachRecordPort;
  fleetPreferences?: FleetPreferenceReadPort;
  /** Which repositories the operator calls projects. The Fleet list groups by these. */
  fleetProjects?: FleetProjectService;
  workerPreferences?: WorkerPreferenceReadPort;
  /**
   * What each provider currently says it can launch. One catalog serves Fleet's composer, the
   * `cyberdeck_provider_capabilities` tool, and the launch boundary, so those three cannot disagree
   * about which models exist.
   */
  workerCapabilities?: WorkerCapabilityCatalog;
  scoutEgress?: ScoutEgressPort;
  orchestratorBindings?: OrchestratorBindingListPort;
  /** Internal domain substrate. Orchestrator access goes through workerControl, never directly. */
  workerCoordination?: WorkerCoordinationService;
  workerControl?: WorkerControlService;
  /** Operator-directed batch lease handoff. Fleet's surface, never an orchestrator's. */
  workerHandoff?: WorkerHandoffService;
  workerEvents?: WorkerEventChannel;
  /** Which nvim is showing which worker's worktree. In memory only, by design. */
  nvimBindings?: NvimBindingService;
  /** Versioned same-user read/control boundary for native local clients. */
  localWorkerControl?: LocalWorkerControlService;
  onShutdown?: () => void;
}
