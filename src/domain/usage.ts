import { z } from "zod";
import { schemaVersionField } from "./control-plane.js";

/**
 * Neutral, provider-agnostic usage a job MAY report alongside its terminal result. Every field is
 * optional: a provider that does not report a metric leaves it absent, and the control plane
 * surfaces that absence as unknown. Absence is never coerced to zero — an unreported token count and
 * a genuine zero are different facts, and conflating them would fabricate provenance the provider
 * never gave.
 */
export const UsageReportSchema = z
  .object({
    schemaVersion: schemaVersionField,
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .readonly();
export type UsageReport = z.infer<typeof UsageReportSchema>;
