import { z } from "zod";
import { schemaVersionField } from "./control-plane.js";

/** Broker-owned allowance named by the provider window it is intended to protect. */
export const WorkerBudgetResourceSchema = z.enum(["weekly", "session"]);

/**
 * Units Cyberdeck can represent without inventing exchange rates between time, tokens, and account
 * percentages. A measurement in another unit is unknown for this allocation, never converted.
 */
export const WorkerBudgetUnitSchema = z.enum(["percent", "tokens", "wall-clock-ms"]);
export const WorkerBudgetAdjustmentDirectionSchema = z.enum(["extend", "reduce"]);

export const WorkerBudgetAllocationSchema = z.object({
  unit: WorkerBudgetUnitSchema,
  amount: z.number().finite().positive(),
}).superRefine((allocation, context) => {
  if (allocation.unit === "percent" && allocation.amount > 100) {
    context.addIssue({
      code: "custom",
      path: ["amount"],
      message: "percent budget allocation cannot exceed 100",
    });
  }
});

export const WorkerBudgetPolicySchema = z.object({
  softLimitRatio: z.number().finite().gt(0).lt(1).default(0.8),
  hardLimitRatio: z.literal(1).default(1),
  softAction: z.literal("wrap-up").default("wrap-up"),
  hardAction: z.literal("stop").default("stop"),
});

export const WorkerBudgetDeclarationSchema = z.object({
  schemaVersion: schemaVersionField,
  resource: WorkerBudgetResourceSchema,
  allocation: WorkerBudgetAllocationSchema,
  policy: WorkerBudgetPolicySchema.default({
    softLimitRatio: 0.8,
    hardLimitRatio: 1,
    softAction: "wrap-up",
    hardAction: "stop",
  }),
});

export const WorkerBudgetMeasurementSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("unknown"),
    reason: z.string().trim().min(1).max(512),
    observedAt: z.iso.datetime().optional(),
  }),
  z.object({
    status: z.literal("known"),
    unit: WorkerBudgetUnitSchema,
    amount: z.number().finite().nonnegative(),
    source: z.enum([
      "provider-telemetry",
      "terminal-token-counter",
      "wall-clock",
    ]),
    quality: z.enum(["exact", "approximate"]),
    observedAt: z.iso.datetime(),
    staleAfterMs: z.number().int().positive(),
    /** Provider-process generation that produced a generation-scoped counter, when applicable. */
    generation: z.number().int().positive().optional(),
    /**
     * Accumulated consumption at the moment this measurement's generation began. A resumed
     * provider's counter restarts at zero, so the counter is read on top of this baseline rather
     * than as one monotonic series across generations.
     */
    generationBaseline: z.number().finite().nonnegative().optional(),
  }),
]);

export const WorkerProviderRemainingSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("unavailable"),
    reason: z.string().trim().min(1).max(512).optional(),
  }),
  z.object({
    status: z.literal("available"),
    unit: WorkerBudgetUnitSchema,
    amount: z.number().finite().nonnegative(),
    quality: z.enum(["exact", "approximate"]),
    observedAt: z.iso.datetime(),
    staleAfterMs: z.number().int().positive(),
  }),
]);

export const WorkerBudgetEnforcementSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("active") }),
  z.object({
    state: z.literal("soft-pending"),
    revision: z.number().int().positive(),
    reachedAt: z.iso.datetime(),
  }),
  z.object({
    state: z.literal("soft-notified"),
    revision: z.number().int().positive(),
    reachedAt: z.iso.datetime(),
    notifiedAt: z.iso.datetime(),
  }),
  z.object({
    state: z.literal("hard-reached"),
    revision: z.number().int().positive(),
    reachedAt: z.iso.datetime(),
  }),
  z.object({
    state: z.literal("hard-stop-requested"),
    revision: z.number().int().positive(),
    reachedAt: z.iso.datetime(),
    stopRequestedAt: z.iso.datetime(),
  }),
]);

export const WorkerBudgetRecordSchema = z.object({
  schemaVersion: schemaVersionField,
  declaration: WorkerBudgetDeclarationSchema,
  /** Allocation revision. Observations never increment it; operator adjustments always do. */
  revision: z.number().int().positive(),
  measurement: WorkerBudgetMeasurementSchema,
  providerRemaining: WorkerProviderRemainingSchema,
  enforcement: WorkerBudgetEnforcementSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const WorkerBudgetOperationSchema = z.enum([
  "budget-declare",
  "budget-observe",
  "budget-adjust",
  "budget-enforce",
]);

export const WorkerBudgetMutationResultSchema = z.object({
  mutationId: z.string().min(1).max(256),
  operation: WorkerBudgetOperationSchema,
  subjectId: z.uuid(),
  revision: z.number().int().positive(),
  changed: z.boolean(),
  idempotentReplay: z.boolean(),
  budget: WorkerBudgetRecordSchema,
});

export type WorkerBudgetResource = z.infer<typeof WorkerBudgetResourceSchema>;
export type WorkerBudgetUnit = z.infer<typeof WorkerBudgetUnitSchema>;
export type WorkerBudgetAdjustmentDirection = z.infer<
  typeof WorkerBudgetAdjustmentDirectionSchema
>;
export type WorkerBudgetAllocation = z.infer<typeof WorkerBudgetAllocationSchema>;
export type WorkerBudgetPolicy = z.infer<typeof WorkerBudgetPolicySchema>;
export type WorkerBudgetDeclaration = z.infer<typeof WorkerBudgetDeclarationSchema>;
export type WorkerBudgetMeasurement = z.infer<typeof WorkerBudgetMeasurementSchema>;
export type WorkerProviderRemaining = z.infer<typeof WorkerProviderRemainingSchema>;
export type WorkerBudgetEnforcement = z.infer<typeof WorkerBudgetEnforcementSchema>;
export type WorkerBudgetRecord = z.infer<typeof WorkerBudgetRecordSchema>;
export type WorkerBudgetOperation = z.infer<typeof WorkerBudgetOperationSchema>;
export type WorkerBudgetMutationResult = z.infer<typeof WorkerBudgetMutationResultSchema>;

export type WorkerBudgetReading =
  | {
      status: "unknown";
      allocatedAmount: number;
      unit: WorkerBudgetUnit;
      reason: string;
    }
  | {
      status: "known";
      allocatedAmount: number;
      consumedAmount: number;
      remainingAmount: number;
      unit: WorkerBudgetUnit;
      ratio: number;
      softLimitReached: boolean;
      hardLimitReached: boolean;
    };

/** Build the durable state stored beside one worker's lease subject. */
export function createWorkerBudgetRecord(
  declaration: WorkerBudgetDeclaration,
  now: string,
): WorkerBudgetRecord {
  return WorkerBudgetRecordSchema.parse({
    declaration: WorkerBudgetDeclarationSchema.parse(declaration),
    revision: 1,
    measurement: {
      status: "unknown",
      reason: "No compatible broker measurement has been observed",
    },
    providerRemaining: {
      status: "unavailable",
      reason: "Provider-wide remaining usage is unavailable",
    },
    enforcement: { state: "active" },
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Project allocation arithmetic only when consumption and allocation use the same unit. Unknown is
 * preserved explicitly; token counts and wall time are never relabelled as provider percentages.
 */
export function workerBudgetReading(budget: WorkerBudgetRecord): WorkerBudgetReading {
  const allocation = budget.declaration.allocation;
  const measurement = budget.measurement;
  if (measurement.status === "unknown") {
    return {
      status: "unknown",
      allocatedAmount: allocation.amount,
      unit: allocation.unit,
      reason: measurement.reason,
    };
  }
  if (measurement.unit !== allocation.unit) {
    return {
      status: "unknown",
      allocatedAmount: allocation.amount,
      unit: allocation.unit,
      reason: `Measurement unit ${measurement.unit} does not match allocation unit ${allocation.unit}`,
    };
  }
  const ratio = measurement.amount / allocation.amount;
  return {
    status: "known",
    allocatedAmount: allocation.amount,
    consumedAmount: measurement.amount,
    remainingAmount: Math.max(0, allocation.amount - measurement.amount),
    unit: allocation.unit,
    ratio,
    softLimitReached: ratio >= budget.declaration.policy.softLimitRatio,
    hardLimitReached: ratio >= budget.declaration.policy.hardLimitRatio,
  };
}

export function workerBudgetEnforcementTransitionAllowed(
  from: WorkerBudgetEnforcement["state"],
  to: WorkerBudgetEnforcement["state"],
): boolean {
  const allowed: Readonly<Record<WorkerBudgetEnforcement["state"], readonly WorkerBudgetEnforcement["state"][]>> = {
    active: ["soft-pending", "hard-reached"],
    "soft-pending": ["soft-notified", "hard-reached"],
    "soft-notified": ["hard-reached"],
    "hard-reached": ["hard-stop-requested"],
    "hard-stop-requested": [],
  };
  return allowed[from].includes(to);
}

/** Recompute threshold state after an allocation change. Prior action state belongs to old revision. */
export function workerBudgetThresholdEnforcement(
  budget: WorkerBudgetRecord,
  reachedAt: string,
): WorkerBudgetEnforcement {
  const reading = workerBudgetReading(budget);
  if (reading.status === "unknown") return { state: "active" };
  if (reading.hardLimitReached) {
    return { state: "hard-reached", revision: budget.revision, reachedAt };
  }
  if (reading.softLimitReached) {
    return { state: "soft-pending", revision: budget.revision, reachedAt };
  }
  return { state: "active" };
}
