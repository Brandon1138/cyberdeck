import { isAbsolute } from "node:path";
import { z } from "zod";
import { ArtifactDescriptorSchema } from "./artifact.js";
import {
  ControlPlaneErrorCodeSchema,
  CorrelationIdSchema,
  JobIdSchema,
  SessionIdSchema,
  TimestampSchema,
  schemaVersionField,
} from "./control-plane.js";
import { ProviderIdSchema } from "./provider-registration.js";
import { SandboxSchema } from "./session.js";
import { UsageReportSchema } from "./usage.js";

/**
 * An immutable, bounded job request. Unlike a session (a live PTY that may run indefinitely), a job
 * is a bounded unit of work with a defined instruction and a terminal outcome. Provider is explicit
 * and registered; model and role are opaque optional strings with no routing semantics; sandbox is
 * independent. The request is frozen (`readonly`) so a submitted request cannot be mutated in place.
 */
export const JobRequestSchema = z
  .object({
    schemaVersion: schemaVersionField,
    provider: ProviderIdSchema,
    cwd: z.string().refine(isAbsolute, "cwd must be an absolute path"),
    sandbox: SandboxSchema,
    instruction: z.string().min(1),
    model: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
  })
  .readonly();
export type JobRequest = z.infer<typeof JobRequestSchema>;

export const JobErrorSchema = z.object({
  code: ControlPlaneErrorCodeSchema,
  message: z.string(),
});
export type JobError = z.infer<typeof JobErrorSchema>;

/**
 * The terminal outcome of a job, doubling as the report-back payload. Each outcome carries exactly
 * its required data: a `completed`/`failed` job reports artifacts, a `failed` job also reports an
 * error, a `cancelled` job may report a reason. Invalid combinations are unrepresentable.
 */
export const JobResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("completed"),
    summary: z.string().optional(),
    artifacts: z.array(ArtifactDescriptorSchema),
  }),
  z.object({
    outcome: z.literal("failed"),
    error: JobErrorSchema,
    artifacts: z.array(ArtifactDescriptorSchema),
  }),
  z.object({ outcome: z.literal("cancelled"), reason: z.string().optional() }),
  z.object({ outcome: z.literal("timedOut") }),
]);
export type JobResult = z.infer<typeof JobResultSchema>;

/**
 * Job lifecycle. A job is `queued`, `dispatched`, `running`, or `settled`. Only a settled job
 * carries a result, so a running job cannot represent a terminal result and a settled job cannot
 * omit one. The specific terminal outcome (completed/failed/cancelled/timedOut) lives in `result`.
 */
export const JobLifecycleSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued"), enqueuedAt: TimestampSchema }),
  z.object({ status: z.literal("dispatched"), dispatchedAt: TimestampSchema }),
  z.object({ status: z.literal("running"), startedAt: TimestampSchema }),
  z.object({
    status: z.literal("interrupted"),
    interruptedAt: TimestampSchema,
    reason: z.string().min(1),
  }),
  z.object({ status: z.literal("settled"), finishedAt: TimestampSchema, result: JobResultSchema }),
]);
export type JobLifecycle = z.infer<typeof JobLifecycleSchema>;

/**
 * A job record is separate from a session record. A job MAY use a session/runtime (`sessionId`) and
 * MAY have a parent job (`parentJobId`), but one job is not one provider process and a job never
 * redefines attachment state as job state.
 */
export const JobRecordSchema = z.object({
  schemaVersion: schemaVersionField,
  id: JobIdSchema,
  correlationId: CorrelationIdSchema,
  request: JobRequestSchema,
  lifecycle: JobLifecycleSchema,
  parentJobId: JobIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

/**
 * The terminal report-back envelope a dispatch adapter emits when a job settles. `usage` is an
 * additive, forward-compatible field: the {@link JobDispatchAdapter} port interface is unchanged and
 * the envelope still validates when a provider omits usage, in which case usage stays unknown (it is
 * never fabricated as zero).
 */
export const JobReportSchema = z.object({
  schemaVersion: schemaVersionField,
  jobId: JobIdSchema,
  correlationId: CorrelationIdSchema,
  reportedAt: TimestampSchema,
  result: JobResultSchema,
  usage: UsageReportSchema.optional(),
});
export type JobReport = z.infer<typeof JobReportSchema>;
