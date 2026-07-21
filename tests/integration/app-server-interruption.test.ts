import { describe, expect, it } from "vitest";
import { JobControlPlane } from "../../src/control-plane/job-control-plane.js";
import { defaultProviderRegistry } from "../../src/control-plane/provider-registry.js";
import type { JobDispatchAdapter } from "../../src/domain/dispatch.js";
import type { JobReport } from "../../src/domain/job.js";

describe("App Server interruption mapping", () => {
  it("persists unverifiable runtime loss as interrupted without redispatch", async () => {
    let listener: ((report: JobReport) => void) | undefined;
    let dispatches = 0;
    const adapter: JobDispatchAdapter = {
      provider: "codex",
      async dispatch(request) {
        dispatches += 1;
        return { schemaVersion: 1, jobId: request.jobId, acceptedAt: "2026-07-21T12:00:00.000Z" };
      },
      async cancel(request) { return { accepted: true, jobId: request.jobId }; },
      onReport(callback) { listener = callback; return () => { listener = undefined; }; },
    };
    const plane = new JobControlPlane({
      registry: defaultProviderRegistry(),
      now: () => "2026-07-21T12:00:00.000Z",
    });
    plane.registerAdapter(adapter);
    const submitted = await plane.submit({
      idempotencyKey: "app-server-interruption",
      request: {
        schemaVersion: 1,
        provider: "codex",
        cwd: "/tmp/fake-repo",
        sandbox: "read-only",
        instruction: "fixture only",
        model: "gpt-fixture",
      },
    });
    listener?.({
      schemaVersion: 1,
      jobId: submitted.job.id,
      correlationId: submitted.job.correlationId,
      reportedAt: "2026-07-21T12:00:00.000Z",
      result: {
        outcome: "failed",
        error: {
          code: "RUNTIME_INTERRUPTED",
          message: `App Server disconnected; correlationId=${submitted.job.correlationId}; reconciliation required`,
        },
        artifacts: [],
      },
    });
    await plane.whenIdle();
    const recovered = plane.getJob(submitted.job.id);
    expect(recovered.record.lifecycle).toMatchObject({
      status: "interrupted",
      reason: expect.stringMatching(/reconciliation required/),
    });
    expect(dispatches).toBe(1);
  });
});
