import { describe, expect, it } from "vitest";
import {
  JobLifecycleSchema,
  JobRecordSchema,
  JobReportSchema,
  JobRequestSchema,
  JobResultSchema,
} from "../../src/domain/job.js";

const baseRequest = {
  provider: "codex",
  cwd: "/tmp/repo",
  sandbox: "read-only",
  instruction: "summarize the repository without changing files",
};

const now = "2026-07-21T00:00:00.000Z";

describe("JobRequestSchema", () => {
  it("requires an explicit provider and a bounded instruction", () => {
    const parsed = JobRequestSchema.parse(baseRequest);
    expect(parsed.provider).toBe("codex");
    expect(parsed.instruction).toContain("summarize");
    expect(parsed.model).toBeUndefined();
    expect(parsed.role).toBeUndefined();
    expect(parsed.schemaVersion).toBe(1);
  });

  it("keeps arbitrary model and role strings opaque", () => {
    const parsed = JobRequestSchema.parse({
      ...baseRequest,
      provider: "claude",
      model: "luna-anything",
      role: "night-shift-scribe",
    });
    expect(parsed.model).toBe("luna-anything");
    expect(parsed.role).toBe("night-shift-scribe");
  });

  it("rejects a missing provider rather than routing implicitly", () => {
    expect(() =>
      JobRequestSchema.parse({ cwd: "/tmp/repo", sandbox: "read-only", instruction: "x" }),
    ).toThrow();
  });

  it("requires an absolute cwd", () => {
    expect(() => JobRequestSchema.parse({ ...baseRequest, cwd: "relative/path" })).toThrow();
  });
});

describe("JobLifecycleSchema", () => {
  it("parses each non-terminal status", () => {
    expect(JobLifecycleSchema.parse({ status: "queued", enqueuedAt: now }).status).toBe("queued");
    expect(JobLifecycleSchema.parse({ status: "dispatched", dispatchedAt: now }).status).toBe("dispatched");
    expect(JobLifecycleSchema.parse({ status: "running", startedAt: now }).status).toBe("running");
  });

  it("requires a terminal result once settled and rejects unknown statuses", () => {
    expect(() => JobLifecycleSchema.parse({ status: "settled", finishedAt: now })).toThrow();
    const settled = JobLifecycleSchema.parse({
      status: "settled",
      finishedAt: now,
      result: { outcome: "timedOut" },
    });
    expect(settled.status).toBe("settled");
    expect(() => JobLifecycleSchema.parse({ status: "paused", pausedAt: now })).toThrow();
  });
});

describe("JobResultSchema", () => {
  it("pairs each outcome with its required payload", () => {
    expect(JobResultSchema.parse({ outcome: "completed", artifacts: [] }).outcome).toBe("completed");
    expect(() => JobResultSchema.parse({ outcome: "failed", artifacts: [] })).toThrow();
    expect(
      JobResultSchema.parse({
        outcome: "failed",
        artifacts: [],
        error: { code: "DISPATCH_REJECTED", message: "x" },
      }).outcome,
    ).toBe("failed");
  });
});

describe("JobRecordSchema", () => {
  it("keeps a job distinct from a session and tolerates unknown forward-compatible fields", () => {
    const record = JobRecordSchema.parse({
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      request: baseRequest,
      lifecycle: { status: "queued", enqueuedAt: now },
      createdAt: now,
      updatedAt: now,
      futureField: "ignored",
    });
    expect(record.sessionId).toBeUndefined();
    expect("futureField" in record).toBe(false);
  });

  it("optionally references a session and a parent job without conflating them", () => {
    const sessionId = crypto.randomUUID();
    const parentJobId = crypto.randomUUID();
    const record = JobRecordSchema.parse({
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      request: baseRequest,
      lifecycle: { status: "running", startedAt: now },
      sessionId,
      parentJobId,
      createdAt: now,
      updatedAt: now,
    });
    expect(record.sessionId).toBe(sessionId);
    expect(record.parentJobId).toBe(parentJobId);
  });
});

describe("JobReportSchema", () => {
  it("wraps a terminal result as a report-back envelope", () => {
    const report = JobReportSchema.parse({
      jobId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      reportedAt: now,
      result: { outcome: "completed", summary: "done", artifacts: [] },
    });
    expect(report.result.outcome).toBe("completed");
    expect(report.schemaVersion).toBe(1);
  });
});
