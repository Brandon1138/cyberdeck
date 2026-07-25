import { isAbsolute } from "node:path";
import { z } from "zod";
import { ProviderIdSchema } from "./provider-registration.js";

export { ProviderIdSchema } from "./provider-registration.js";

export const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export const SandboxSchema = z.enum(["read-only", "workspace-write"]);
export const ApprovalModeSchema = z.enum(["prompt", "auto"]);
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
  approvalMode: ApprovalModeSchema.optional(),
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

/**
 * The only environment keys a resolved launch record may quote. A `ProviderLaunchSpec.env` is built
 * from `process.env`, so it carries whatever API keys and tokens the operator's shell holds; those
 * values must never be printed or persisted. Every key here is written by Cyberdeck itself with a
 * constant, non-secret value, and everything else is reduced to a count.
 */
export const RESOLVED_LAUNCH_ENV_KEYS = [
  "CYBERDECK_PROCESS_ROLE",
  "CYBERDECK_WORKER_MODE",
  "DISABLE_UPDATES",
] as const;

/**
 * What the broker actually spawned, sanitized and bounded so it is safe to persist in the session
 * catalog and to hand to an operator inspection command.
 */
export const ResolvedLaunchRecordSchema = z.object({
  mode: z.enum(["launch", "resume"]),
  resolvedAt: z.iso.datetime(),
  executable: z.string().max(4_096),
  args: z.array(z.string().max(4_096)).max(256),
  cwd: z.string().max(4_096),
  cyberdeckEnv: z.record(z.string().max(64), z.string().max(256))
    .refine((value) => Object.keys(value).length <= RESOLVED_LAUNCH_ENV_KEYS.length,
      "cyberdeckEnv may only describe Cyberdeck-owned overrides"),
  /** How many inherited variables were passed through. Names and values are deliberately absent. */
  inheritedEnvCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
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
  launchRecord: ResolvedLaunchRecordSchema.optional(),
});

export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type Sandbox = z.infer<typeof SandboxSchema>;
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type SessionExecutionState = z.infer<typeof SessionExecutionStateSchema>;
export type AttachmentState = z.infer<typeof AttachmentStateSchema>;
export type SessionKind = z.infer<typeof SessionKindSchema>;
export type WorkerMode = z.infer<typeof WorkerModeSchema>;
export type ThreadAttentionState = z.infer<typeof ThreadAttentionStateSchema>;
export type ResolvedLaunchRecord = z.infer<typeof ResolvedLaunchRecordSchema>;
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
