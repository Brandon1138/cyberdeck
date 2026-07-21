import { z } from "zod";
import { TimestampSchema, schemaVersionField } from "./control-plane.js";
import { ProviderIdSchema } from "./provider-registration.js";

/**
 * Concurrency and budget declarations plus usage. A1 defines the declarations and usage record
 * only; no scheduler, admission control, or enforcement is implemented. Limits are neutral and
 * provider-agnostic (a per-provider concurrency map is keyed by the open provider id, not a ranking).
 */
export const ConcurrencyDeclarationSchema = z.object({
  schemaVersion: schemaVersionField,
  maxConcurrentJobs: z.number().int().positive().optional(),
  maxConcurrentPerProvider: z.record(ProviderIdSchema, z.number().int().positive()).optional(),
});
export type ConcurrencyDeclaration = z.infer<typeof ConcurrencyDeclarationSchema>;

export const BudgetDeclarationSchema = z.object({
  schemaVersion: schemaVersionField,
  maxJobs: z.number().int().positive().optional(),
  maxWallClockMs: z.number().int().positive().optional(),
});
export type BudgetDeclaration = z.infer<typeof BudgetDeclarationSchema>;

export const BudgetUsageSchema = z.object({
  schemaVersion: schemaVersionField,
  jobsStarted: z.number().int().nonnegative(),
  jobsSettled: z.number().int().nonnegative(),
  wallClockMs: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
});
export type BudgetUsage = z.infer<typeof BudgetUsageSchema>;
