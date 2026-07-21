import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  JobIdSchema,
  LeaseIdSchema,
  SessionIdSchema,
  TimestampSchema,
  schemaVersionField,
} from "./control-plane.js";

export const LeaseStateSchema = z.enum(["held", "released"]);
export type LeaseState = z.infer<typeof LeaseStateSchema>;

/**
 * A repository/worktree lease record. A1 defines the record shape only; no acquire/release/conflict
 * behavior is implemented. A lease may be held by a job and/or a session and points at absolute
 * repository and worktree paths.
 */
export const WorktreeLeaseSchema = z.object({
  schemaVersion: schemaVersionField,
  leaseId: LeaseIdSchema,
  repositoryPath: z.string().refine(isAbsolute, "repositoryPath must be an absolute path"),
  worktreePath: z.string().refine(isAbsolute, "worktreePath must be an absolute path"),
  branch: z.string().optional(),
  holderJobId: JobIdSchema.optional(),
  holderSessionId: SessionIdSchema.optional(),
  state: LeaseStateSchema,
  acquiredAt: TimestampSchema,
  releasedAt: TimestampSchema.optional(),
  expiresAt: TimestampSchema.optional(),
});
export type WorktreeLease = z.infer<typeof WorktreeLeaseSchema>;
