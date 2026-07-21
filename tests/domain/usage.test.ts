import { describe, expect, it } from "vitest";
import { JobReportSchema } from "../../src/domain/job.js";
import { UsageReportSchema } from "../../src/domain/usage.js";

describe("UsageReportSchema", () => {
  it("keeps every metric optional so an unreported field stays unknown, not zero", () => {
    const parsed = UsageReportSchema.parse({});
    expect(parsed.inputTokens).toBeUndefined();
    expect(parsed.totalTokens).toBeUndefined();
    expect(parsed.schemaVersion).toBe(1);
  });

  it("rejects negative usage", () => {
    expect(() => UsageReportSchema.parse({ inputTokens: -1 })).toThrow();
  });
});

describe("JobReportSchema usage extension", () => {
  const base = {
    jobId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    reportedAt: "2026-07-21T00:00:00.000Z",
    result: { outcome: "completed" as const, artifacts: [] },
  };

  it("still validates a report that omits usage, leaving it unknown", () => {
    const report = JobReportSchema.parse(base);
    expect(report.usage).toBeUndefined();
  });

  it("carries reported usage additively without disturbing the port shape", () => {
    const report = JobReportSchema.parse({ ...base, usage: { outputTokens: 42 } });
    expect(report.usage?.outputTokens).toBe(42);
  });
});
