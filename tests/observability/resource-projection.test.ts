import { describe, expect, it } from "vitest";
import { ResourceSummarySchema } from "../../src/domain/resource-summary.js";
import { projectResourceMeasurements, resourceIncident } from "../../src/observability/resource-projection.js";
const sample = { observedBytes: null, reservedBytes: 100, limitBytes: 200, peakBytes: null, uncertainBytes: 40,
  active: 1, parked: 2, queued: 3, queueDelayMs: 40, eventLoopP99Ms: 1, sampleDurationMs: 10,
  enforcement: "operational" as const, reason: "metrics-unavailable" as const };
describe("resource telemetry", () => {
  it("excludes unknown values and exposes only fixed units and measurement names", () => {
    const projected = projectResourceMeasurements(sample);
    expect(projected["cyberdeck.resource.observedBytes"]).toBeUndefined();
    expect(projected["cyberdeck.resource.reservedBytes"]).toEqual({ value: 100, unit: "byte" });
  });
  it("rejects arbitrary metadata, reasons and non-finite or invalid measurements", () => {
    for (const extra of [{ path: "/private/secret" }, { reason: "sk-secret" }, { active: -1 }, { eventLoopP99Ms: NaN },
      { reservedBytes: Infinity }, { toolArguments: { token: "secret" } }])
      expect(ResourceSummarySchema.safeParse({ ...sample, ...extra }).success).toBe(false);
  });
  it("emits once per incident and once on recovery", () => {
    const first = resourceIncident(null, "host-pressure"); expect(first.emit).toBe(true);
    expect(resourceIncident(first.state, "host-pressure").emit).toBe(false);
    expect(resourceIncident(first.state, "healthy")).toEqual({ state: null, emit: true, recovered: true });
    expect(resourceIncident(null, "healthy").emit).toBe(false);
  });
});
