import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(256);
export const TaskEvaluationIntentSchema = z.object({
  attemptId: id, sessionId: z.uuid(), executionId: z.uuid().optional(), generation: z.number().int().positive(),
  instructionId: z.uuid().optional(), jobId: z.uuid().optional(), attribution: z.enum(["instruction", "initial-prompt", "direct-input", "unattributed"]),
  rubricId: id, rubricVersion: id, evidenceManifestHash: hash,
}).strict();
export type TaskEvaluationIntent = z.infer<typeof TaskEvaluationIntentSchema>;
export const TaskEvaluationResultSchema = z.object({
  disposition: z.enum(["verified-pass", "verified-fail", "unverified", "cancelled", "infrastructure-error"]),
  reason: z.string().min(1).max(256), reportHash: hash.optional(),
}).strict();
export type TaskEvaluationResult = z.infer<typeof TaskEvaluationResultSchema>;
export type TaskEvaluationDisposition = TaskEvaluationResult["disposition"];
export interface EvaluationOutboxPort { enqueue(intent: TaskEvaluationIntent): Promise<void> }
