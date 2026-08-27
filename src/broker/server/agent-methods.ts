import { z } from "zod";
import {
  AgentActorParamsSchema,
  AgentInspectOrchestratorParamsSchema,
  AgentListThreadsParamsSchema,
  AgentReadParamsSchema,
  AgentReadScoutArtifactParamsSchema,
  AgentStartWorkerParamsSchema,
  AgentStartWorkersParamsSchema,
  AgentStopOrchestratorParamsSchema,
  AgentWaitWorkersParamsSchema,
} from "../../orchestration/agent-control-service.js";
import { EnqueueInstructionParamsSchema } from "../../orchestration/instruction-queue.js";
import {
  AgentLeaseParamsSchema,
  AgentWorkerControlParamsSchema,
  AgentWorkerEventsParamsSchema,
} from "../../orchestration/worker-control-service.js";
import {
  CreateWorkflowParamsSchema,
  SendWorkflowMessageParamsSchema,
  WorkflowActorParamsSchema,
  WorkflowChangesParamsSchema,
  WorkflowRunActorParamsSchema,
} from "../../orchestration/workflow-service.js";
import {
  WorkerCheckpointRequestParamsSchema,
  WorkerEventSubmitParamsSchema,
} from "../worker-event-channel.js";
import {
  type BrokerMethodHandler,
  requireAgentControl,
  requireInstructions,
  requireWorkerControl,
  requireWorkerEvents,
  requireWorkflows,
} from "./method-context.js";
import {
  SessionIdParamsSchema,
} from "./params.js";

/** Everything an orchestrator or a worker asks for through its own bound actor. */
export const agentMethods: Record<string, BrokerMethodHandler> = {
  // Read-only self-description for a Cyberdeck MCP server that needs to say precisely why it
  // cannot act. It grants nothing and is deliberately answerable for an unbound actor.
  "agent.actor.describe": async (server, _context, frame) => {
    const { actorSessionId } = AgentActorParamsSchema.parse(frame.params);
    return requireAgentControl(server.options).describeActor(actorSessionId);
  },
  "agent.orchestrator.inspect": async (server, _context, frame) => {
    return requireAgentControl(server.options).inspectOrchestrator(
      AgentInspectOrchestratorParamsSchema.parse(frame.params),
    );
  },
  "agent.orchestrator.stop": async (server, _context, frame) => {
    return requireAgentControl(server.options).stopOrchestrator(
      AgentStopOrchestratorParamsSchema.parse(frame.params),
      "graceful",
    );
  },
  "agent.orchestrator.forceStop": async (server, _context, frame) => {
    return requireAgentControl(server.options).stopOrchestrator(
      AgentStopOrchestratorParamsSchema.parse(frame.params),
      "force",
    );
  },
  "agent.thread.list": async (server, _context, frame) => {
    return requireAgentControl(server.options).listThreads(AgentListThreadsParamsSchema.parse(frame.params));
  },
  "agent.thread.read": async (server, _context, frame) => {
    const { actorSessionId, sessionId, afterCursor, limit } = AgentReadParamsSchema.parse(frame.params);
    return requireAgentControl(server.options).readThread(actorSessionId, sessionId, afterCursor, limit);
  },
  "agent.scout.read": async (server, _context, frame) => {
    return requireAgentControl(server.options).readScoutArtifact(
      AgentReadScoutArtifactParamsSchema.parse(frame.params),
    );
  },
  "agent.worker.start": async (server, _context, frame) => {
    return requireAgentControl(server.options).startWorker(AgentStartWorkerParamsSchema.parse(frame.params));
  },
  "agent.worker.startMany": async (server, _context, frame) => {
    return requireAgentControl(server.options).startWorkers(AgentStartWorkersParamsSchema.parse(frame.params));
  },
  "agent.worker.wait": async (server, _context, frame) => {
    return requireAgentControl(server.options).waitForWorkers(AgentWaitWorkersParamsSchema.parse(frame.params));
  },
  "agent.thread.enqueue": async (server, _context, frame) => {
    return requireInstructions(server.options).enqueue(EnqueueInstructionParamsSchema.parse(frame.params));
  },
  "agent.lease.control": async (server, _context, frame) => {
    return requireWorkerControl(server.options).lease(AgentLeaseParamsSchema.parse(frame.params));
  },
  "agent.worker.control": async (server, _context, frame) => {
    return requireWorkerControl(server.options).control(AgentWorkerControlParamsSchema.parse(frame.params));
  },
  "agent.worker.events": async (server, _context, frame) => {
    return requireWorkerControl(server.options).events(AgentWorkerEventsParamsSchema.parse(frame.params));
  },
  "agent.instruction.list": async (server, _context, frame) => {
    const params = z.object({ targetSessionId: z.uuid().optional() }).parse(frame.params);
    return requireInstructions(server.options).list(params.targetSessionId);
  },
  "agent.instruction.flush": async (server, _context, frame) => {
    const { sessionId } = SessionIdParamsSchema.parse(frame.params);
    return requireInstructions(server.options).flush(sessionId);
  },
  "worker.event.submit": async (server, _context, frame) => {
    return requireWorkerEvents(server.options).submit(WorkerEventSubmitParamsSchema.parse(frame.params));
  },
  "worker.checkpoint.request": async (server, _context, frame) => {
    return requireWorkerEvents(server.options).requestCheckpoint(
      WorkerCheckpointRequestParamsSchema.parse(frame.params),
    );
  },
  "agent.workflow.create": async (server, _context, frame) => {
    return requireWorkflows(server.options).create(CreateWorkflowParamsSchema.parse(frame.params));
  },
  "agent.workflow.list": async (server, _context, frame) => {
    const { actorSessionId } = WorkflowActorParamsSchema.parse(frame.params);
    return requireWorkflows(server.options).list(actorSessionId);
  },
  "agent.workflow.changes": async (server, _context, frame) => {
    const { actorSessionId, runId, afterCursor } = WorkflowChangesParamsSchema.parse(frame.params);
    return requireWorkflows(server.options).changes(actorSessionId, runId, afterCursor);
  },
  "agent.workflow.send": async (server, _context, frame) => {
    return requireWorkflows(server.options).send(SendWorkflowMessageParamsSchema.parse(frame.params));
  },
  "agent.workflow.cancel": async (server, _context, frame) => {
    const { actorSessionId, runId } = WorkflowRunActorParamsSchema.parse(frame.params);
    return requireWorkflows(server.options).cancel(actorSessionId, runId, "cancelled by owner orchestrator");
  },
  "workflow.list": async (server, _context, _frame) => {
    return requireWorkflows(server.options).listAll();
  },
  "workflow.cancel": async (server, _context, frame) => {
    const request = z.object({ runId: z.uuid(), reason: z.string().optional() }).parse(frame.params);
    return requireWorkflows(server.options).cancel(undefined, request.runId, request.reason);
  },
};
