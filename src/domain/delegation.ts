import { z } from "zod";
import {
  CorrelationIdSchema,
  DelegationIdSchema,
  JobIdSchema,
  SessionIdSchema,
  schemaVersionField,
} from "./control-plane.js";
import { JobRequestSchema } from "./job.js";

/**
 * An explicit intent to delegate a bounded job. It names the parent (a job and/or a session) and a
 * correlation id so a report-back can be tied to the originator. Neutrality is preserved: the
 * delegated request still carries an explicit provider and only opaque model/role strings. A
 * delegation is not required for a job to exist — top-level jobs carry no delegation intent.
 */
export const DelegationIntentSchema = z.object({
  schemaVersion: schemaVersionField,
  delegationId: DelegationIdSchema,
  correlationId: CorrelationIdSchema,
  parentJobId: JobIdSchema.optional(),
  parentSessionId: SessionIdSchema.optional(),
  request: JobRequestSchema,
  reason: z.string().optional(),
});
export type DelegationIntent = z.infer<typeof DelegationIntentSchema>;
