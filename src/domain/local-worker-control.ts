import { z } from "zod";
import { ProviderIdSchema } from "./provider-registration.js";
import { SessionExecutionStateSchema } from "./session.js";
import {
  WorkerBudgetResourceSchema,
  WorkerBudgetUnitSchema,
} from "./worker-budget.js";
import { WorkerTruthStateSchema } from "./worker-truth.js";

export const LOCAL_WORKER_CONTROL_SCHEMA_VERSION = 1 as const;

export const LocalWorkerSchemaVersionSchema = z.literal(LOCAL_WORKER_CONTROL_SCHEMA_VERSION);
export const LocalWorkerBudgetResourceSchema = WorkerBudgetResourceSchema;
export const LocalWorkerBudgetUnitSchema = WorkerBudgetUnitSchema;
export const LocalWorkerMeasurementAccuracySchema = z.enum(["exact", "approximate", "unknown"]);
export const LocalWorkerMeasurementFreshnessSchema = z.enum(["fresh", "stale", "unknown"]);
export const LocalWorkerMeasurementSourceSchema = z.enum([
  "provider-telemetry",
  "terminal-token-counter",
  "wall-clock",
  "unavailable",
]);

export const LocalWorkerParentSchema = z.object({
  sessionId: z.uuid(),
  kind: z.enum(["worker", "orchestrator", "unknown"]),
}).strict();

export const LocalWorkerModelSchema = z.object({
  value: z.string().min(1).max(256).nullable(),
  effort: z.string().min(1).max(64).nullable(),
  provenance: z.enum(["observed", "launch", "unknown"]),
  observedAt: z.string().max(64).nullable(),
}).strict();

export const LocalWorkerLifecycleSchema = z.object({
  state: WorkerTruthStateSchema,
  terminal: z.boolean(),
  executionState: SessionExecutionStateSchema,
  detail: z.string().min(1).max(1_024),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  elapsedMs: z.number().int().nonnegative(),
}).strict();

export const LocalWorkerBudgetMeasurementSchema = z.object({
  source: LocalWorkerMeasurementSourceSchema,
  accuracy: LocalWorkerMeasurementAccuracySchema,
  observedAt: z.iso.datetime().nullable(),
  freshness: LocalWorkerMeasurementFreshnessSchema,
  reason: z.string().min(1).max(512).nullable(),
}).strict();

/** Provider-wide allowance state. Null amount means unavailable, never zero. */
export const LocalWorkerProviderRemainingSchema = z.object({
  amount: z.number().finite().nonnegative().nullable(),
  unit: LocalWorkerBudgetUnitSchema.nullable(),
  observedAt: z.iso.datetime().nullable(),
  freshness: LocalWorkerMeasurementFreshnessSchema,
  accuracy: LocalWorkerMeasurementAccuracySchema,
  reason: z.string().min(1).max(512).nullable(),
}).strict();

const LocalWorkerSoftLimitPolicySchema = z.object({
  thresholdAmount: z.number().finite().nonnegative(),
  action: z.literal("wrap-up"),
  triggeredAt: z.iso.datetime().nullable(),
}).strict();

const LocalWorkerHardLimitPolicySchema = z.object({
  thresholdAmount: z.number().finite().nonnegative(),
  action: z.literal("stop"),
  triggeredAt: z.iso.datetime().nullable(),
}).strict();

export const LocalWorkerBudgetPolicySchema = z.object({
  softLimit: LocalWorkerSoftLimitPolicySchema,
  hardLimit: LocalWorkerHardLimitPolicySchema,
}).strict();

export const LocalWorkerBudgetEnforcementSchema = z.object({
  state: z.enum([
    "active",
    "soft-pending",
    "soft-notified",
    "hard-reached",
    "hard-stop-requested",
  ]),
  revision: z.number().int().positive().nullable(),
  reachedAt: z.iso.datetime().nullable(),
  actionAt: z.iso.datetime().nullable(),
}).strict();

export const LocalWorkerBudgetSchema = z.object({
  revision: z.number().int().positive(),
  resource: LocalWorkerBudgetResourceSchema,
  unit: LocalWorkerBudgetUnitSchema,
  allocatedAmount: z.number().finite().nonnegative(),
  consumedAmount: z.number().finite().nonnegative().nullable(),
  remainingAmount: z.number().finite().nonnegative().nullable(),
  measurement: LocalWorkerBudgetMeasurementSchema,
  providerRemaining: LocalWorkerProviderRemainingSchema,
  policy: LocalWorkerBudgetPolicySchema,
  enforcement: LocalWorkerBudgetEnforcementSchema,
}).strict();

export const LocalWorkerCommandCapabilitiesSchema = z.object({
  inspect: z.literal(true),
  stop: z.boolean(),
  extendBudget: z.boolean(),
  reduceBudget: z.boolean(),
  pause: z.literal(false),
  resume: z.literal(false),
  open: z.literal(false),
}).strict();

export const LocalWorkerTelemetrySchema = z.object({
  schemaVersion: LocalWorkerSchemaVersionSchema,
  sessionId: z.uuid(),
  parent: LocalWorkerParentSchema.nullable(),
  provider: ProviderIdSchema,
  role: z.string().min(1).max(256).nullable(),
  model: LocalWorkerModelSchema,
  taskSummary: z.string().min(1).max(240),
  lifecycle: LocalWorkerLifecycleSchema,
  budget: LocalWorkerBudgetSchema.nullable(),
  commands: LocalWorkerCommandCapabilitiesSchema,
}).strict();

export const LocalWorkerTelemetrySnapshotSchema = z.object({
  schemaVersion: LocalWorkerSchemaVersionSchema,
  cursor: z.number().int().nonnegative(),
  generatedAt: z.iso.datetime(),
  workers: z.array(LocalWorkerTelemetrySchema),
}).strict();

export const LocalWorkerSnapshotRequestSchema = z.object({
  schemaVersion: LocalWorkerSchemaVersionSchema,
}).strict();

export const LocalWorkerSubscribeRequestSchema = z.object({
  schemaVersion: LocalWorkerSchemaVersionSchema,
}).strict();

export const LocalWorkerUnsubscribeRequestSchema = z.object({
  schemaVersion: LocalWorkerSchemaVersionSchema,
}).strict();

export const LocalWorkerUnsubscribeResultSchema = z.object({
  schemaVersion: LocalWorkerSchemaVersionSchema,
  subscribed: z.literal(false),
}).strict();

const LocalWorkerCommandBaseSchema = z.object({
  schemaVersion: LocalWorkerSchemaVersionSchema,
  workerId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
  mutationId: z.string().trim().min(1).max(200),
});

export const LocalWorkerStopCommandSchema = LocalWorkerCommandBaseSchema.extend({
  action: z.literal("stop"),
}).strict();

const LocalWorkerBudgetAdjustmentSchema = LocalWorkerCommandBaseSchema.extend({
  amount: z.number().finite().positive(),
  expectedRevision: z.number().int().positive(),
});

export const LocalWorkerExtendBudgetCommandSchema = LocalWorkerBudgetAdjustmentSchema.extend({
  action: z.literal("extend-budget"),
}).strict();

export const LocalWorkerReduceBudgetCommandSchema = LocalWorkerBudgetAdjustmentSchema.extend({
  action: z.literal("reduce-budget"),
}).strict();

export const LocalWorkerCommandSchema = z.discriminatedUnion("action", [
  LocalWorkerStopCommandSchema,
  LocalWorkerExtendBudgetCommandSchema,
  LocalWorkerReduceBudgetCommandSchema,
]);

export const LocalWorkerStopCommandResultSchema = z.object({
  schemaVersion: LocalWorkerSchemaVersionSchema,
  action: z.literal("stop"),
  workerId: z.uuid(),
  mutationId: z.string().min(1).max(200),
  status: z.enum(["accepted", "already-terminal"]),
  revision: z.null(),
}).strict();

export const LocalWorkerBudgetCommandResultSchema = z.object({
  schemaVersion: LocalWorkerSchemaVersionSchema,
  action: z.enum(["extend-budget", "reduce-budget"]),
  workerId: z.uuid(),
  mutationId: z.string().min(1).max(200),
  status: z.enum(["updated", "idempotent"]),
  revision: z.number().int().positive(),
}).strict();

export const LocalWorkerCommandResultSchema = z.union([
  LocalWorkerStopCommandResultSchema,
  LocalWorkerBudgetCommandResultSchema,
]);

export type LocalWorkerBudgetResource = z.infer<typeof LocalWorkerBudgetResourceSchema>;
export type LocalWorkerBudgetUnit = z.infer<typeof LocalWorkerBudgetUnitSchema>;
export type LocalWorkerMeasurementAccuracy = z.infer<typeof LocalWorkerMeasurementAccuracySchema>;
export type LocalWorkerMeasurementFreshness = z.infer<typeof LocalWorkerMeasurementFreshnessSchema>;
export type LocalWorkerMeasurementSource = z.infer<typeof LocalWorkerMeasurementSourceSchema>;
export type LocalWorkerBudget = z.infer<typeof LocalWorkerBudgetSchema>;
export type LocalWorkerTelemetry = z.infer<typeof LocalWorkerTelemetrySchema>;
export type LocalWorkerTelemetrySnapshot = z.infer<typeof LocalWorkerTelemetrySnapshotSchema>;
export type LocalWorkerCommand = z.infer<typeof LocalWorkerCommandSchema>;
export type LocalWorkerCommandResult = z.infer<typeof LocalWorkerCommandResultSchema>;
