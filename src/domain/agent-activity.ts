import { z } from "zod";
import { ExecutionRecordSchema } from "./worker-execution.js";
export const AgentActivityKindSchema = z.enum([
  "instruction.accepted", "instruction.queued", "instruction.rendered", "instruction.submitted", "instruction.acknowledged", "instruction.settled", "instruction.undelivered", "instruction.cancelled", "instruction.held",
  "worker.lifecycle", "worker.control", "worker.handoff", "execution.lifecycle", "provider.response",
  "tool.invocation", "tool.result", "worker.report", "capture.gap", "workspace.snapshot", "evaluation.result",
]);
export const AgentActivitySchema = z.object({
  schemaVersion: z.literal(1), eventId: z.uuid(), sequence: z.number().int().positive(),
  sourceKey: z.string().min(1).max(1024), runId: z.uuid(), workerId: z.uuid(), sessionId: z.uuid(),
  generation: z.number().int().positive().optional(), instructionId: z.uuid().optional(),
  executionId: z.uuid().optional(), causationId: z.uuid().optional(), parentEventId: z.uuid().optional(),
  occurredAt: z.iso.datetime().optional(), observedAt: z.iso.datetime(), kind: AgentActivityKindSchema,
  provenance: z.enum(["broker", "provider-native", "worker-report", "host-verified", "terminal-fallback"]),
  coverage: z.enum(["complete-for-source", "partial", "unavailable"]),
  provider: z.string().max(128).optional(), model: z.string().max(256).optional(),
  providerTurnId: z.string().max(256).optional(), toolCallId: z.string().max(256).optional(),
  operation: z.enum(["agent", "tool", "instruction", "lifecycle", "control", "capture", "snapshot", "evaluation"]),
  executionPhase: ExecutionRecordSchema.shape.phase.optional(),
  outcome: z.enum(["observed", "succeeded", "failed", "cancelled", "unknown"]).default("observed"),
  payloadRef: z.string().max(4096).optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  gap: z.enum(["unsupported-source", "unknown-frame", "truncated-source", "attribution-conflict", "missing-result", "retention", "disk-failure"]).optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), provenance: z.literal("provider-native") }).strict().optional(),
}).strict();
export type AgentActivity = z.infer<typeof AgentActivitySchema>;
export type ActivityInput = Omit<AgentActivity, "sequence">;
