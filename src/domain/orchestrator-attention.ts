import { z } from "zod";

export const ATTENTION_LIMITS = { targets: 32, receipts: 8, reports: 50, textChars: 1_024 } as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ordinal = z.number().int().nonnegative();
const text = z.string().trim().min(1).max(ATTENTION_LIMITS.textChars);

export const AttentionTargetSchema = z.object({
  sessionId: z.uuid(), completionTarget: z.number().int().positive(),
}).strict();
export const AttentionStatementSchema = z.object({
  objective: text,
  targets: z.array(AttentionTargetSchema).min(1).max(ATTENTION_LIMITS.targets)
    .refine((targets) => new Set(targets.map((target) => target.sessionId)).size === targets.length,
      "Each worker may appear only once in a wait"),
  nextAction: text,
  reviewAt: z.iso.datetime().optional(),
}).strict();

/** Journal positions, never notification cursors. Truth is a semantic digest, not pane bytes. */
export const AttentionSourcePointSchema = z.object({
  sessionId: z.uuid(), eventOrdinal: ordinal, completionTurn: ordinal, truthKey: hash,
}).strict();
export const AttentionCoverageSchema = z.array(AttentionSourcePointSchema).max(ATTENTION_LIMITS.targets)
  .refine((points) => new Set(points.map((point) => point.sessionId)).size === points.length,
    "Source coverage must be unique per worker");

export const AttentionReadReceiptSchema = z.object({
  id: z.uuid(), epoch: z.uuid(), sequence: z.number().int().positive(),
  coverage: AttentionCoverageSchema,
  notificationIds: z.array(z.uuid()).max(50),
  createdAt: z.iso.datetime(), acknowledgedAt: z.iso.datetime().optional(),
}).strict();

/** One small record per controller. The worker and instruction journals remain authoritative. */
export const OrchestratorAttentionSchema = z.object({
  schemaVersion: z.literal(1),
  controllerId: z.string().min(1).max(256), actorSessionId: z.uuid(), bindingKey: z.string().min(1),
  epoch: z.uuid(), armMutationId: z.uuid(), armRequestHash: hash,
  statement: AttentionStatementSchema,
  authorities: z.array(z.object({ sessionId: z.uuid(), leaseVersion: z.number().int().positive(), cwd: z.string().min(1) }).strict())
    .min(1).max(ATTENTION_LIMITS.targets),
  status: z.enum(["armed", "cancelled"]),
  recovery: z.enum(["ready", "held-missing-process"]),
  armedAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  actorTurnFloor: ordinal,
  cancelledAt: z.iso.datetime().optional(), cancelReason: text.optional(),
  snapshotId: hash,
  coverage: z.object({
    captured: AttentionCoverageSchema, evaluated: AttentionCoverageSchema,
    noticed: AttentionCoverageSchema, submitted: AttentionCoverageSchema, consumed: AttentionCoverageSchema,
  }).strict(),
  gaps: z.array(z.object({
    sessionId: z.uuid(), reason: z.enum(["supervision-lost", "worker-missing", "completion-unavailable"]),
  }).strict()).max(ATTENTION_LIMITS.targets * 2),
  // Slice 2 can bank a decision and its one stable wake intent in the same atomic replacement.
  decision: z.object({
    snapshotId: hash, outcome: z.enum(["WAKE", "DO_NOT_WAKE", "FALLBACK_WAKE"]),
    coverage: AttentionCoverageSchema, at: z.iso.datetime(),
  }).strict().optional(),
  pendingIntent: z.object({
    epoch: z.uuid(), messageId: z.uuid(), coverage: AttentionCoverageSchema,
    createdAt: z.iso.datetime(), instructionId: z.uuid().optional(),
  }).strict().optional(),
  readSequence: ordinal,
  receipts: z.array(AttentionReadReceiptSchema).max(ATTENTION_LIMITS.receipts),
  consumption: z.object({
    receiptId: z.uuid(), sequence: z.number().int().positive(), coverage: AttentionCoverageSchema,
    at: z.iso.datetime(),
  }).strict().optional(),
}).strict().superRefine((record, ctx) => {
  const ids = new Set(record.statement.targets.map((target) => target.sessionId));
  if (new Set(record.authorities.map((authority) => authority.sessionId)).size !== ids.size
    || record.authorities.length !== ids.size || record.authorities.some((authority) => !ids.has(authority.sessionId))) {
    ctx.addIssue({ code: "custom", message: "Wait authority must cover exactly its targets" });
  }
  const coverage = [...Object.values(record.coverage), ...record.receipts.map((receipt) => receipt.coverage),
    ...(record.decision === undefined ? [] : [record.decision.coverage]),
    ...(record.pendingIntent === undefined ? [] : [record.pendingIntent.coverage]),
    ...(record.consumption === undefined ? [] : [record.consumption.coverage])];
  if (coverage.some((points) => points.some((point) => !ids.has(point.sessionId)))) {
    ctx.addIssue({ code: "custom", message: "Coverage references a worker outside the wait" });
  }
  const captured = new Map(record.coverage.captured.map((point) => [point.sessionId, point]));
  if (captured.size !== ids.size || coverage.some((points) => points.some((point) => {
    const head = captured.get(point.sessionId);
    return head === undefined || point.eventOrdinal > head.eventOrdinal || point.completionTurn > head.completionTurn;
  })) || record.gaps.some((gap) => !ids.has(gap.sessionId))) {
    ctx.addIssue({ code: "custom", message: "Coverage or gaps exceed captured wait sources" });
  }
  if (record.receipts.some((receipt) => receipt.epoch !== record.epoch || receipt.sequence > record.readSequence)
    || new Set(record.receipts.map((receipt) => receipt.id)).size !== record.receipts.length) {
    ctx.addIssue({ code: "custom", message: "Invalid attention read receipts" });
  }
  if (record.pendingIntent !== undefined && (record.pendingIntent.epoch !== record.epoch || record.status !== "armed")) {
    ctx.addIssue({ code: "custom", message: "Wake intent must belong to the armed epoch" });
  }
  if (record.status === "cancelled" && (record.cancelledAt === undefined || record.cancelReason === undefined)) {
    ctx.addIssue({ code: "custom", message: "Cancelled attention requires a durable reason and timestamp" });
  }
});

export type AttentionStatement = z.infer<typeof AttentionStatementSchema>;
export type AttentionSourcePoint = z.infer<typeof AttentionSourcePointSchema>;
export type AttentionCoverage = z.infer<typeof AttentionCoverageSchema>;
export type AttentionReadReceipt = z.infer<typeof AttentionReadReceiptSchema>;
export type OrchestratorAttention = z.infer<typeof OrchestratorAttentionSchema>;

export class AttentionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AttentionError"; }
}
