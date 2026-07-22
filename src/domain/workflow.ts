import { z } from "zod";

export const WorkflowLimitsSchema = z.object({
  maxMessages: z.number().int().positive().max(1_000).default(100),
  maxTurns: z.number().int().positive().max(200).default(20),
  maxHops: z.number().int().nonnegative().max(50).default(8),
});

export const WorkflowRunSchema = z.object({
  id: z.uuid(),
  ownerSessionId: z.uuid(),
  name: z.string().trim().min(1),
  participantSessionIds: z.array(z.uuid()).min(1),
  status: z.enum(["active", "completed", "cancelled"]),
  limits: WorkflowLimitsSchema,
  messageCount: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  cancelledReason: z.string().optional(),
});

export const WorkflowMessageSchema = z.object({
  id: z.uuid(),
  cursor: z.number().int().positive(),
  runId: z.uuid(),
  messageId: z.uuid(),
  fromSessionId: z.uuid(),
  toSessionId: z.uuid(),
  text: z.string().trim().min(1),
  wake: z.boolean().default(false),
  causationId: z.uuid().optional(),
  hop: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

export type WorkflowLimits = z.infer<typeof WorkflowLimitsSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type WorkflowMessage = z.infer<typeof WorkflowMessageSchema>;

