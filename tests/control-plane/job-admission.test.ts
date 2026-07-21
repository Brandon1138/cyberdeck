import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AdmissionScheduler } from "../../src/control-plane/admission-scheduler.js";
import { BudgetLedger } from "../../src/control-plane/budget-ledger.js";
import {
  ControlPlaneError,
  JobControlPlane,
} from "../../src/control-plane/job-control-plane.js";
import { defaultProviderRegistry } from "../../src/control-plane/provider-registry.js";
import type { DispatchRequest, JobDispatchAdapter } from "../../src/domain/dispatch.js";
import type { JobReport, JobResult } from "../../src/domain/job.js";
import type { UsageReport } from "../../src/domain/usage.js";

const NOW = "2026-07-21T00:00:00.000Z";

const baseRequest = {
  provider: "codex",
  cwd: "/tmp/repo",
  sandbox: "read-only" as const,
  instruction: "produce a bounded summary",
};

/** A fake runtime that only settles when told to, so admission order is observable. */
function fakeRuntime(provider: string) {
  const listeners = new Set<(report: JobReport) => void>();
  const dispatched: DispatchRequest[] = [];
  let dispatchError: Error | undefined;
  const adapter: JobDispatchAdapter = {
    provider,
    async dispatch(request) {
      if (dispatchError !== undefined) throw dispatchError;
      dispatched.push(request);
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
    dispatched,
    failNextDispatch(error: Error) {
      dispatchError = error;
    },
    allowDispatch() {
      dispatchError = undefined;
    },
    report(jobId: string, result: JobResult, usage?: UsageReport): JobReport {
      const dispatch = dispatched.find((entry) => entry.jobId === jobId);
      if (dispatch === undefined) throw new Error(`nothing dispatched for ${jobId}`);
      return {
        schemaVersion: 1,
        jobId: dispatch.jobId,
        correlationId: dispatch.correlationId,
        reportedAt: NOW,
        result,
        ...(usage !== undefined ? { usage } : {}),
      };
    },
  };
}

const completed: JobResult = { outcome: "completed", summary: "done", artifacts: [] };

function harness(options: {
  maxConcurrentJobs?: number;
  maxConcurrentPerRepository?: number;
  maxJobs?: number;
  maxTotalTokens?: number;
}) {
  const scheduler = new AdmissionScheduler({
    limits: {
      schemaVersion: 1,
      ...(options.maxConcurrentJobs !== undefined
        ? { maxConcurrentJobs: options.maxConcurrentJobs }
        : {}),
      ...(options.maxConcurrentPerRepository !== undefined
        ? { maxConcurrentPerRepository: options.maxConcurrentPerRepository }
        : {}),
    },
    now: () => NOW,
  });
  // Admission opens only after recovery/reconciliation; these tests start from that state.
  scheduler.openAdmission();
  const budgets = new BudgetLedger({
    declaration: {
      schemaVersion: 1,
      ...(options.maxJobs !== undefined ? { maxJobs: options.maxJobs } : {}),
      ...(options.maxTotalTokens !== undefined ? { maxTotalTokens: options.maxTotalTokens } : {}),
    },
    now: () => NOW,
  });
  const controlPlane = new JobControlPlane({
    registry: defaultProviderRegistry(),
    scheduler,
    budgets,
    now: () => NOW,
  });
  return { scheduler, budgets, controlPlane };
}

const submit = (controlPlane: JobControlPlane, overrides: Record<string, unknown> = {}) =>
  controlPlane.submit({
    request: { ...baseRequest, ...overrides },
    idempotencyKey: randomUUID(),
  });

describe("job control plane admission and budgets", () => {
  it("holds an over-ceiling job as queued instead of dispatching it", async () => {
    const { controlPlane } = harness({ maxConcurrentJobs: 1 });
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);

    const first = await submit(controlPlane);
    const second = await submit(controlPlane);

    expect(first.job.lifecycle.status).toBe("dispatched");
    expect(second.job.lifecycle.status).toBe("queued");
    expect(runtime.dispatched).toHaveLength(1);
    expect(controlPlane.queueSnapshot().queued.map((entry) => entry.jobId)).toEqual([
      second.job.id,
    ]);
  });

  it("dispatches the next queued job when a running job settles", async () => {
    const { controlPlane } = harness({ maxConcurrentJobs: 1 });
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);

    const first = await submit(controlPlane);
    const second = await submit(controlPlane);

    await controlPlane.ingestReport(runtime.report(first.job.id, completed));

    expect(runtime.dispatched.map((entry) => entry.jobId)).toEqual([first.job.id, second.job.id]);
    expect(controlPlane.getJob(second.job.id).record.lifecycle.status).toBe("dispatched");
    expect(controlPlane.queueSnapshot().queued).toHaveLength(0);
  });

  it("serializes two jobs contending for one repository and keeps their order", async () => {
    const { controlPlane } = harness({ maxConcurrentPerRepository: 1 });
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);

    const first = await submit(controlPlane, { sandbox: "workspace-write" });
    const second = await submit(controlPlane, { sandbox: "workspace-write" });
    const elsewhere = await submit(controlPlane, { cwd: "/tmp/other" });

    expect(runtime.dispatched.map((entry) => entry.jobId)).toEqual([
      first.job.id,
      elsewhere.job.id,
    ]);
    await controlPlane.ingestReport(runtime.report(first.job.id, completed));
    expect(runtime.dispatched.map((entry) => entry.jobId)).toContain(second.job.id);
  });

  it("releases the slot exactly once when a launch fails", async () => {
    const { controlPlane, scheduler } = harness({ maxConcurrentJobs: 1 });
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);

    runtime.failNextDispatch(new Error("runtime refused to launch"));
    const failed = await submit(controlPlane);
    expect(failed.job.lifecycle.status).toBe("settled");
    expect(controlPlane.getJob(failed.job.id).record.lifecycle.status).toBe("settled");
    expect(scheduler.activeCount).toBe(0);

    runtime.allowDispatch();
    const next = await submit(controlPlane);
    expect(runtime.dispatched.map((entry) => entry.jobId)).toEqual([next.job.id]);
    expect(scheduler.activeCount).toBe(1);
  });

  it("releases the slot exactly once even when a duplicate report arrives", async () => {
    const { controlPlane, scheduler } = harness({ maxConcurrentJobs: 2 });
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);

    const job = await submit(controlPlane);
    const report = runtime.report(job.job.id, completed);
    await controlPlane.ingestReport(report);
    const duplicate = await controlPlane.ingestReport(report);

    expect(duplicate.status).toBe("already-settled");
    expect(scheduler.activeCount).toBe(0);
    expect(controlPlane.budgetReport().scopes[0]?.usage.jobsSettled).toBe(1);
  });

  it("frees the slot of a cancelled queued job without dispatching it", async () => {
    const { controlPlane, scheduler } = harness({ maxConcurrentJobs: 1 });
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);

    const running = await submit(controlPlane);
    const queued = await submit(controlPlane);
    await controlPlane.cancel(queued.job.id, "operator withdrew it");

    expect(runtime.dispatched.map((entry) => entry.jobId)).toEqual([running.job.id]);
    expect(controlPlane.getJob(queued.job.id).record.lifecycle.status).toBe("settled");
    expect(scheduler.activeCount).toBe(1);
    expect(controlPlane.queueSnapshot().queued).toHaveLength(0);
  });

  it("refuses a delegation that exceeds its tree's declared job budget", async () => {
    const { controlPlane } = harness({ maxJobs: 1 });
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);

    const parent = await submit(controlPlane);
    const delegate = () =>
      controlPlane.delegate({
        delegationId: randomUUID(),
        correlationId: parent.job.correlationId,
        parentJobId: parent.job.id,
        request: baseRequest,
      });

    await expect(delegate()).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(controlPlane.listJobs()).toHaveLength(1);
    expect(runtime.dispatched).toHaveLength(1);

    // A separate top-level task is its own scope: Cyberdeck declares no global spend cap it was
    // never given.
    await expect(submit(controlPlane)).resolves.toBeDefined();
  });

  it("fails closed on a token budget when a provider reported no usage", async () => {
    const { controlPlane } = harness({ maxTotalTokens: 10_000 });
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);

    const parent = await submit(controlPlane);
    await controlPlane.ingestReport(runtime.report(parent.job.id, completed));

    const scope = controlPlane.budgetReport().scopes[0];
    expect(scope?.usage.totalTokens).toBeUndefined();
    expect(scope?.usage.jobsWithUnknownUsage).toBe(1);
    await expect(
      controlPlane.delegate({
        delegationId: randomUUID(),
        correlationId: parent.job.correlationId,
        parentJobId: parent.job.id,
        request: baseRequest,
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("debits a delegated child to its parent's budget scope exactly once", async () => {
    const { controlPlane } = harness({});
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);

    const parent = await submit(controlPlane);
    const child = await controlPlane.delegate({
      delegationId: randomUUID(),
      correlationId: parent.job.correlationId,
      parentJobId: parent.job.id,
      request: baseRequest,
    });

    await controlPlane.ingestReport(
      runtime.report(child.job.id, completed, { schemaVersion: 1, totalTokens: 250 }),
    );
    await controlPlane.ingestReport(
      runtime.report(child.job.id, completed, { schemaVersion: 1, totalTokens: 250 }),
    );

    const scopes = controlPlane.budgetReport().scopes;
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.scopeId).toBe(parent.job.id);
    expect(scopes[0]?.usage.jobsStarted).toBe(2);
    expect(scopes[0]?.usage.totalTokens).toBe(250);
  });

  it("refuses a delegation deeper than the configured depth before dispatch", async () => {
    const { controlPlane } = harness({});
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);

    const parent = await submit(controlPlane);
    const child = await controlPlane.delegate({
      delegationId: randomUUID(),
      correlationId: parent.job.correlationId,
      parentJobId: parent.job.id,
      request: baseRequest,
    });

    const dispatchedBefore = runtime.dispatched.length;
    await expect(
      controlPlane.delegate({
        delegationId: randomUUID(),
        correlationId: parent.job.correlationId,
        parentJobId: child.job.id,
        request: baseRequest,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneError);
    expect(runtime.dispatched).toHaveLength(dispatchedBefore);
  });

  it("never admits a queued Claude job whose model was omitted", async () => {
    const { controlPlane, scheduler } = harness({ maxConcurrentJobs: 4 });
    // The submit path already refuses this, so drive the admission boundary directly to prove that
    // free capacity alone can never promote an unknown Claude model into a launch.
    scheduler.enqueue({
      jobId: randomUUID(),
      provider: "claude",
      repositoryKey: "/tmp/repo",
      enqueuedAt: NOW,
    });
    expect(scheduler.admitNext()).toBeUndefined();

    await expect(
      submit(controlPlane, { provider: "claude", model: undefined }),
    ).rejects.toMatchObject({ code: "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL" });
  });
});
