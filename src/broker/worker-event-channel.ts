import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SessionRecord } from "../domain/session.js";
import {
  EventAckSchema,
  WORKER_COORDINATION_SCHEMA_VERSION,
  WorkerContinuationSchema,
  WorkerEventKindSchema,
  WorkerEventSeveritySchema,
  type ControllerIdentity,
  type EventAck,
  type StoredWorkerEvent,
  type WorkerEvent,
} from "../domain/worker-coordination.js";
import { orchestratorController, type OrchestratorBinding } from "../domain/orchestrator.js";
import type { InstructionQueue } from "../orchestration/instruction-queue.js";
import type { OrchestratorStore } from "../persistence/orchestrator-store.js";
import type { SessionRegistry } from "./session-registry.js";
import {
  WorkerCoordinationError,
  type WorkerCoordinationService,
} from "./worker-coordination.js";
import {
  BrokerWorkerLeaseCredentialCustodian,
  type WorkerLeaseCredentialCustodian,
} from "./worker-lease-credential-custodian.js";

export const WorkerEventSubmitParamsSchema = z.object({
  workerId: z.uuid(),
  eventId: z.string().trim().min(1).max(256).optional(),
  kind: WorkerEventKindSchema,
  severity: WorkerEventSeveritySchema.default("info"),
  interventionRequired: z.boolean().default(false),
  summary: z.string().min(1),
  structuredFacts: z.record(z.string(), z.unknown()).optional(),
  evidenceRefs: z.array(z.string()).default([]),
  changedAssumptions: z.array(z.string()).default([]),
  recommendedAction: z.string().optional(),
  continuation: WorkerContinuationSchema.default("continuing"),
  checkpointCorrelationId: z.string().min(1).max(256).optional(),
});

export const WorkerCheckpointRequestParamsSchema = z.object({
  actorSessionId: z.uuid(),
  workerId: z.uuid(),
  correlationId: z.string().min(1).max(256).optional(),
  focus: z.string().min(1).max(1_024).optional(),
  question: z.string().min(1).max(1_024).optional(),
  mode: z.enum(["non-blocking", "decision-gate"]).default("non-blocking"),
});

export type WorkerEventSubmitParams = z.input<typeof WorkerEventSubmitParamsSchema>;
export type WorkerCheckpointRequestParams = z.input<typeof WorkerCheckpointRequestParamsSchema>;

interface Credential {
  controller: ControllerIdentity;
  leaseToken: string;
  leaseVersion: number;
}

interface SessionCatalog {
  get(sessionId: string): SessionRecord;
}

interface ControllerCatalog {
  findBySessionId(sessionId: string): Promise<OrchestratorBinding | undefined>;
}

interface CheckpointDelivery {
  enqueue(input: Parameters<InstructionQueue["enqueue"]>[0]): ReturnType<InstructionQueue["enqueue"]>;
}

/**
 * Worker-only facade. It enriches compact worker input with immutable task/lease/sequence data,
 * then sends every provider through WorkerCoordinationService.submitEvent.
 */
export class WorkerEventChannel {
  private tail = Promise.resolve();

  constructor(
    private readonly coordination: WorkerCoordinationService,
    private readonly sessions: SessionCatalog,
    private readonly controllers: ControllerCatalog,
    private readonly delivery: CheckpointDelivery,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly credentials: WorkerLeaseCredentialCustodian =
      new BrokerWorkerLeaseCredentialCustodian(),
  ) {}

  submit(input: WorkerEventSubmitParams): Promise<EventAck> {
    return this.exclusive(async () => {
      const request = WorkerEventSubmitParamsSchema.parse(input);
      const semanticError = validateSemantics(request);
      const eventId = request.eventId ?? randomUUID();
      if (semanticError !== undefined) {
        return EventAckSchema.parse({
          code: "rejected",
          eventId,
          errorCode: "INVALID_EVENT",
          message: semanticError,
        });
      }

      const previous = this.findEvent(eventId);
      if (previous !== undefined) {
        if (!sameWorkerInput(previous, request)) {
          return EventAckSchema.parse({
            code: "rejected",
            eventId,
            sequence: previous.sequence,
            errorCode: "EVENT_ID_COLLISION",
            message: "eventId already names different payload",
          });
        }
        const credential = await this.credential(request.workerId);
        return this.coordination.submitEvent({
          mutationId: `worker-event:${request.workerId}:${eventId}:retry`,
          controller: credential.controller,
          leaseToken: credential.leaseToken,
          event: previous,
        });
      }

      const subject = this.coordination.getSubject(request.workerId)
        ?? await this.registerWorker(request.workerId);
      const credential = await this.credential(request.workerId);
      const event: WorkerEvent = {
        schemaVersion: WORKER_COORDINATION_SCHEMA_VERSION,
        eventId,
        sequence: this.nextSequence(request.workerId),
        workerId: request.workerId,
        taskId: subject.origin.taskId,
        ...(subject.origin.waveId === undefined ? {} : { waveId: subject.origin.waveId }),
        controllerLeaseVersion: credential.leaseVersion,
        kind: request.kind,
        severity: request.severity,
        interventionRequired: request.interventionRequired,
        summary: request.summary,
        ...(request.structuredFacts === undefined ? {} : { structuredFacts: request.structuredFacts }),
        evidenceRefs: request.evidenceRefs,
        changedAssumptions: request.changedAssumptions,
        ...(request.recommendedAction === undefined
          ? {}
          : { recommendedAction: request.recommendedAction }),
        continuation: request.continuation,
        ...(request.checkpointCorrelationId === undefined
          ? {}
          : { checkpointCorrelationId: request.checkpointCorrelationId }),
        timestamp: this.now(),
      } as WorkerEvent;
      return this.coordination.submitEvent({
        mutationId: `worker-event:${request.workerId}:${eventId}:lease:${credential.leaseVersion}`,
        controller: credential.controller,
        leaseToken: credential.leaseToken,
        event,
      });
    });
  }

  requestCheckpoint(input: WorkerCheckpointRequestParams) {
    return this.exclusive(async () => {
      const request = WorkerCheckpointRequestParamsSchema.parse(input);
      const session = this.requireWorker(request.workerId);
      const binding = await this.controllers.findBySessionId(request.actorSessionId);
      if (binding === undefined) {
        throw Object.assign(new Error("Actor is not a bound orchestrator"), {
          code: "ACTOR_NOT_AUTHORIZED",
        });
      }
      if (session.parentSessionId !== request.actorSessionId) {
        throw Object.assign(new Error("Worker is not owned by requesting orchestrator"), {
          code: "CAPABILITY_DENIED",
        });
      }
      await this.registerWorker(request.workerId);
      const credential = await this.credential(request.workerId);
      const expected = orchestratorController(binding);
      if (credential.controller.controllerId !== expected.controllerId) {
        throw Object.assign(new Error("Worker coordination lease belongs to another controller"), {
          code: "OWNERSHIP_LOST",
        });
      }
      const correlationId = request.correlationId ?? randomUUID();
      const checkpoint = await this.coordination.requestCheckpoint({
        mutationId: `worker-checkpoint:${request.workerId}:${correlationId}`,
        controller: credential.controller,
        leaseToken: credential.leaseToken,
        correlationId,
        workerId: request.workerId,
        ...(request.focus === undefined ? {} : { focus: request.focus }),
        ...(request.question === undefined ? {} : { question: request.question }),
        mode: request.mode,
      });
      await this.delivery.enqueue({
        actorSessionId: request.actorSessionId,
        targetSessionId: request.workerId,
        messageId: stableUuid(`checkpoint:${request.workerId}:${correlationId}`),
        message: checkpointMessage(checkpoint.correlationId, request.workerId, request.focus, request.question),
      });
      return checkpoint;
    });
  }

  private async registerWorker(workerId: string) {
    const existing = this.coordination.getSubject(workerId);
    if (existing !== undefined) return existing;
    const session = this.requireWorker(workerId);
    const binding = session.parentSessionId === undefined
      ? undefined
      : await this.controllers.findBySessionId(session.parentSessionId);
    const controller = binding === undefined
      ? fallbackController(workerId)
      : orchestratorController(binding);
    const result = await this.coordination.registerSubject({
      mutationId: `worker-reporting:register:${workerId}`,
      actor: controller,
      subjectId: workerId,
      subjectKind: "worker",
      origin: {
        creatorControllerId: controller.controllerId,
        ...(session.parentSessionId === undefined
          ? {}
          : { creatorSessionId: session.parentSessionId }),
        taskId: workerId,
        threadId: workerId,
        createdAt: session.createdAt,
      },
      lifecycle: session.attentionState === "needs-input" ? "waiting" : "working",
      resources: {
        sessionId: workerId,
        worktreePath: session.cwd,
        transcriptRef: `thread:${workerId}`,
        resultStateRef: `session:${workerId}`,
        eventStreamId: `worker:${workerId}`,
      },
      controller,
      reason: "register worker reporting channel",
    });
    const outcome = result.outcomes[0];
    if (outcome?.leaseToken !== undefined && outcome.leaseVersion !== undefined) {
      this.credentials.set(controller.controllerId, workerId, {
        leaseToken: outcome.leaseToken,
        leaseVersion: outcome.leaseVersion,
      });
    }
    return this.coordination.getSubject(workerId)!;
  }

  private async credential(workerId: string): Promise<Credential> {
    const subject = this.coordination.getSubject(workerId) ?? await this.registerWorker(workerId);
    const controller = subject.lease.controller;
    if (controller === undefined) {
      throw new WorkerCoordinationError(
        "OWNERSHIP_LOST",
        `Worker ${workerId} has no current controller; acquire or adopt control explicitly`,
      );
    }
    const cached = this.credentials.get(controller.controllerId, workerId);
    const expired = Date.parse(subject.lease.expiresAt) <= Date.parse(this.now());
    if (
      cached !== undefined
      && cached.leaseVersion === subject.lease.version
      && subject.lease.state === "active"
      && subject.lease.controller?.controllerId === controller.controllerId
      && !expired
    ) {
      return { controller, ...cached };
    }
    throw new WorkerCoordinationError(
      "OWNERSHIP_LOST",
      `Broker holds no current reporting credential for worker ${workerId}; acquire or adopt control explicitly`,
    );
  }

  private requireWorker(workerId: string): SessionRecord {
    const session = this.sessions.get(workerId);
    if ((session.kind ?? "worker") !== "worker") {
      throw Object.assign(new Error(`Session ${workerId} is not a worker`), {
        code: "ACTOR_NOT_AUTHORIZED",
      });
    }
    return session;
  }

  private allEvents(): StoredWorkerEvent[] {
    const events: StoredWorkerEvent[] = [];
    let cursor = 0;
    do {
      const page = this.coordination.projectEvents({
        cursor,
        limit: 100,
        filter: { intervention: "any" },
      });
      events.push(...page.events);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (true);
    return events;
  }

  private findEvent(eventId: string): StoredWorkerEvent | undefined {
    return this.allEvents().find((event) => event.eventId === eventId);
  }

  private nextSequence(workerId: string): number {
    return this.allEvents()
      .filter((event) => event.workerId === workerId)
      .reduce((highest, event) => Math.max(highest, event.sequence), 0) + 1;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function validateSemantics(
  request: z.output<typeof WorkerEventSubmitParamsSchema>,
): string | undefined {
  if (
    request.kind === "DECISION_REQUEST"
    && (!request.interventionRequired || request.continuation !== "awaiting-response")
  ) {
    return "DECISION_REQUEST requires --intervention and continuation awaiting-response";
  }
  if (request.kind === "CHECKPOINT" && request.checkpointCorrelationId === undefined) {
    return "CHECKPOINT requires checkpointCorrelationId";
  }
  if (request.kind !== "CHECKPOINT" && request.checkpointCorrelationId !== undefined) {
    return "checkpointCorrelationId is only valid for CHECKPOINT";
  }
  return undefined;
}

function sameWorkerInput(
  event: StoredWorkerEvent,
  request: z.output<typeof WorkerEventSubmitParamsSchema>,
): boolean {
  return JSON.stringify({
    kind: event.kind,
    severity: event.severity,
    interventionRequired: event.interventionRequired,
    summary: event.summary,
    structuredFacts: event.structuredFacts,
    evidenceRefs: event.evidenceRefs,
    changedAssumptions: event.changedAssumptions,
    recommendedAction: event.recommendedAction,
    continuation: event.continuation,
    checkpointCorrelationId: event.checkpointCorrelationId,
  }) === JSON.stringify({
    kind: request.kind,
    severity: request.severity,
    interventionRequired: request.interventionRequired,
    summary: request.summary,
    structuredFacts: request.structuredFacts,
    evidenceRefs: request.evidenceRefs,
    changedAssumptions: request.changedAssumptions,
    recommendedAction: request.recommendedAction,
    continuation: request.continuation,
    checkpointCorrelationId: request.checkpointCorrelationId,
  });
}

function fallbackController(workerId: string): ControllerIdentity {
  return {
    controllerId: `worker-reporting:${workerId}`,
    familyId: `worker-reporting:${workerId}`,
    scope: { kind: "session-family", scopeId: `worker:${workerId}` },
  };
}

function checkpointMessage(
  correlationId: string,
  workerId: string,
  focus?: string,
  question?: string,
): string {
  return [
    `Cyberdeck checkpoint ${correlationId}.`,
    ...(focus === undefined ? [] : [`Focus: ${focus}`]),
    ...(question === undefined ? [] : [`Question: ${question}`]),
    `Respond next turn with cyberdeck_respond_checkpoint or: cyberdeck event submit --worker ${workerId} --kind CHECKPOINT --checkpoint-correlation-id ${correlationId} --summary <response> --continuation continuing --event-id <stable-id>.`,
  ].join(" ");
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}
