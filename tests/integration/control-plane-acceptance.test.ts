import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { ControlPlaneRuntime } from "../../src/control-plane/runtime.js";
import { WorktreeLeaseManager } from "../../src/control-plane/worktree-lease-manager.js";
import type {
  CancellationRequest,
  DispatchRequest,
  JobDispatchAdapter,
} from "../../src/domain/dispatch.js";
import type { JobReport, JobResult } from "../../src/domain/job.js";
import type { UsageReport } from "../../src/domain/usage.js";
import { ArtifactStore } from "../../src/persistence/artifact-store.js";
import { LeaseStore } from "../../src/persistence/lease-store.js";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

/** A real, empty Git repository so lease canonicalization runs against genuine paths. */
async function temporaryRepository(): Promise<string> {
  const path = await temporaryDirectory("cyberdeck-acceptance-repo-");
  await run("git", ["init", "--quiet", path]);
  return path;
}

/**
 * A deterministic fake terminal/App Server runtime. It records what it was asked to launch and
 * settles only when the test says so, so ordering, cancellation, and duplicate delivery are all
 * observable without a provider process ever existing.
 */
function fakeRuntime(provider: string) {
  const listeners = new Set<(report: JobReport) => void>();
  const dispatched: DispatchRequest[] = [];
  const cancelled: CancellationRequest[] = [];
  const state = { failDispatch: undefined as Error | undefined };

  const adapter: JobDispatchAdapter = {
    provider,
    async dispatch(request) {
      if (state.failDispatch !== undefined) throw state.failDispatch;
      dispatched.push(request);
      return { schemaVersion: 1, jobId: request.jobId, acceptedAt: new Date().toISOString() };
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

  function emit(jobId: string, result: JobResult, usage?: UsageReport): void {
    const dispatch = dispatched.find((entry) => entry.jobId === jobId);
    if (dispatch === undefined) throw new Error(`nothing dispatched for ${jobId}`);
    const report: JobReport = {
      schemaVersion: 1,
      jobId: dispatch.jobId,
      correlationId: dispatch.correlationId,
      reportedAt: new Date().toISOString(),
      result,
      ...(usage !== undefined ? { usage } : {}),
    };
    for (const listener of [...listeners]) listener(report);
  }

  return {
    adapter,
    dispatched,
    cancelled,
    emit,
    activeJobIds: () => dispatched.map((entry) => entry.jobId),
    failNextDispatch: (error: Error) => {
      state.failDispatch = error;
    },
    allowDispatch: () => {
      state.failDispatch = undefined;
    },
    complete: (jobId: string, usage?: UsageReport) =>
      emit(jobId, { outcome: "completed", summary: "bounded work complete", artifacts: [] }, usage),
    timeout: (jobId: string) => emit(jobId, { outcome: "timedOut" }),
  };
}

async function composed(options: {
  stateDirectory: string;
  runtimes: ReturnType<typeof fakeRuntime>[];
  config?: Record<string, unknown>;
}): Promise<ControlPlaneRuntime> {
  const runtime = new ControlPlaneRuntime({
    stateDirectory: options.stateDirectory,
    config: BrokerRuntimeConfigSchema.parse(options.config ?? {}),
    adapters: options.runtimes.map((entry) => entry.adapter),
  });
  await runtime.start();
  return runtime;
}

const requestFor = (provider: string, cwd: string, overrides: Record<string, unknown> = {}) => ({
  provider,
  cwd,
  sandbox: "read-only" as const,
  instruction: "produce a bounded summary",
  ...overrides,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("control-plane end-to-end acceptance (fakes only)", () => {
  it("runs mixed providers by explicit selection with no fallback between them", async () => {
    const state = await temporaryDirectory("cyberdeck-acceptance-");
    const repository = await temporaryRepository();
    const codex = fakeRuntime("codex");
    const cursor = fakeRuntime("cursor");
    const antigravity = fakeRuntime("antigravity");
    const runtime = await composed({ stateDirectory: state, runtimes: [codex, cursor, antigravity] });

    const jobs = [];
    for (const provider of ["codex", "cursor", "antigravity"]) {
      jobs.push(
        await runtime.controlPlane.submit({
          request: requestFor(provider, repository),
          idempotencyKey: randomUUID(),
        }),
      );
    }

    expect(codex.dispatched).toHaveLength(1);
    expect(cursor.dispatched).toHaveLength(1);
    expect(antigravity.dispatched).toHaveLength(1);
    expect(codex.dispatched[0]?.request.provider).toBe("codex");

    // An unregistered provider is refused outright rather than served by another adapter.
    await expect(
      runtime.controlPlane.submit({
        request: requestFor("not-registered", repository),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_REGISTERED" });

    // A failing runtime never spills over to a different provider either.
    cursor.emit(jobs[1]!.job.id, {
      outcome: "failed",
      error: { code: "DISPATCH_REJECTED", message: "cursor runtime refused" },
      artifacts: [],
    });
    await flush();
    expect(codex.dispatched).toHaveLength(1);
    expect(antigravity.dispatched).toHaveLength(1);
    await runtime.shutdown("test");
  });

  it("saturates concurrency and releases fairly in enqueue order", async () => {
    const state = await temporaryDirectory("cyberdeck-acceptance-");
    const repository = await temporaryRepository();
    const codex = fakeRuntime("codex");
    const runtime = await composed({
      stateDirectory: state,
      runtimes: [codex],
      config: { concurrency: { maxConcurrentJobs: 2 } },
    });

    const submitted = [];
    for (let index = 0; index < 4; index += 1) {
      submitted.push(
        await runtime.controlPlane.submit({
          request: requestFor("codex", repository),
          idempotencyKey: randomUUID(),
        }),
      );
    }

    expect(codex.dispatched.map((entry) => entry.jobId)).toEqual([
      submitted[0]!.job.id,
      submitted[1]!.job.id,
    ]);
    expect(runtime.queueSnapshot().queued).toHaveLength(2);

    codex.complete(submitted[0]!.job.id);
    await runtime.controlPlane.whenIdle();
    expect(codex.dispatched.map((entry) => entry.jobId)).toContain(submitted[2]!.job.id);

    codex.complete(submitted[1]!.job.id);
    await runtime.controlPlane.whenIdle();
    expect(codex.dispatched.map((entry) => entry.jobId)).toEqual(
      submitted.map((entry) => entry.job.id),
    );
    expect(runtime.queueSnapshot().queued).toHaveLength(0);
    await runtime.shutdown("test");
  });

  it("serializes two jobs contending for one writable repository", async () => {
    const state = await temporaryDirectory("cyberdeck-acceptance-");
    const repository = await temporaryRepository();
    const codex = fakeRuntime("codex");
    const runtime = await composed({
      stateDirectory: state,
      runtimes: [codex],
      config: { concurrency: { maxConcurrentPerRepository: 1 } },
    });

    const first = await runtime.controlPlane.submit({
      request: requestFor("codex", repository, { sandbox: "workspace-write" }),
      idempotencyKey: randomUUID(),
    });
    const second = await runtime.controlPlane.submit({
      request: requestFor("codex", repository, { sandbox: "workspace-write" }),
      idempotencyKey: randomUUID(),
    });

    expect(codex.dispatched.map((entry) => entry.jobId)).toEqual([first.job.id]);
    expect(runtime.queueSnapshot().queued[0]).toMatchObject({
      jobId: second.job.id,
      blockedBy: "MAX_CONCURRENT_PER_REPOSITORY",
    });

    // Exclusive writable access is proven separately by a lease on the same canonical repository.
    const leases = new WorktreeLeaseManager({ store: new LeaseStore(state) });
    const held = await leases.acquire({
      repositoryPath: repository,
      worktreePath: repository,
      access: "workspace-write",
      holderJobId: first.job.id,
    });
    await expect(
      leases.acquire({
        repositoryPath: repository,
        worktreePath: repository,
        access: "workspace-write",
        holderJobId: second.job.id,
      }),
    ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    await leases.release(held);

    codex.complete(first.job.id);
    await runtime.controlPlane.whenIdle();
    expect(codex.dispatched.map((entry) => entry.jobId)).toEqual([first.job.id, second.job.id]);
    await runtime.shutdown("test");
  });

  it("handles cancellation during launch and during execution", async () => {
    const state = await temporaryDirectory("cyberdeck-acceptance-");
    const repository = await temporaryRepository();
    const codex = fakeRuntime("codex");
    const runtime = await composed({
      stateDirectory: state,
      runtimes: [codex],
      config: { concurrency: { maxConcurrentJobs: 1 } },
    });

    // Failure during launch settles the job and returns its slot.
    codex.failNextDispatch(new Error("runtime refused to launch"));
    const failedLaunch = await runtime.controlPlane.submit({
      request: requestFor("codex", repository),
      idempotencyKey: randomUUID(),
    });
    expect(runtime.controlPlane.getJob(failedLaunch.job.id).record.lifecycle).toMatchObject({
      status: "settled",
      result: { outcome: "failed" },
    });
    codex.allowDispatch();

    // Cancellation of a running job reaches the adapter and settles as cancelled.
    const running = await runtime.controlPlane.submit({
      request: requestFor("codex", repository),
      idempotencyKey: randomUUID(),
    });
    await runtime.controlPlane.cancel(running.job.id, "operator cancelled");
    expect(codex.cancelled.map((entry) => entry.jobId)).toEqual([running.job.id]);
    expect(runtime.controlPlane.getJob(running.job.id).record.lifecycle).toMatchObject({
      status: "settled",
      result: { outcome: "cancelled", reason: "operator cancelled" },
    });

    // A timeout reported by the runtime is a distinct terminal outcome, not a failure or a retry.
    const timing = await runtime.controlPlane.submit({
      request: requestFor("codex", repository),
      idempotencyKey: randomUUID(),
    });
    codex.timeout(timing.job.id);
    await runtime.controlPlane.whenIdle();
    expect(runtime.controlPlane.getJob(timing.job.id).record.lifecycle).toMatchObject({
      status: "settled",
      result: { outcome: "timedOut" },
    });
    expect(runtime.queueSnapshot().reservations).toHaveLength(0);
    await runtime.shutdown("test");
  });

  it("rejects work once a budget is exhausted and fails closed on unknown usage", async () => {
    const state = await temporaryDirectory("cyberdeck-acceptance-");
    const repository = await temporaryRepository();
    const codex = fakeRuntime("codex");
    const runtime = await composed({
      stateDirectory: state,
      runtimes: [codex],
      config: { budget: { maxJobs: 3, maxTotalTokens: 5_000 } },
    });

    const root = await runtime.controlPlane.submit({
      request: requestFor("codex", repository),
      idempotencyKey: randomUUID(),
    });
    const delegate = () =>
      runtime.controlPlane.delegate({
        delegationId: randomUUID(),
        correlationId: root.job.correlationId,
        parentJobId: root.job.id,
        request: requestFor("codex", repository),
      });

    const child = await delegate();
    codex.complete(child.job.id, { schemaVersion: 1, totalTokens: 400 });
    await runtime.controlPlane.whenIdle();
    expect(runtime.budgetReport().scopes[0]?.usage.totalTokens).toBe(400);

    // A provider that reports nothing leaves usage unknown, which makes the ceiling unprovable.
    const silent = await delegate();
    codex.complete(silent.job.id);
    await runtime.controlPlane.whenIdle();

    const scope = runtime.budgetReport().scopes[0];
    expect(scope?.usage.jobsWithUnknownUsage).toBe(1);
    expect(scope?.usage.totalTokens).toBe(400);
    expect(scope?.exhausted).toBe(true);
    await expect(delegate()).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await runtime.shutdown("test");
  });

  it("recovers a broker restart during an in-flight job without redispatching it", async () => {
    const state = await temporaryDirectory("cyberdeck-acceptance-");
    const repository = await temporaryRepository();
    const before = fakeRuntime("codex");
    const first = await composed({ stateDirectory: state, runtimes: [before] });
    const inFlight = await first.controlPlane.submit({
      request: requestFor("codex", repository),
      idempotencyKey: randomUUID(),
    });
    expect(before.dispatched).toHaveLength(1);

    const after = fakeRuntime("codex");
    const restarted = await composed({ stateDirectory: state, runtimes: [after] });

    expect(after.dispatched).toHaveLength(0);
    const recovered = restarted.controlPlane.getJob(inFlight.job.id).record;
    expect(recovered.lifecycle.status).toBe("interrupted");
    expect(recovered.request).toEqual(inFlight.job.request);
    expect(restarted.lastReconciliation()?.findings).toContainEqual(
      expect.objectContaining({
        kind: "unverifiable-in-flight-job",
        subject: inFlight.job.id,
        operatorActionRequired: true,
      }),
    );
    await restarted.shutdown("test");
  });

  it("ignores a duplicate adapter completion and acknowledges the report-back once", async () => {
    const state = await temporaryDirectory("cyberdeck-acceptance-");
    const repository = await temporaryRepository();
    const codex = fakeRuntime("codex");
    const runtime = await composed({ stateDirectory: state, runtimes: [codex] });

    const parent = await runtime.controlPlane.submit({
      request: requestFor("codex", repository),
      idempotencyKey: randomUUID(),
    });
    const child = await runtime.controlPlane.delegate({
      delegationId: randomUUID(),
      correlationId: parent.job.correlationId,
      parentJobId: parent.job.id,
      request: requestFor("codex", repository),
    });

    codex.complete(child.job.id, { schemaVersion: 1, totalTokens: 120 });
    codex.complete(child.job.id, { schemaVersion: 1, totalTokens: 120 });
    await runtime.controlPlane.whenIdle();

    const settled = runtime.controlPlane.getJob(child.job.id);
    expect(settled.record.lifecycle.status).toBe("settled");
    expect(settled.reportBack?.state).toBe("pending");
    expect(runtime.budgetReport().scopes[0]?.usage.totalTokens).toBe(120);

    const acknowledged = await runtime.controlPlane.acknowledgeReport(child.job.id);
    const again = await runtime.controlPlane.acknowledgeReport(child.job.id);
    expect(acknowledged.state).toBe("delivered");
    expect(again.deliveredAt).toBe(acknowledged.deliveredAt);
    expect(runtime.controlPlane.listReportBacks()).toHaveLength(1);
    await runtime.shutdown("test");
  });

  it("fences only provably stale leases and reconciles the rest non-destructively", async () => {
    const state = await temporaryDirectory("cyberdeck-acceptance-");
    const expiredRepository = await temporaryRepository();
    const heldRepository = await temporaryRepository();
    let clock = new Date().toISOString();

    const manager = () =>
      new WorktreeLeaseManager({ store: new LeaseStore(state), now: () => clock });
    const before = manager();
    await before.acquire({
      repositoryPath: expiredRepository,
      worktreePath: expiredRepository,
      access: "workspace-write",
      holderJobId: randomUUID(),
      ttlMs: 1_000,
    });
    const stillHeld = await before.acquire({
      repositoryPath: heldRepository,
      worktreePath: heldRepository,
      access: "workspace-write",
      holderJobId: randomUUID(),
      ttlMs: 600_000,
    });

    clock = new Date(Date.parse(clock) + 60_000).toISOString();
    const after = manager();
    const evidence = await after.recover();

    // The expired lease was fenced; the unexpired one survives as a blocking orphan.
    expect(evidence.map((entry) => entry.leaseId)).toEqual([stillHeld.lease.leaseId]);
    expect(evidence[0]?.manualRemediationRequired).toBe(true);

    const reacquired = await after.acquire({
      repositoryPath: expiredRepository,
      worktreePath: expiredRepository,
      access: "workspace-write",
      holderJobId: randomUUID(),
    });
    expect(reacquired.fencingToken).toBe(2);
    await expect(
      after.acquire({
        repositoryPath: heldRepository,
        worktreePath: heldRepository,
        access: "workspace-write",
        holderJobId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "LEASE_ORPHANED" });

    // Nothing destructive: the assessment refuses cleanup and both repositories still exist.
    const assessment = await after.assessOrphanCleanup(stillHeld);
    expect(assessment.safeToDelete).toBe(false);
    await expect(run("git", ["-C", heldRepository, "status", "--porcelain"])).resolves.toBeDefined();
  });

  it("carries a delegation from parent to child result, artifact, and acknowledged report-back", async () => {
    const state = await temporaryDirectory("cyberdeck-acceptance-");
    const repository = await temporaryRepository();
    const codex = fakeRuntime("codex");
    const runtime = await composed({ stateDirectory: state, runtimes: [codex] });
    const artifacts = new ArtifactStore(state);

    const parent = await runtime.controlPlane.submit({
      request: requestFor("codex", repository),
      idempotencyKey: randomUUID(),
    });
    const child = await runtime.controlPlane.delegate({
      delegationId: randomUUID(),
      correlationId: parent.job.correlationId,
      parentJobId: parent.job.id,
      request: requestFor("codex", repository, { role: "scout", model: "gpt-fixture" }),
    });

    const stored = await artifacts.write({
      name: "summary.md",
      mediaType: "text/markdown",
      content: "# bounded result\n",
      producedByJobId: child.job.id,
    });
    codex.emit(
      child.job.id,
      { outcome: "completed", summary: "child finished", artifacts: [stored.descriptor] },
      { schemaVersion: 1, totalTokens: 90 },
    );
    await runtime.controlPlane.whenIdle();

    const settled = runtime.controlPlane.getJob(child.job.id);
    expect(settled.record.parentJobId).toBe(parent.job.id);
    expect(settled.record.correlationId).toBe(parent.job.correlationId);
    // An opaque role is preserved verbatim and never interpreted.
    expect(settled.record.request.role).toBe("scout");
    expect(settled.usage?.totalTokens).toBe(90);

    const lifecycle = settled.record.lifecycle;
    if (lifecycle.status !== "settled" || lifecycle.result.outcome !== "completed") {
      throw new Error("expected a completed child result");
    }
    const descriptor = lifecycle.result.artifacts[0];
    expect(descriptor?.producedByJobId).toBe(child.job.id);
    const resolved = await artifacts.read(descriptor!.id);
    expect(resolved.content.toString("utf8")).toBe("# bounded result\n");

    expect(settled.reportBack?.state).toBe("pending");
    const acknowledged = await runtime.controlPlane.acknowledgeReport(child.job.id);
    expect(acknowledged.state).toBe("delivered");
    expect(runtime.budgetReport().scopes[0]?.usage.artifactBytes).toBe(
      stored.descriptor.byteLength,
    );

    // Reconciliation now has nothing outstanding to report for this tree.
    const reconciliation = await runtime.reconcile();
    expect(reconciliation.findings.filter((finding) => finding.kind === "pending-report-back")).toEqual(
      [],
    );
    await runtime.shutdown("test");
  });
});
