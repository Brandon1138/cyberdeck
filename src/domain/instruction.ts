import { z } from "zod";

export const InstructionStatusSchema = z.enum(["queued", "delivered", "cancelled"]);

export const InstructionRecordSchema = z.object({
  id: z.uuid(),
  actorSessionId: z.uuid(),
  senderSessionId: z.uuid().optional(),
  targetSessionId: z.uuid(),
  message: z.string().trim().min(1),
  status: InstructionStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().optional(),
  workflowRunId: z.uuid().optional(),
  messageId: z.uuid(),
  causationId: z.uuid().optional(),
  hop: z.number().int().nonnegative().default(0),
});

export type InstructionRecord = z.infer<typeof InstructionRecordSchema>;
export type InstructionStatus = z.infer<typeof InstructionStatusSchema>;
