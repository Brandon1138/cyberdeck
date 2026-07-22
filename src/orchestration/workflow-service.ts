import { randomUUID } from "node:crypto";
import { z } from "zod";
import { grantAllows } from "../domain/capability.js";
import {
  WorkflowLimitsSchema,
  WorkflowMessageSchema,
  WorkflowRunSchema,
  type WorkflowMessage,
  type WorkflowRun,
} from "../domain/workflow.js";
import type { SessionRegistry } from "../broker/session-registry.js";
import type { OrchestratorStore } from "../persistence/orchestrator-store.js";
import type { WorkflowStore } from "../persistence/workflow-store.js";
import type { InstructionQueue } from "./instruction-queue.js";

export const CreateWorkflowParamsSchema = z.object({
  actorSessionId: z.uuid(),
  name: z.string().trim().min(1),
  participantSessionIds: z.array(z.uuid()).min(1),
  limits: WorkflowLimitsSchema.optional(),
});
export const WorkflowActorParamsSchema = z.object({ actorSessionId: z.uuid() });
export const WorkflowRunActorParamsSchema = WorkflowActorParamsSchema.extend({ runId: z.uuid() });
export const SendWorkflowMessageParamsSchema = WorkflowRunActorParamsSchema.extend({
  targetSessionId: z.uuid(),
  text: z.string().trim().min(1),
  wake: z.boolean().default(false),
  messageId: z.uuid().optional(),
  causationId: z.uuid().optional(),
});
export const WorkflowChangesParamsSchema = WorkflowRunActorParamsSchema.extend({
  afterCursor: z.number().int().nonnegative().default(0),
});

export class WorkflowService {
  constructor(
    private readonly registry: SessionRegistry,
    private readonly orchestrators: OrchestratorStore,
    private readonly store: WorkflowStore,
    private readonly instructions: InstructionQueue,
  ) {}

  async create(input: z.input<typeof CreateWorkflowParamsSchema>): Promise<WorkflowRun> {
    const request = CreateWorkflowParamsSchema.parse(input);
    const binding = await this.orchestrators.findBySessionId(request.actorSessionId);
    if (binding === undefined) throw workflowError("ACTOR_NOT_AUTHORIZED", "Only a bound orchestrator can create workflows");
    const participants = [...new Set([request.actorSessionId, ...request.participantSessionIds])];
    for (const sessionId of participants) {
      const target = this.registry.get(sessionId);
      if (sessionId !== request.actorSessionId && !grantAllows(binding.grant, "workflow.run", target)) {
        throw workflowError("CAPABILITY_DENIED", `Participant ${sessionId} is outside orchestrator scope`);
      }
    }
    const now = new Date().toISOString();
    const run = WorkflowRunSchema.parse({
      id: randomUUID(),
      ownerSessionId: request.actorSessionId,
      name: request.name,
      participantSessionIds: participants,
      status: "active",
      limits: WorkflowLimitsSchema.parse(request.limits ?? {}),
      messageCount: 0,
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await this.store.putRun(run);
    return run;
  }

  async list(actorSessionId: string): Promise<WorkflowRun[]> {
    return (await this.store.listRuns()).filter((run) => run.participantSessionIds.includes(actorSessionId));
  }

  listAll(): Promise<WorkflowRun[]> {
    return this.store.listRuns();
  }

  async changes(actorSessionId: string, runId: string, afterCursor = 0): Promise<WorkflowMessage[]> {
    const run = await this.requireParticipant(actorSessionId, runId);
    return (await this.store.listMessages(run.id)).filter((message) => message.cursor > afterCursor);
  }

  async send(input: z.input<typeof SendWorkflowMessageParamsSchema>): Promise<WorkflowMessage> {
    const request = SendWorkflowMessageParamsSchema.parse(input);
    const run = await this.requireParticipant(request.actorSessionId, request.runId);
    if (run.status !== "active") throw workflowError("WORKFLOW_NOT_ACTIVE", `Workflow is ${run.status}`);
    if (!run.participantSessionIds.includes(request.targetSessionId)) {
      throw workflowError("WORKFLOW_TARGET_DENIED", "Target is not a workflow participant");
    }
    const messages = await this.store.listMessages(run.id);
    const messageId = request.messageId ?? randomUUID();
    const duplicate = messages.find((message) => message.messageId === messageId);
    if (duplicate !== undefined) return duplicate;
    if (run.messageCount >= run.limits.maxMessages) throw workflowError("WORKFLOW_MESSAGE_LIMIT", "Workflow message limit reached");
    if (request.wake && run.turnCount >= run.limits.maxTurns) throw workflowError("WORKFLOW_TURN_LIMIT", "Workflow wake-turn limit reached");
    const cause = request.causationId === undefined
      ? undefined
      : messages.find((message) => message.messageId === request.causationId);
    if (request.causationId !== undefined && cause === undefined) {
      throw workflowError("WORKFLOW_CAUSATION_UNKNOWN", "Causation message does not exist in this workflow");
    }
    const hop = cause === undefined ? 0 : cause.hop + 1;
    if (hop > run.limits.maxHops) throw workflowError("WORKFLOW_HOP_LIMIT", "Workflow hop limit reached");
    const cursor = (messages.at(-1)?.cursor ?? 0) + 1;
    const message = WorkflowMessageSchema.parse({
      id: randomUUID(),
      cursor,
      runId: run.id,
      messageId,
      fromSessionId: request.actorSessionId,
      toSessionId: request.targetSessionId,
      text: request.text,
      wake: request.wake,
      ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
      hop,
      createdAt: new Date().toISOString(),
    });
    await this.store.putMessage(message);
    const updated = WorkflowRunSchema.parse({
      ...run,
      messageCount: run.messageCount + 1,
      turnCount: run.turnCount + (request.wake ? 1 : 0),
      updatedAt: new Date().toISOString(),
    });
    await this.store.putRun(updated);
    if (request.wake) {
      await this.instructions.enqueue({
        actorSessionId: run.ownerSessionId,
        senderSessionId: request.actorSessionId,
        targetSessionId: request.targetSessionId,
        message: request.text,
        workflowRunId: run.id,
        messageId,
        ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
        hop,
      });
    }
    return message;
  }

  async cancel(actorSessionId: string | undefined, runId: string, reason = "cancelled by operator"): Promise<WorkflowRun> {
    const run = await this.requireRun(runId);
    if (actorSessionId !== undefined && actorSessionId !== run.ownerSessionId) {
      throw workflowError("WORKFLOW_OWNER_REQUIRED", "Only the owner orchestrator or human operator can cancel a workflow");
    }
    const cancelled = WorkflowRunSchema.parse({
      ...run,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
      cancelledReason: reason,
    });
    await this.store.putRun(cancelled);
    return cancelled;
  }

  private async requireParticipant(actorSessionId: string, runId: string): Promise<WorkflowRun> {
    const run = await this.requireRun(runId);
    if (!run.participantSessionIds.includes(actorSessionId)) {
      throw workflowError("WORKFLOW_PARTICIPANT_REQUIRED", "Actor is not a workflow participant");
    }
    return run;
  }

  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.store.getRun(runId);
    if (run === undefined) throw workflowError("WORKFLOW_NOT_FOUND", `Workflow ${runId} was not found`);
    return run;
  }
}

function workflowError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
