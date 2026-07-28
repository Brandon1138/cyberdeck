import { isAbsolute } from "node:path";
import { z } from "zod";
import { schemaVersionField } from "./control-plane.js";

export const WORKER_COORDINATION_SCHEMA_VERSION = 1;

export const ControllerScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fleet"), scopeId: z.string().min(1).max(256) }),
  z.object({
    kind: z.literal("worktree"),
    scopeId: z.string().min(1).max(256),
    worktreePath: z.string().refine(isAbsolute, "worktreePath must be absolute"),
  }),
  z.object({ kind: z.literal("session-family"), scopeId: z.string().min(1).max(256) }),
]);

/**
 * Stable broker identity. `controllerId` and `familyId` identify a durable controller family,
 * never one provider conversation or process generation. `sessionId` deliberately does not exist.
 */
export const ControllerIdentitySchema = z.object({
  controllerId: z.string().min(1).max(256).refine(
    (value) => !z.uuid().safeParse(value).success,
    "controllerId must identify a stable family/scope, not a conversation UUID",
  ),
  familyId: z.string().min(1).max(256),
  scope: ControllerScopeSchema,
});

export const SubjectKindSchema = z.enum(["worker", "orchestrator"]);
export const WorkerLifecycleSchema = z.enum([
  "queued",
  "launching",
  "working",
  "waiting",
  "done",
  "failed",
  "stopped",
]);
export const TERMINAL_WORKER_LIFECYCLES = new Set<z.infer<typeof WorkerLifecycleSchema>>([
  "done",
  "failed",
  "stopped",
]);

export const LeaseStateSchema = z.enum([
  "active",
  "expired",
  "released",
  "orphaned",
  "contested",
]);

export const WorkerOriginSchema = z.object({
  creatorControllerId: z.string().min(1).max(256),
  creatorSessionId: z.uuid().optional(),
  taskId: z.string().min(1).max(256),
  waveId: z.string().min(1).max(256).optional(),
  threadId: z.string().min(1).max(256),
  createdAt: z.iso.datetime(),
});

export const SubjectResourceRefsSchema = z.object({
  sessionId: z.uuid().optional(),
  worktreePath: z.string().refine(isAbsolute, "worktreePath must be absolute").optional(),
  taskPayloadRef: z.string().min(1).max(1_024).optional(),
  transcriptRef: z.string().min(1).max(1_024).optional(),
  resultStateRef: z.string().min(1).max(1_024).optional(),
  eventStreamId: z.string().min(1).max(256),
});

export const ControllerLeaseSchema = z.object({
  leaseId: z.uuid(),
  version: z.number().int().positive(),
  state: LeaseStateSchema,
  controller: ControllerIdentitySchema.optional(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  issuedAt: z.iso.datetime(),
  renewedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  orphanedAt: z.iso.datetime().optional(),
  releasedAt: z.iso.datetime().optional(),
  reason: z.string().min(1).max(1_024).optional(),
  contest: z.object({
    actor: ControllerIdentitySchema,
    contestedAt: z.iso.datetime(),
    reason: z.string().min(1).max(1_024),
  }).optional(),
});

export const DecisionGateSchema = z.object({
  state: z.enum(["none", "decision-gate"]),
  correlationId: z.string().min(1).max(256).optional(),
  pausedAt: z.iso.datetime().optional(),
});

export const OwnershipSubjectSchema = z.object({
  schemaVersion: schemaVersionField,
  subjectId: z.uuid(),
  subjectKind: SubjectKindSchema,
  origin: WorkerOriginSchema,
  lifecycle: WorkerLifecycleSchema,
  resources: SubjectResourceRefsSchema,
  lease: ControllerLeaseSchema,
  decisionGate: DecisionGateSchema.default({ state: "none" }),
  updatedAt: z.iso.datetime(),
});

export const OwnershipSelectorSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("single"), subjectId: z.uuid() }),
  z.object({
    scope: z.literal("group"),
    taskId: z.string().min(1).max(256).optional(),
    waveId: z.string().min(1).max(256).optional(),
  }).refine((value) => value.taskId !== undefined || value.waveId !== undefined, {
    message: "group selector needs taskId or waveId",
  }),
  z.object({
    scope: z.literal("inactive-controller"),
    controllerId: z.string().min(1).max(256),
  }),
]);

export const OwnershipOutcomeCodeSchema = z.enum([
  "ACQUIRED",
  "ALREADY_CONTROLLED",
  "LEASE_CONFLICT",
  "ORPHANED",
  "NOT_ELIGIBLE",
  "WORKER_TERMINAL",
  "OWNERSHIP_LOST",
  "RELEASED",
  "TRANSFERRED",
]);

export const OwnershipOutcomeSchema = z.object({
  subjectId: z.uuid(),
  code: OwnershipOutcomeCodeSchema,
  leaseVersion: z.number().int().positive().optional(),
  leaseToken: z.string().min(32).optional(),
  currentController: ControllerIdentitySchema.optional(),
  leaseExpiresAt: z.iso.datetime().optional(),
  message: z.string().min(1).max(1_024).optional(),
});

export const OwnershipOperationSchema = z.enum([
  "register",
  "acquire",
  "renew",
  "release",
  "transfer",
  "adopt",
  "expire",
  "lifecycle",
  "liveness",
  "event-submit",
  "event-resolve",
  "checkpoint-request",
]);

export const OwnershipMutationResultSchema = z.object({
  mutationId: z.string().min(1).max(256),
  operation: OwnershipOperationSchema,
  idempotentReplay: z.boolean(),
  outcomes: z.array(OwnershipOutcomeSchema),
});

export const OwnershipAuditRecordSchema = z.object({
  auditId: z.uuid(),
  mutationId: z.string().min(1).max(256),
  operation: OwnershipOperationSchema,
  subjectId: z.uuid(),
  actor: ControllerIdentitySchema,
  occurredAt: z.iso.datetime(),
  priorController: ControllerIdentitySchema.optional(),
  newController: ControllerIdentitySchema.optional(),
  priorLeaseState: LeaseStateSchema.optional(),
  newLeaseState: LeaseStateSchema.optional(),
  reason: z.string().min(1).max(1_024),
  outcome: z.string().min(1).max(128),
});

export const ControllerLivenessSchema = z.object({
  controller: ControllerIdentitySchema,
  state: z.enum(["connected", "disconnected"]),
  observedAt: z.iso.datetime(),
  reason: z.string().min(1).max(1_024),
});

export const WorkerEventKindSchema = z.enum([
  "EXCEPTION",
  "PROGRESS",
  "CHECKPOINT",
  "RISK",
  "DECISION_REQUEST",
]);
export const WorkerEventSeveritySchema = z.enum(["info", "warning", "error", "critical"]);
export const WorkerContinuationSchema = z.enum([
  "continuing",
  "blocked",
  "paused",
  "awaiting-response",
]);

const FactValueSchema = z.union([
  z.string().max(1_024),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()])).max(32),
]);

export const WORKER_EVENT_LIMITS = {
  payloadBytes: 16_384,
  summaryChars: 1_024,
  facts: 32,
  evidenceRefs: 16,
  changedAssumptions: 16,
  recommendationChars: 1_024,
  fieldChars: 512,
} as const;

export const WorkerEventSchema = z.object({
  schemaVersion: schemaVersionField,
  eventId: z.string().min(1).max(256),
  sequence: z.number().int().positive(),
  workerId: z.uuid(),
  taskId: z.string().min(1).max(256),
  waveId: z.string().min(1).max(256).optional(),
  controllerLeaseVersion: z.number().int().positive(),
  kind: WorkerEventKindSchema,
  severity: WorkerEventSeveritySchema,
  interventionRequired: z.boolean(),
  summary: z.string().min(1).max(WORKER_EVENT_LIMITS.summaryChars),
  structuredFacts: z.record(z.string().min(1).max(128), FactValueSchema)
    .refine((value) => Object.keys(value).length <= WORKER_EVENT_LIMITS.facts, {
      message: `structuredFacts exceeds ${WORKER_EVENT_LIMITS.facts} entries`,
    })
    .optional(),
  evidenceRefs: z.array(z.string().min(1).max(WORKER_EVENT_LIMITS.fieldChars))
    .max(WORKER_EVENT_LIMITS.evidenceRefs)
    .default([]),
  changedAssumptions: z.array(z.string().min(1).max(WORKER_EVENT_LIMITS.fieldChars))
    .max(WORKER_EVENT_LIMITS.changedAssumptions)
    .default([]),
  recommendedAction: z.string().min(1).max(WORKER_EVENT_LIMITS.recommendationChars).optional(),
  continuation: WorkerContinuationSchema,
  checkpointCorrelationId: z.string().min(1).max(256).optional(),
  timestamp: z.iso.datetime(),
});

export const StoredWorkerEventSchema = WorkerEventSchema.extend({
  ordinal: z.number().int().positive(),
  receivedAt: z.iso.datetime(),
  submissionHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["active", "superseded", "acknowledged", "answered", "closed"]),
  supersededBy: z.string().min(1).max(256).optional(),
  resolvedAt: z.iso.datetime().optional(),
  resolvedBy: ControllerIdentitySchema.optional(),
});

export const EventAckSchema = z.object({
  code: z.enum(["accepted", "rejected", "duplicate", "superseded"]),
  eventId: z.string().min(1).max(256),
  sequence: z.number().int().positive().optional(),
  expectedSequence: z.number().int().positive().optional(),
  sequenceGap: z.object({
    expected: z.number().int().positive(),
    received: z.number().int().positive(),
  }).optional(),
  supersededEventIds: z.array(z.string().min(1).max(256)).optional(),
  errorCode: z.string().min(1).max(128).optional(),
  message: z.string().min(1).max(1_024).optional(),
});

export const CheckpointRequestSchema = z.object({
  schemaVersion: schemaVersionField,
  correlationId: z.string().min(1).max(256),
  workerId: z.uuid(),
  /** Optional only so existing v1 log records remain readable. New records always persist it. */
  requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  controllerLeaseVersion: z.number().int().positive(),
  requestedBy: ControllerIdentitySchema,
  focus: z.string().min(1).max(1_024).optional(),
  question: z.string().min(1).max(1_024).optional(),
  mode: z.enum(["non-blocking", "decision-gate"]).default("non-blocking"),
  state: z.enum(["pending", "answered", "closed"]),
  requestedAt: z.iso.datetime(),
  answeredByEventId: z.string().min(1).max(256).optional(),
  answeredAt: z.iso.datetime().optional(),
});

export const MutationReceiptSchema = z.object({
  mutationId: z.string().min(1).max(256),
  operation: OwnershipOperationSchema,
  recordedAt: z.iso.datetime(),
  result: z.unknown(),
});

export type ControllerIdentity = z.infer<typeof ControllerIdentitySchema>;
export type ControllerLiveness = z.infer<typeof ControllerLivenessSchema>;
export type WorkerLifecycle = z.infer<typeof WorkerLifecycleSchema>;
export type LeaseState = z.infer<typeof LeaseStateSchema>;
export type OwnershipSubject = z.infer<typeof OwnershipSubjectSchema>;
export type OwnershipSelector = z.infer<typeof OwnershipSelectorSchema>;
export type OwnershipOutcome = z.infer<typeof OwnershipOutcomeSchema>;
export type OwnershipMutationResult = z.infer<typeof OwnershipMutationResultSchema>;
export type OwnershipAuditRecord = z.infer<typeof OwnershipAuditRecordSchema>;
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
export type StoredWorkerEvent = z.infer<typeof StoredWorkerEventSchema>;
export type EventAck = z.infer<typeof EventAckSchema>;
export type CheckpointRequest = z.infer<typeof CheckpointRequestSchema>;
export type MutationReceipt = z.infer<typeof MutationReceiptSchema>;
