import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const duration = z.number().finite().nonnegative().max(86400000);
/** Closed aggregate vocabulary: no paths, arbitrary reasons, labels or provider output. */
export const ResourceSummarySchema = z.object({
  observedBytes: count.nullable(), reservedBytes: count, limitBytes: count,
  peakBytes: count.nullable(), uncertainBytes: count,
  active: count.max(10000).nullable(), parked: count.max(10000), queued: count.max(10000),
  queueDelayMs: duration, eventLoopP99Ms: duration.nullable(), sampleDurationMs: duration.nullable(),
  enforcement: z.enum(["operational", "kernel-container"]),
  reason: z.enum(["healthy", "host-pressure", "budget-breach", "metrics-unavailable", "waiting-capacity",
    "resource-infeasible", "auth-expired", "cleanup-failed", "engine-unreachable", "capture-gap", "recovered"]),
}).strict();
export type ResourceSummary = z.infer<typeof ResourceSummarySchema>;
