import { z } from "zod";

/**
 * Shared control-plane primitives: the schema version, branded identifiers, timestamps, and the
 * cross-process error-code vocabulary. Everything that crosses a process boundary in Phase 2/3
 * carries `schemaVersion` so an older reader can gate on a newer producer. Unknown object keys are
 * intentionally stripped by the individual record schemas rather than rejected, which keeps readers
 * forward-compatible: a newer field is ignored, not fatal.
 */
export const CONTROL_PLANE_SCHEMA_VERSION = 1;

export const SchemaVersionSchema = z.number().int().positive();

/** Reusable `schemaVersion` field that defaults to the current version when a producer omits it. */
export const schemaVersionField = SchemaVersionSchema.default(CONTROL_PLANE_SCHEMA_VERSION);

export const TimestampSchema = z.iso.datetime();

// Branded identifiers make cross-wiring (e.g. passing a LeaseId where a JobId is expected)
// unrepresentable at the type level while remaining plain UUID strings at runtime.
export const JobIdSchema = z.uuid().brand("JobId");
export const DelegationIdSchema = z.uuid().brand("DelegationId");
export const CorrelationIdSchema = z.uuid().brand("CorrelationId");
export const ArtifactIdSchema = z.uuid().brand("ArtifactId");
export const LeaseIdSchema = z.uuid().brand("LeaseId");
// References a Phase 1 broker session id; left unbranded so it interoperates with `SessionRecord`.
export const SessionIdSchema = z.uuid();

export const ControlPlaneErrorCodeSchema = z.enum([
  "JOB_NOT_FOUND",
  "JOB_ALREADY_TERMINAL",
  "DISPATCH_REJECTED",
  "PROVIDER_NOT_REGISTERED",
  "CANCELLATION_NOT_SUPPORTED",
  "RUNTIME_INTERRUPTED",
  "LEASE_CONFLICT",
  "BUDGET_EXCEEDED",
  "SCHEMA_VERSION_UNSUPPORTED",
]);

export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type JobId = z.infer<typeof JobIdSchema>;
export type DelegationId = z.infer<typeof DelegationIdSchema>;
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export type LeaseId = z.infer<typeof LeaseIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type ControlPlaneErrorCode = z.infer<typeof ControlPlaneErrorCodeSchema>;
