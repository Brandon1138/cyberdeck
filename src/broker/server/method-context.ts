import { z } from "zod";
import { SubmitJobParamsSchema, type JobControlPlane } from "../../control-plane/job-control-plane.js";
import { StartSessionRequestSchema } from "../../domain/session.js";
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
import type { RequestFrame } from "../protocol/frames.js";
import type { AttachmentMode } from "../session-registry.js";
import type { WorkerEventChannel } from "../worker-event-channel.js";
import type { BrokerServerOptions, ConnectionContext } from "./options.js";
import type {
  FleetDetachRecordPort,
  FleetPreferenceReadPort,
  ScoutEgressPort,
  ThreadTranscriptReadPort,
} from "./store-ports.js";

/**
 * What one RPC method handler is handed.
 *
 * The stateful half of the server — the socket a frame arrived on, the attachment leases that
 * outlive the request — stays behind this interface, so a handler group can be read without
 * reading the transport and cannot reach into it sideways. Everything else a handler needs is
 * resolved from {@link BrokerServerOptions} by the functions below.
 */
export interface BrokerMethodContext {
  readonly options: BrokerServerOptions;
  attach(
    context: ConnectionContext,
    sessionId: string,
    mode: AttachmentMode,
    detachIdentity?: string,
  ): Promise<unknown>;
  subscribeLocalWorkerTelemetry(context: ConnectionContext): void;
  unsubscribeLocalWorkerTelemetry(context: ConnectionContext): void;
}

/**
 * One method, one function. The registry in `methods.ts` is keyed by the wire method name, so a
 * name that is not there is `METHOD_NOT_FOUND` exactly as the switch's `default` was.
 */
export type BrokerMethodHandler = (
  server: BrokerMethodContext,
  context: ConnectionContext,
  frame: RequestFrame,
) => Promise<unknown>;

export function requireControlPlane(options: BrokerServerOptions): JobControlPlane {
  if (options.controlPlane === undefined) {
    throw Object.assign(new Error("Control plane is not available"), { code: "METHOD_NOT_FOUND" });
  }
  return options.controlPlane;
}

/**
 * `session.start`/`session.startWithPrompt` is the composer path: the operator launches and
 * drives it by hand. It is always eloquent, regardless of the box `caveman-workers` preference
 * — that preference scopes orchestrator spawns (`AgentControlService.startWorker`) only
 * (MIK-79). An explicit `workerMode` on the request still wins, unchanged from before.
 */
export function withSessionWorkerMode<T extends z.infer<typeof StartSessionRequestSchema>>(request: T): T {
  if ((request.kind ?? "worker") !== "worker" || request.workerMode !== undefined) return request;
  return { ...request, workerMode: "normal" };
}

export async function withJobWorkerMode<T extends z.infer<typeof SubmitJobParamsSchema>["request"]>(
  options: BrokerServerOptions,
  request: T,
): Promise<T> {
  if (request.workerMode !== undefined) return request;
  const preferences = await options.workerPreferences?.get();
  return {
    ...request,
    workerMode: preferences?.caveman === true ? "caveman" : "normal",
  };
}

export function requireTranscripts(options: BrokerServerOptions): ThreadTranscriptReadPort {
  if (options.transcripts === undefined) {
    throw Object.assign(new Error("Thread transcript store is not available"), { code: "METHOD_NOT_FOUND" });
  }
  return options.transcripts;
}

export function requireOrchestrators(options: BrokerServerOptions): OrchestratorManager {
  if (options.orchestrators === undefined) {
    throw Object.assign(new Error("Orchestrator manager is not available"), { code: "METHOD_NOT_FOUND" });
  }
  return options.orchestrators;
}

export function requireAgentControl(options: BrokerServerOptions): AgentControlService {
  if (options.agentControl === undefined) {
    throw Object.assign(new Error("Agent control service is not available"), { code: "METHOD_NOT_FOUND" });
  }
  return options.agentControl;
}

export function requireNvimBindings(options: BrokerServerOptions): NvimBindingService {
  if (options.nvimBindings === undefined) {
    throw Object.assign(new Error("nvim binding registry is not available"), {
      code: "METHOD_NOT_FOUND",
    });
  }
  return options.nvimBindings;
}

export function requireLocalWorkerControl(options: BrokerServerOptions): LocalWorkerControlService {
  if (options.localWorkerControl === undefined) {
    throw Object.assign(new Error("Local worker control is not available"), {
      code: "METHOD_NOT_FOUND",
    });
  }
  return options.localWorkerControl;
}

export function requireScoutEgress(options: BrokerServerOptions): ScoutEgressPort {
  if (options.scoutEgress === undefined) {
    throw Object.assign(new Error("Scout egress grant store is not available"), {
      code: "METHOD_NOT_FOUND",
    });
  }
  return options.scoutEgress;
}

export function requireInstructions(options: BrokerServerOptions): InstructionQueue {
  if (options.instructions === undefined) {
    throw Object.assign(new Error("Instruction queue is not available"), { code: "METHOD_NOT_FOUND" });
  }
  return options.instructions;
}

export function requireWorkerControl(options: BrokerServerOptions): WorkerControlService {
  if (options.workerControl === undefined) {
    throw Object.assign(new Error("Worker control service is not available"), { code: "METHOD_NOT_FOUND" });
  }
  return options.workerControl;
}

export function requireWorkerHandoff(options: BrokerServerOptions): WorkerHandoffService {
  if (options.workerHandoff === undefined) {
    throw Object.assign(new Error("Worker handoff service is not available"), { code: "METHOD_NOT_FOUND" });
  }
  return options.workerHandoff;
}

export function requireWorkflows(options: BrokerServerOptions): WorkflowService {
  if (options.workflows === undefined) {
    throw Object.assign(new Error("Workflow service is not available"), { code: "METHOD_NOT_FOUND" });
  }
  return options.workflows;
}

export function requireWorkerEvents(options: BrokerServerOptions): WorkerEventChannel {
  if (options.workerEvents === undefined) {
    throw Object.assign(new Error("Worker event channel is not available"), {
      code: "METHOD_NOT_FOUND",
    });
  }
  return options.workerEvents;
}

export function requireWorkerCapabilities(options: BrokerServerOptions): WorkerCapabilityCatalog {
  if (options.workerCapabilities === undefined) {
    throw Object.assign(new Error("Worker capability catalog is not available"), {
      code: "METHOD_NOT_FOUND",
    });
  }
  return options.workerCapabilities;
}

export function requireFleetPreferences(options: BrokerServerOptions): FleetPreferenceReadPort {
  if (options.fleetPreferences === undefined) {
    throw Object.assign(new Error("Fleet preferences are not available"), { code: "METHOD_NOT_FOUND" });
  }
  return options.fleetPreferences;
}

export function requireFleetProjects(options: BrokerServerOptions): FleetProjectService {
  if (options.fleetProjects === undefined) {
    throw Object.assign(new Error("Fleet project registry is not available"), {
      code: "METHOD_NOT_FOUND",
    });
  }
  return options.fleetProjects;
}

export function requireFleetDetaches(options: BrokerServerOptions): FleetDetachRecordPort {
  if (options.fleetDetaches === undefined) {
    throw Object.assign(new Error("Fleet detach history is not available"), { code: "METHOD_NOT_FOUND" });
  }
  return options.fleetDetaches;
}
