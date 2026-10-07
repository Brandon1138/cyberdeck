import { DispatchRequestSchema, type DispatchRequest } from "../domain/dispatch.js";
import { JobRequestSchema, type JobRecord } from "../domain/job.js";
import type { SessionRecord } from "../domain/session.js";

export interface JobDispatchContext {
  readonly record: JobRecord;
  readonly parentSessionId?: string;
  /** A job ID denotes one immutable bounded attempt; there is no resume/retry operation. */
  readonly attemptGeneration: 1;
}

/** A scheduling view of a canonical job, not a new session or a controller/lease derivation. */
export function resourceJobRecord(context: JobDispatchContext, input: DispatchRequest): SessionRecord {
  const dispatch = DispatchRequestSchema.parse(input), job = context.record;
  if (job.id !== dispatch.jobId || job.correlationId !== dispatch.correlationId || job.lifecycle.status !== "queued"
    || context.attemptGeneration !== 1 || JSON.stringify(JobRequestSchema.parse(job.request)) !== JSON.stringify(dispatch.request))
    throw new Error("RESOURCE_JOB_CANONICAL_MISMATCH");
  const { provider, cwd, sandbox, model, role, name, workerMode } = job.request;
  const parentSessionId = context.parentSessionId ?? job.sessionId;
  return { id: job.id, generation: context.attemptGeneration, provider, cwd, sandbox, kind: "worker", executor: "host",
    detached: true, createdAt: job.createdAt, updatedAt: job.updatedAt, executionState: "starting", attachmentState: "detached",
    pid: 0, exitCode: null, childIds: [], ...(model !== undefined ? { model } : {}), ...(role !== undefined ? { role } : {}),
    ...(name !== undefined ? { name } : {}), ...(workerMode !== undefined ? { workerMode } : {}),
    ...(parentSessionId !== undefined ? { parentSessionId } : {}) };
}
