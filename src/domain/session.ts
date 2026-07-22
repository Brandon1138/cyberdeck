import { isAbsolute } from "node:path";
import { z } from "zod";
import { ProviderIdSchema } from "./provider-registration.js";

export { ProviderIdSchema } from "./provider-registration.js";

export const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export const SandboxSchema = z.enum(["read-only", "workspace-write"]);
export const SessionExecutionStateSchema = z.enum([
  "starting",
  "active",
  "exited",
  "failed",
  "cancelled",
]);
export const AttachmentStateSchema = z.enum(["detached", "controlled", "watched"]);
export const SessionKindSchema = z.enum(["worker", "orchestrator"]);
export const WorkerModeSchema = z.enum(["normal", "caveman"]);
export const ThreadAttentionStateSchema = z.enum([
  "working",
  "needs-input",
  "done",
  "stopping",
  "stopped",
  "interrupted",
  "failed",
]);

export const StartSessionRequestSchema = z.object({
  provider: ProviderIdSchema,
  cwd: z.string().refine(isAbsolute, "cwd must be an absolute path"),
  detached: z.boolean(),
  sandbox: SandboxSchema,
  model: z.string().optional(),
  effort: ReasoningEffortSchema.optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  parentSessionId: z.uuid().optional(),
  kind: SessionKindSchema.optional(),
  orchestratorScope: z.enum(["workspace", "fleet"]).optional(),
  providerInstructions: z.string().trim().min(1).optional(),
  workerMode: WorkerModeSchema.optional(),
});

export const SessionRecordSchema = StartSessionRequestSchema.extend({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  executionState: SessionExecutionStateSchema,
  attachmentState: AttachmentStateSchema,
  pid: z.number().int().positive(),
  exitCode: z.number().int().nullable(),
  childIds: z.array(z.uuid()),
  attentionState: ThreadAttentionStateSchema.optional(),
  latestPreview: z.string().optional(),
  meaningfulUpdatedAt: z.iso.datetime().optional(),
  pinned: z.boolean().optional(),
  displayOrder: z.number().int().nonnegative().optional(),
});

export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type Sandbox = z.infer<typeof SandboxSchema>;
export type SessionExecutionState = z.infer<typeof SessionExecutionStateSchema>;
export type AttachmentState = z.infer<typeof AttachmentStateSchema>;
export type SessionKind = z.infer<typeof SessionKindSchema>;
export type WorkerMode = z.infer<typeof WorkerModeSchema>;
export type ThreadAttentionState = z.infer<typeof ThreadAttentionStateSchema>;
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
