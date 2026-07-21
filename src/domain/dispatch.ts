import { z } from "zod";
import {
  ControlPlaneErrorCodeSchema,
  CorrelationIdSchema,
  JobIdSchema,
  TimestampSchema,
  schemaVersionField,
} from "./control-plane.js";
import { JobRequestSchema, type JobReport } from "./job.js";
import type { ProviderId } from "./provider-registration.js";

/** What the control plane hands a provider adapter to run one bounded job. */
export const DispatchRequestSchema = z.object({
  schemaVersion: schemaVersionField,
  jobId: JobIdSchema,
  correlationId: CorrelationIdSchema,
  request: JobRequestSchema,
});
export type DispatchRequest = z.infer<typeof DispatchRequestSchema>;

export const DispatchAcceptedSchema = z.object({
  schemaVersion: schemaVersionField,
  jobId: JobIdSchema,
  acceptedAt: TimestampSchema,
});
export type DispatchAccepted = z.infer<typeof DispatchAcceptedSchema>;

export const CancellationRequestSchema = z.object({
  schemaVersion: schemaVersionField,
  jobId: JobIdSchema,
  correlationId: CorrelationIdSchema,
  reason: z.string().optional(),
});
export type CancellationRequest = z.infer<typeof CancellationRequestSchema>;

/** A cancellation is either acknowledged or refused with a code; a refusal cannot omit its code. */
export const CancellationResultSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), jobId: JobIdSchema }),
  z.object({ accepted: z.literal(false), jobId: JobIdSchema, code: ControlPlaneErrorCodeSchema }),
]);
export type CancellationResult = z.infer<typeof CancellationResultSchema>;

/**
 * Provider-neutral job dispatch port. Agent B implements one adapter per provider (B2–B4) without
 * waiting for A2. The control plane never ranks providers or routes: it selects the explicitly
 * requested provider's adapter and calls it. Completion is reported asynchronously via a
 * {@link JobReport}; `onReport` returns an unsubscribe function.
 */
export interface JobDispatchAdapter {
  readonly provider: ProviderId;
  dispatch(request: DispatchRequest): Promise<DispatchAccepted>;
  cancel(request: CancellationRequest): Promise<CancellationResult>;
  onReport(listener: (report: JobReport) => void): () => void;
}
