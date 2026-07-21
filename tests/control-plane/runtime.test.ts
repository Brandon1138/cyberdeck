import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { ControlPlaneRuntime } from "../../src/control-plane/runtime.js";
import type {
  CancellationRequest,
  DispatchRequest,
  JobDispatchAdapter,
} from "../../src/domain/dispatch.js";
import type { JobReport } from "../../src/domain/job.js";
import { JobStore } from "../../src/persistence/job-store.js";

const NOW = "2026-07-21T00:00:00.000Z";

const baseRequest = {
  provider: "codex",
  cwd: "/tmp/repo",
  sandbox: "read-only" as const,
  instruction: "produce a bounded summary",
};

function fakeRuntime(provider: string) {
  const listeners = new Set<(report: JobReport) => void>();
  const dispatched: DispatchRequest[] = [];
  const cancelled: CancellationRequest[] = [];
  const adapter: JobDispatchAdapter = {
    provider,
    async dispatch(request) {
      dispatched.push(request);
      return { schemaVersion: 1, jobId: request.jobId, acceptedAt: NOW };
    },
    async cancel(request) {
      cancelled.push(request);
      return { accepted: true, jobId: request.jobId };
    },
    onReport(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { adapter, dispatched, cancelled };
}

describe("control-plane runtime composition", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cyberdeck-runtime-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function runtime(overrides: Record<string, unknown> = {}) {
    const adapter = fakeRuntime("codex");
    const composed = new ControlPlaneRuntime({
      stateDirectory: directory,
      config: BrokerRuntimeConfigSchema.parse(overrides),
      adapters: [adapter.adapter],
      now: () => NOW,
    });
    return { composed, adapter };
  }

  it("refuses to dispatch before start has recovered and reconciled", async () => {
    const { composed, adapter } = runtime();
    const job = await composed.controlPlane.submit({
      request: baseRequest,
      idempotencyKey: randomUUID(),
    });

    expect(adapter.dispatched).toHaveLength(0);
    expect(composed.controlPlane.getJob(job.job.id).record.lifecycle.status).toBe("queued");

    const report = await composed.start();

    expect(report.reconciledAt).toBe(NOW);
    // Startup never launches work it found already persisted: that job is interrupted for explicit
    // operator handling, not silently resumed once admission opens.
    expect(adapter.dispatched).toHaveLength(0);
    expect(composed.controlPlane.getJob(job.job.id).record.lifecycle.status).toBe("interrupted");
  });

  it("dispatches normally once startup has opened admission", async () => {
    const { composed, adapter } = runtime();
    await composed.start();

    const job = await composed.controlPlane.submit({
      request: baseRequest,
      idempotencyKey: randomUUID(),
    });

    expect(adapter.dispatched.map((entry) => entry.jobId)).toEqual([job.job.id]);
    expect(composed.controlPlane.getJob(job.job.id).record.lifecycle.status).toBe("dispatched");
  });

  it("reconciles persisted in-flight work before opening admission", async () => {
    const store = new JobStore(directory);
    const first = runtime();
    await first.composed.start();
    const stranded = await first.composed.controlPlane.submit({
      request: baseRequest,
      idempotencyKey: randomUUID(),
    });
    expect(first.adapter.dispatched).toHaveLength(1);

    const restarted = runtime();
    const report = await restarted.composed.start();

    expect(await store.load()).not.toHaveLength(0);
    expect(restarted.composed.controlPlane.getJob(stranded.job.id).record.lifecycle.status).toBe(
      "interrupted",
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: "unverifiable-in-flight-job", subject: stranded.job.id }),
    );
    // Recovered work is never redispatched by startup.
    expect(restarted.adapter.dispatched).toHaveLength(0);
  });

  it("stops admission before draining, then persists the final state", async () => {
    const { composed, adapter } = runtime({ concurrency: { maxConcurrentJobs: 1 } });
    await composed.start();

    const running = await composed.controlPlane.submit({
      request: baseRequest,
      idempotencyKey: randomUUID(),
    });
    const queued = await composed.controlPlane.submit({
      request: baseRequest,
      idempotencyKey: randomUUID(),
    });
    expect(adapter.dispatched.map((entry) => entry.jobId)).toEqual([running.job.id]);

    await composed.shutdown("test");

    expect(composed.queueSnapshot().admissionOpen).toBe(false);
    // The queued job was never dispatched, and the running one was cancelled rather than abandoned.
    expect(adapter.dispatched.map((entry) => entry.jobId)).toEqual([running.job.id]);
    expect(adapter.cancelled.map((entry) => entry.jobId)).toEqual([running.job.id]);

    const persisted = await new JobStore(directory).load();
    const statuses = persisted.map((state) => state.record.lifecycle.status);
    expect(statuses).toEqual(["settled", "settled"]);
    expect(persisted.map((state) => state.record.id).sort()).toEqual(
      [running.job.id, queued.job.id].sort(),
    );
  });

  it("ignores a submission made after shutdown instead of launching it", async () => {
    const { composed, adapter } = runtime();
    await composed.start();
    await composed.shutdown("test");

    const late = await composed.controlPlane.submit({
      request: baseRequest,
      idempotencyKey: randomUUID(),
    });
    expect(adapter.dispatched).toHaveLength(0);
    expect(composed.controlPlane.getJob(late.job.id).record.lifecycle.status).toBe("queued");
  });

  it("is safe to shut down twice", async () => {
    const { composed } = runtime();
    await composed.start();
    await composed.shutdown("first");
    await expect(composed.shutdown("second")).resolves.toBeUndefined();
  });

  it("exposes queue, budget, reconciliation, and report-back queries", async () => {
    const { composed } = runtime({ concurrency: { maxConcurrentJobs: 2 }, budget: { maxJobs: 4 } });
    await composed.start();
    await composed.controlPlane.submit({ request: baseRequest, idempotencyKey: randomUUID() });

    expect(composed.queueSnapshot().limits.maxConcurrentJobs).toBe(2);
    expect(composed.queueSnapshot().admissionOpen).toBe(true);
    expect(composed.budgetReport().declaration.maxJobs).toBe(4);
    expect(composed.budgetReport().scopes).toHaveLength(1);
    expect(composed.lastReconciliation()?.findings).toEqual([]);
    expect(composed.controlPlane.listReportBacks()).toEqual([]);
  });
});
