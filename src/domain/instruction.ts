import { z } from "zod";
import { InstructionLifecycleStateSchema } from "./worker-truth.js";

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

export const InstructionRecordSchema = z.preprocess(
  (value) => {
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    const translated = typeof record.status === "string" ? LEGACY_STATUS[record.status] : undefined;
    return translated === undefined ? record : { ...record, status: translated };
  },
  z.object({
    id: z.uuid(),
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
  }),
);

export type InstructionRecord = z.infer<typeof InstructionRecordSchema>;
export type InstructionStatus = z.infer<typeof InstructionStatusSchema>;
