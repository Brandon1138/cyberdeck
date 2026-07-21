import { z } from "zod";
import { TimestampSchema, schemaVersionField } from "./control-plane.js";
import { ProviderIdSchema } from "./provider-registration.js";

/**
 * Concurrency and budget declarations plus usage. A1 defined the declarations and usage record; A5
 * adds the enforcement layer over them and the additional *measurable* ceilings that layer can
 * actually prove. Limits stay neutral and provider-agnostic (a per-provider concurrency map is keyed
 * by the open provider id, not a ranking), and no limit ever selects or substitutes a provider.
 */
export const ConcurrencyDeclarationSchema = z.object({
  schemaVersion: schemaVersionField,
  maxConcurrentJobs: z.number().int().positive().optional(),
  maxConcurrentPerProvider: z.record(ProviderIdSchema, z.number().int().positive()).optional(),
  /**
   * Additive A5 field: how many admitted jobs may run against one canonical repository at once. It
   * is a scheduling ceiling only — exclusive *writable* access is still proven by a worktree lease,
   * never by this counter.
   */
  maxConcurrentPerRepository: z.number().int().positive().optional(),
});
export type ConcurrencyDeclaration = z.infer<typeof ConcurrencyDeclarationSchema>;

/**
 * Only limits the control plane can measure from data it actually holds: elapsed wall clock, the
 * number of admitted jobs (delegated children included), reported token usage, and persisted
 * artifact bytes. There is deliberately no money/model/role cost model — inventing per-model or
 * per-role prices would fabricate provenance no provider gave us.
 */
export const BudgetDeclarationSchema = z.object({
  schemaVersion: schemaVersionField,
  maxJobs: z.number().int().positive().optional(),
  maxWallClockMs: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().positive().optional(),
  maxArtifactBytes: z.number().int().positive().optional(),
});
export type BudgetDeclaration = z.infer<typeof BudgetDeclarationSchema>;

/**
 * Observed usage for one budget scope. `totalTokens` is **optional on purpose**: it stays absent
 * until some job actually reports tokens, because an unreported count and a genuine zero are
 * different facts. `jobsWithUnknownUsage` counts settled jobs that reported nothing, which is what
 * makes a declared token ceiling unprovable and therefore fail closed.
 */
export const BudgetUsageSchema = z.object({
  schemaVersion: schemaVersionField,
  jobsStarted: z.number().int().nonnegative(),
  jobsSettled: z.number().int().nonnegative(),
  wallClockMs: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
  artifactBytes: z.number().int().nonnegative().default(0),
  jobsWithUnknownUsage: z.number().int().nonnegative().default(0),
  updatedAt: TimestampSchema,
});
export type BudgetUsage = z.infer<typeof BudgetUsageSchema>;
