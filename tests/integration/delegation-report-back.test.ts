import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JobControlPlane } from "../../src/control-plane/job-control-plane.js";
import { defaultProviderRegistry } from "../../src/control-plane/provider-registry.js";
import type { DispatchRequest, JobDispatchAdapter } from "../../src/domain/dispatch.js";
import type { JobReport } from "../../src/domain/job.js";

const NOW = "2026-07-21T00:00:00.000Z";

const baseRequest = {
  provider: "codex",
  cwd: "/tmp/repo",
  sandbox: "read-only" as const,
  instruction: "produce a bounded summary",
};

/**
 * A deterministic fake runtime: it accepts dispatches and, only when told to `complete`, emits
 * exactly one terminal report for that job through the frozen report subscription. No real provider
 * process is ever launched, so this harness proves the control-plane wiring in isolation.
 */
function fakeRuntime(provider: string) {
  const listeners = new Set<(report: JobReport) => void>();
  const dispatches = new Map<string, DispatchRequest>();
  const adapter: JobDispatchAdapter = {
    provider,
    async dispatch(request) {
      dispatches.set(request.jobId, request);
      return { schemaVersion: 1, jobId: request.jobId, acceptedAt: NOW };
    },
    async cancel(request) {
      return { accepted: true, jobId: request.jobId };
    },
    onReport(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    adapter,
    dispatchCount: () => dispatches.size,
    complete(jobId: string): void {
      const dispatch = dispatches.get(jobId);
      if (dispatch === undefined) throw new Error(`nothing dispatched for ${jobId}`);
      const report: JobReport = {
        schemaVersion: 1,
        jobId: dispatch.jobId,
        correlationId: dispatch.correlationId,
        reportedAt: NOW,
        result: { outcome: "completed", summary: "bounded work complete", artifacts: [] },
      };
      for (const listener of [...listeners]) listener(report);
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("delegation report-back end to end", () => {
  it("turns one parent request into one child job, one result, one acknowledged report-back", async () => {
    const events: string[] = [];
    const plane = new JobControlPlane({
      registry: defaultProviderRegistry(),
      now: () => NOW,
      journal: {
        async append(event) {
          events.push(event.type);
        },
      },
    });
    const runtime = fakeRuntime("codex");
    plane.registerAdapter(runtime.adapter);

    // A parent job submits one bounded delegation.
    const parent = await plane.submit({ request: baseRequest, idempotencyKey: "parent" });
    const delegationId = randomUUID();
    const intent = {
      delegationId,
      correlationId: randomUUID(),
      parentJobId: parent.job.id,
      request: baseRequest,
    };
    const child = await plane.delegate(intent);
    expect(child.deduplicated).toBe(false);

    // A retried delegation must not silently create a duplicate child.
    const retried = await plane.delegate(intent);
    expect(retried.deduplicated).toBe(true);
    expect(retried.job.id).toBe(child.job.id);

    // The fake runtime completes the child exactly once; the report flows through the subscription.
    runtime.complete(child.job.id);
    await flush();

    const children = plane.listJobs().filter((snapshot) => snapshot.record.parentJobId !== undefined);
    expect(children).toHaveLength(1);
    expect(runtime.dispatchCount()).toBe(2); // parent + child, each dispatched exactly once

    const settledChildren = children.filter(
      (snapshot) => snapshot.record.lifecycle.status === "settled",
    );
    expect(settledChildren).toHaveLength(1);
    expect(settledChildren[0]?.reportBack?.state).toBe("pending");

    // The report-back is not "delivered" merely because the terminal result appeared.
    const acked = await plane.acknowledgeReport(child.job.id);
    expect(acked.state).toBe("delivered");

    const delivered = plane
      .listJobs()
      .filter((snapshot) => snapshot.reportBack?.state === "delivered");
    expect(delivered).toHaveLength(1);
    expect(events.filter((type) => type === "job.reported")).toHaveLength(1);
    expect(events.filter((type) => type === "job.report.acknowledged")).toHaveLength(1);
    expect(events.filter((type) => type === "job.settled")).toHaveLength(1);
  });
});
