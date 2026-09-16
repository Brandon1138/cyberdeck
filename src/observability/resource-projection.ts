import { ResourceSummarySchema, type ResourceSummary } from "../domain/resource-summary.js";

/** Measurement names and units are fixed; unknown measurements are omitted, never sent as zero. */
export function projectResourceMeasurements(input: ResourceSummary): Record<string, { value: number; unit: string }> {
  const summary = ResourceSummarySchema.parse(input);
  const units = { observedBytes: "byte", reservedBytes: "byte", limitBytes: "byte", peakBytes: "byte", uncertainBytes: "byte",
    active: "none", parked: "none", queued: "none", queueDelayMs: "millisecond", eventLoopP99Ms: "millisecond", sampleDurationMs: "millisecond" } as const;
  return Object.fromEntries(Object.entries(units).flatMap(([key, unit]) => {
    const value = summary[key as keyof typeof units];
    return value === null ? [] : [[`cyberdeck.resource.${key}`, { value, unit }]];
  }));
}

/** Bounded one-incident state, rather than one alert for each sample. Durable owner stores this state. */
export function resourceIncident(previous: ResourceSummary["reason"] | null, current: ResourceSummary["reason"]): {
  state: ResourceSummary["reason"] | null; emit: boolean; recovered: boolean;
} {
  if (current === "healthy" || current === "recovered") return { state: null, emit: previous !== null, recovered: previous !== null };
  return { state: current, emit: current !== previous, recovered: false };
}
