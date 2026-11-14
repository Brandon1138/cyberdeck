import { z } from "zod";
import { InstructionLifecycleStateSchema } from "./worker-truth.js";

export const WakeContextSchema = z.object({
  controllerId: z.string().min(1),
  cursor: z.number().int().nonnegative(),
  notificationIds: z.array(z.uuid()),
  /** Internal attention identity; absence preserves legacy wake records. */
  attentionEpoch: z.uuid().optional(),
}).refine((wake) => wake.attentionEpoch !== undefined || wake.cursor > 0, {
  message: "Legacy wakes require a positive inbox cursor",
});

export type WakeHoldReason = "wake-turn-in-flight" | "wake-composer-occupied" | "wake-operator-active";

/** Internal refusal, caught by the durable queue rather than mapped to human-controller. */
export class WakeHeldError extends Error {
  constructor(readonly holdReason: WakeHoldReason) {
    super(holdReason);
  }
}

/**
 * The instruction's own state, drawn from the single worker state machine.
 *
 * `delivered` is deliberately gone. It meant "the broker wrote the bytes at a PTY", which is not
 * delivery to anything — at a permission modal those bytes sat in the composer unsent while the
 * caller had already been told the instruction landed. What used to be called `delivered` is now
 * `rendered`, and a claim about the provider having consumed the payload requires `submitted`.
 */
export const InstructionStatusSchema = InstructionLifecycleStateSchema;

/**
 * Records written before the rename carry `delivered`. Reading it as `rendered` is the honest
 * translation: bytes were written, and nothing stronger was ever observed.
 */
const LEGACY_STATUS: Readonly<Record<string, string>> = { delivered: "rendered" };

/** Broker-minted addressing; public enqueue schemas deliberately do not accept these fields. */
export const LogicalInstructionRecipientSchema = z.object({ kind: z.literal("resident"), key: z.literal("resident:strigoi") }).strict();
export const InstructionContinuationSchema = z.object({
  instructionId: z.uuid(), originalActorSessionId: z.uuid(), originalTargetSessionId: z.uuid(),
  transitionId: z.string().min(1), incarnation: z.number().int().positive(), generation: z.number().int().positive(),
  effectiveActorSessionId: z.uuid(), effectiveTargetSessionId: z.uuid(), effectiveSenderSessionId: z.uuid().optional(),
  at: z.iso.datetime(),
}).strict();

export const InstructionRecordSchema = z.preprocess(
  (value) => {
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    const translated = typeof record.status === "string" ? LEGACY_STATUS[record.status] : undefined;
    return translated === undefined ? record : { ...record, status: translated };
  },
  z.object({
    id: z.uuid(),
    logicalRecipient: LogicalInstructionRecipientSchema.optional(),
    continuations: z.array(InstructionContinuationSchema).optional(),
    /** Durable before native write: unknown attempts are observation-only after a crash. */
    submissionAttempt: z.object({ targetSessionId: z.uuid(), actorSessionId: z.uuid(), generation: z.number().int().positive(),
      at: z.iso.datetime(), outcome: z.enum(["unknown", "refused"]) }).strict().optional(),
    actorSessionId: z.uuid(),
    senderSessionId: z.uuid().optional(),
    targetSessionId: z.uuid(),
    message: z.string().trim().min(1),
    status: InstructionStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** When the payload was written into the provider's input surface. Not proof of submission. */
    renderedAt: z.iso.datetime().optional(),
    /** When the provider consumed the payload. The only timestamp a delivery claim may cite. */
    submittedAt: z.iso.datetime().optional(),
    /** When the provider turn answering this instruction completed. */
    completedAt: z.iso.datetime().optional(),
    /**
     * The turn ordinal this instruction expects to be answered by, fixed when it was rendered.
     * A `completionTarget` below it names a turn that finished before the instruction existed.
     */
    expectedTurn: z.number().int().positive().optional(),
    /** Why the instruction is being held rather than written. */
    holdReason: z.string().optional(),
    workflowRunId: z.uuid().optional(),
    messageId: z.uuid(),
    causationId: z.uuid().optional(),
    hop: z.number().int().nonnegative().default(0),
    /** Broker policy instruction (for example, budget wrap-up), never caller-minted authority. */
    brokerOwned: z.boolean().optional(),
    /** Supplied once through native launch arguments; never retyped by queue recovery. */
    launch: z.boolean().optional(),
    /** Only the internal broker enqueue can mint a wake submission. Legacy records are ordinary. */
    submissionKind: z.literal("wake").optional(),
    wake: WakeContextSchema.optional(),
    /** Operator withdrawal is a terminal receipt, with the mandate retained for audit. */
    withdrawal: z.object({
      kind: z.literal("operator"),
      reason: z.string().trim().min(1),
      authority: z.object({ path: z.string().startsWith("/"), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
      at: z.iso.datetime(),
    }).strict().optional(),
  }),
);

export type InstructionRecord = z.infer<typeof InstructionRecordSchema>;
export type InstructionStatus = z.infer<typeof InstructionStatusSchema>;

/** Runtime-only authority transaction, applied after provider preflight and before writing. */
export type InstructionAdmission = <T>(apply: () => T | Promise<T>) => Promise<T>;

/** Runtime projection only. Never persist it in place of the immutable original envelope. */
export function effectiveInstruction(record: InstructionRecord): InstructionRecord {
  const receipt = record.continuations?.at(-1);
  return receipt ? { ...record, actorSessionId: receipt.effectiveActorSessionId,
    targetSessionId: receipt.effectiveTargetSessionId, senderSessionId: receipt.effectiveSenderSessionId } : record;
}
export function instructionSessionIds(record: InstructionRecord): string[] {
  return [...new Set([record.actorSessionId, record.targetSessionId, ...record.senderSessionId ? [record.senderSessionId] : [],
    ...record.continuations?.flatMap(r => [r.effectiveActorSessionId, r.effectiveTargetSessionId, ...r.effectiveSenderSessionId ? [r.effectiveSenderSessionId] : []]) ?? []])];
}
