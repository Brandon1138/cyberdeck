import { describe, expect, it } from "vitest";
import {
  CancellationRequestSchema,
  CancellationResultSchema,
  DispatchAcceptedSchema,
  DispatchRequestSchema,
  type JobDispatchAdapter,
} from "../../src/domain/dispatch.js";

const request = {
  provider: "codex",
  cwd: "/tmp/repo",
  sandbox: "read-only",
  instruction: "run the thing",
};

describe("dispatch envelopes", () => {
  it("frames a neutral dispatch request that a provider adapter can accept", () => {
    const jobId = crypto.randomUUID();
    const dispatch = DispatchRequestSchema.parse({
      jobId,
      correlationId: crypto.randomUUID(),
      request,
    });
    expect(dispatch.request.provider).toBe("codex");
    const accepted = DispatchAcceptedSchema.parse({ jobId, acceptedAt: "2026-07-21T00:00:00.000Z" });
    expect(accepted.jobId).toBe(jobId);
  });

  it("discriminates a cancellation acknowledgement from a refusal", () => {
    const jobId = crypto.randomUUID();
    CancellationRequestSchema.parse({ jobId, correlationId: crypto.randomUUID() });
    expect(CancellationResultSchema.parse({ accepted: true, jobId }).accepted).toBe(true);
    expect(
      CancellationResultSchema.parse({ accepted: false, jobId, code: "CANCELLATION_NOT_SUPPORTED" }),
    ).toMatchObject({ accepted: false, code: "CANCELLATION_NOT_SUPPORTED" });
    expect(() => CancellationResultSchema.parse({ accepted: false, jobId })).toThrow();
  });

  it("lets a fake adapter satisfy the neutral port without a real provider", async () => {
    const events: string[] = [];
    const adapter: JobDispatchAdapter = {
      provider: "codex",
      async dispatch(req) {
        return { schemaVersion: 1, jobId: req.jobId, acceptedAt: "2026-07-21T00:00:00.000Z" };
      },
      async cancel(req) {
        return { accepted: true, jobId: req.jobId };
      },
      onReport() {
        events.push("subscribed");
        return () => {};
      },
    };
    const jobId = crypto.randomUUID();
    const accepted = await adapter.dispatch(
      DispatchRequestSchema.parse({ jobId, correlationId: crypto.randomUUID(), request }),
    );
    expect(accepted.jobId).toBe(jobId);
    adapter.onReport(() => {});
    expect(events).toContain("subscribed");
  });
});
