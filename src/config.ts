import { z } from "zod";
import { BudgetDeclarationSchema, ConcurrencyDeclarationSchema } from "./domain/budget.js";
import { CONTROL_PLANE_SCHEMA_VERSION } from "./domain/control-plane.js";
import { DEFAULT_MAX_CONCURRENT_WORKERS } from "./limits.js";

/**
 * Broker-wide runtime configuration.
 *
 * Renamed from `PhaseOneConfig` in A5 (the scoped cleanup the plan deferred here): the same object
 * now carries both the interactive worker limit and the job plane's neutral concurrency/budget
 * declarations, so a phase-specific name no longer described it. Every job-plane limit is optional
 * and unset by default — Cyberdeck declares no ceiling it was not explicitly given.
 */
export const BrokerRuntimeConfigSchema = z.object({
  /** Active workers only; orchestrators are excluded. `null` explicitly disables the ceiling. */
  maxConcurrentWorkers: z.number().int().positive().nullable().default(DEFAULT_MAX_CONCURRENT_WORKERS),
  maxDelegationDepth: z.literal(1).default(1),
  replayBytes: z.number().int().positive().default(128 * 1024),
  concurrency: ConcurrencyDeclarationSchema.default({ schemaVersion: CONTROL_PLANE_SCHEMA_VERSION }),
  budget: BudgetDeclarationSchema.default({ schemaVersion: CONTROL_PLANE_SCHEMA_VERSION }),
});

export type BrokerRuntimeConfig = z.infer<typeof BrokerRuntimeConfigSchema>;
