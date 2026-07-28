import { isAbsolute } from "node:path";
import { z } from "zod";
import { ProviderIdSchema } from "./provider-registration.js";
import {
  ScoutBriefSchema,
  ScoutRuntimeStateSchema,
  WorkerEffectiveStateSchema,
  WorkerLeasePolicySchema,
  WorkerProfileSchema,
} from "./worker-profile.js";

export { ProviderIdSchema } from "./provider-registration.js";

export const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export const SandboxSchema = z.enum(["read-only", "workspace-write"]);
export const ApprovalModeSchema = z.enum(["prompt", "auto"]);
/**
 * `errored` is the one state that is not a statement about the OS process. A provider session can
 * take an unrecoverable error (an API 4xx, a fatal stream fault) and leave its process running, so
 * process existence is not evidence of liveness. Such a session is terminal for every purpose the
 * broker cares about: it can no longer accept input, and it must not hold a worker slot.
 */
export const SessionExecutionStateSchema = z.enum([
  "starting",
  "active",
  "errored",
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
  profile: WorkerProfileSchema.optional(),
  brief: ScoutBriefSchema.optional(),
  leasePolicy: WorkerLeasePolicySchema.optional(),
});

/**
 * The only environment keys a resolved launch record may quote. Provider launch environments are
 * allowlisted, but configuration, routing, proxy, trust, and explicit-grant values remain sensitive
 * and must never be printed or persisted. Every key here is written by Cyberdeck itself with a
 * constant, non-secret value, and everything else is reduced to a count.
 */
export const RESOLVED_LAUNCH_ENV_KEYS = [
  "CYBERDECK_PROCESS_ROLE",
  "CYBERDECK_WORKER_MODE",
  "DISABLE_UPDATES",
  "ENABLE_TOOL_SEARCH",
  "CYBERDECK_SCOUT_DROP_BOX",
  "CYBERDECK_SCOUT_REPORT_PATH",
] as const;

/**
 * What the broker actually spawned, sanitized and bounded so it is safe to persist in the session
 * catalog and to hand to an operator inspection command.
 */
export const ResolvedLaunchRecordSchema = z.object({
  mode: z.enum(["launch", "resume"]),
  transport: z.enum(["pty", "pipe"]).default("pty"),
  resolvedAt: z.iso.datetime(),
  executable: z.string().max(4_096),
  args: z.array(z.string().max(4_096)).max(256),
  cwd: z.string().max(4_096),
  cyberdeckEnv: z.record(z.string().max(64), z.string().max(256))
    .refine((value) => Object.keys(value).length <= RESOLVED_LAUNCH_ENV_KEYS.length,
      "cyberdeckEnv may only describe Cyberdeck-owned overrides"),
  /** How many non-Cyberdeck variables were passed through. Names and values are deliberately absent. */
  inheritedEnvCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const SessionRecordSchema = StartSessionRequestSchema.extend({
  id: z.uuid(),
  /** Monotonic provider-process generation. Incremented every time this durable session resumes. */
  generation: z.number().int().positive().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  executionState: SessionExecutionStateSchema,
  attachmentState: AttachmentStateSchema,
  /** Zero means a durable launch attempt failed before a provider process existed. */
  pid: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  childIds: z.array(z.uuid()),
  attentionState: ThreadAttentionStateSchema.optional(),
  latestPreview: z.string().optional(),
  meaningfulUpdatedAt: z.iso.datetime().optional(),
  pinned: z.boolean().optional(),
  displayOrder: z.number().int().nonnegative().optional(),
  launchRecord: ResolvedLaunchRecordSchema.optional(),
  effectiveState: WorkerEffectiveStateSchema.optional(),
  scout: ScoutRuntimeStateSchema.optional(),
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
