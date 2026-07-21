import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobControlPlane } from "../../src/control-plane/job-control-plane.js";
import { defaultProviderRegistry } from "../../src/control-plane/provider-registry.js";
import { ControlPlaneReconciler } from "../../src/control-plane/reconciler.js";
import { WorktreeLeaseManager } from "../../src/control-plane/worktree-lease-manager.js";
import type { DispatchRequest, JobDispatchAdapter } from "../../src/domain/dispatch.js";
import type { JobReport } from "../../src/domain/job.js";
import { ArtifactStore } from "../../src/persistence/artifact-store.js";
import { JobStore } from "../../src/persistence/job-store.js";
import { LeaseStore } from "../../src/persistence/lease-store.js";

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
  const adapter: JobDispatchAdapter = {
    provider,
    async dispatch(request) {
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
  return { adapter, dispatched, listeners };
}

describe("control-plane reconciliation", () => {
  let directory: string;
  let clock: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cyberdeck-reconcile-"));
    clock = NOW;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function leaseManager(): WorktreeLeaseManager {
    return new WorktreeLeaseManager({
      store: new LeaseStore(directory),
      now: () => clock,
      repositoryInspector: {
        canonicalize: async (path) => path,
        isWorktreeDirty: async () => true,
      },
    });
  }

  async function controlPlaneWithInFlightJob() {
    const store = new JobStore(directory);
    const first = new JobControlPlane({ registry: defaultProviderRegistry(), store, now: () => NOW });
    const runtime = fakeRuntime("codex");
    first.registerAdapter(runtime.adapter);
    const job = await first.submit({ request: baseRequest, idempotencyKey: randomUUID() });

    // A fresh control plane over the same store models a broker restart mid-flight.
    const restarted = new JobControlPlane({
      registry: defaultProviderRegistry(),
      store,
      now: () => NOW,
    });
    return { restarted, jobId: job.job.id };
  }

  it("quarantines in-flight work no runtime can vouch for", async () => {
    const { restarted, jobId } = await controlPlaneWithInFlightJob();
    const reconciler = new ControlPlaneReconciler({
      controlPlane: restarted,
      leases: leaseManager(),
      now: () => NOW,
    });

    await restarted.recover();
    const report = await reconciler.reconcile();

    expect(restarted.getJob(jobId).record.lifecycle.status).toBe("interrupted");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "unverifiable-in-flight-job",
        subject: jobId,
        operatorActionRequired: true,
      }),
    );
    expect(report.findings.every((finding) => finding.destructive === false)).toBe(true);
  });

  it("leaves in-flight work alone when a supervised runtime still claims it", async () => {
    const store = new JobStore(directory);
    const controlPlane = new JobControlPlane({
      registry: defaultProviderRegistry(),
      store,
      now: () => NOW,
    });
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);
    const job = await controlPlane.submit({
      request: baseRequest,
      idempotencyKey: randomUUID(),
    });

    const reconciler = new ControlPlaneReconciler({
      controlPlane,
      leases: leaseManager(),
      runtimes: [{ provider: "codex", activeJobIds: () => [job.job.id] }],
      now: () => NOW,
    });
    const report = await reconciler.reconcile();

    expect(controlPlane.getJob(job.job.id).record.lifecycle.status).toBe("dispatched");
    expect(report.findings.filter((finding) => finding.kind === "unverifiable-in-flight-job")).toEqual(
      [],
    );
  });

  it("reports a runtime that claims a job the control plane never recorded", async () => {
    const controlPlane = new JobControlPlane({ registry: defaultProviderRegistry(), now: () => NOW });
    const reconciler = new ControlPlaneReconciler({
      controlPlane,
      leases: leaseManager(),
      runtimes: [{ provider: "codex", activeJobIds: () => ["ghost-job"] }],
      now: () => NOW,
    });

    const report = await reconciler.reconcile();
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "orphaned-runtime",
        subject: "ghost-job",
        operatorActionRequired: true,
      }),
    );
  });

  it("surfaces a restarted lease as an orphan requiring operator action, never releasing it", async () => {
    const manager = leaseManager();
    const grant = await manager.acquire({
      repositoryPath: "/tmp/repo",
      worktreePath: "/tmp/repo",
      access: "workspace-write",
      holderJobId: randomUUID(),
      ttlMs: 60_000,
    });

    const restartedManager = leaseManager();
    const reconciler = new ControlPlaneReconciler({
      controlPlane: new JobControlPlane({ registry: defaultProviderRegistry(), now: () => NOW }),
      leases: restartedManager,
      now: () => NOW,
    });
    const report = await reconciler.reconcile();

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "orphaned-lease",
        subject: grant.lease.leaseId,
        operatorActionRequired: true,
        destructive: false,
      }),
    );
    // The lease is still held: reconciliation fences nothing that is not provably stale.
    await expect(
      restartedManager.acquire({
        repositoryPath: "/tmp/repo",
        worktreePath: "/tmp/repo",
        access: "workspace-write",
        holderJobId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "LEASE_ORPHANED" });
  });

  it("fences a lease that is provably expired under the A4 rules", async () => {
    const manager = leaseManager();
    await manager.acquire({
      repositoryPath: "/tmp/repo",
      worktreePath: "/tmp/repo",
      access: "workspace-write",
      holderJobId: randomUUID(),
      ttlMs: 1_000,
    });

    clock = new Date(Date.parse(NOW) + 10_000).toISOString();
    const restartedManager = leaseManager();
    const reconciler = new ControlPlaneReconciler({
      controlPlane: new JobControlPlane({ registry: defaultProviderRegistry(), now: () => NOW }),
      leases: restartedManager,
      now: () => clock,
    });
    const report = await reconciler.reconcile();

    expect(report.findings.filter((finding) => finding.kind === "orphaned-lease")).toEqual([]);
    // The expired lease was fenced, so a fresh writable acquire succeeds.
    const next = await restartedManager.acquire({
      repositoryPath: "/tmp/repo",
      worktreePath: "/tmp/repo",
      access: "workspace-write",
      holderJobId: randomUUID(),
    });
    expect(next.fencingToken).toBe(2);
  });

  it("surfaces an unacknowledged report-back without delivering or acknowledging it", async () => {
    const controlPlane = new JobControlPlane({ registry: defaultProviderRegistry(), now: () => NOW });
    const runtime = fakeRuntime("codex");
    controlPlane.registerAdapter(runtime.adapter);

    const parent = await controlPlane.submit({
      request: baseRequest,
      idempotencyKey: randomUUID(),
    });
    const child = await controlPlane.delegate({
      delegationId: randomUUID(),
      correlationId: parent.job.correlationId,
      parentJobId: parent.job.id,
      request: baseRequest,
    });
    await controlPlane.ingestReport({
      schemaVersion: 1,
      jobId: child.job.id,
      correlationId: child.job.correlationId,
      reportedAt: NOW,
      result: { outcome: "completed", summary: "done", artifacts: [] },
    });

    const reconciler = new ControlPlaneReconciler({
      controlPlane,
      leases: leaseManager(),
      now: () => NOW,
    });
    const report = await reconciler.reconcile();

    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: "pending-report-back", subject: child.job.id }),
    );
    expect(controlPlane.getJob(child.job.id).reportBack?.state).toBe("pending");
  });

  it("surfaces stored artifacts no job result references, without deleting them", async () => {
    const artifacts = new ArtifactStore(directory);
    const stored = await artifacts.write({
      name: "report.txt",
      mediaType: "text/plain",
      content: "bounded output",
    });

    const reconciler = new ControlPlaneReconciler({
      controlPlane: new JobControlPlane({ registry: defaultProviderRegistry(), now: () => NOW }),
      leases: leaseManager(),
      artifacts,
      now: () => NOW,
    });
    const report = await reconciler.reconcile();

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "orphaned-artifact",
        subject: stored.descriptor.id,
        operatorActionRequired: true,
        destructive: false,
      }),
    );
    // The content is untouched: reconciliation reports, it never cleans up.
    await expect(artifacts.read(stored.descriptor.id)).resolves.toBeDefined();
  });

  it("is idempotent: a second pass changes nothing and reports the same findings", async () => {
    const { restarted, jobId } = await controlPlaneWithInFlightJob();
    const reconciler = new ControlPlaneReconciler({
      controlPlane: restarted,
      leases: leaseManager(),
      now: () => NOW,
    });

    await restarted.recover();
    const first = await reconciler.reconcile();
    const updatedAfterFirst = restarted.getJob(jobId).record.updatedAt;
    const second = await reconciler.reconcile();

    expect(second.findings).toEqual(first.findings);
    expect(restarted.getJob(jobId).record.updatedAt).toBe(updatedAfterFirst);
  });

  it("never dispatches, completes, or retries anything", async () => {
    const store = new JobStore(directory);
    const first = new JobControlPlane({ registry: defaultProviderRegistry(), store, now: () => NOW });
    const firstRuntime = fakeRuntime("codex");
    first.registerAdapter(firstRuntime.adapter);
    await first.submit({ request: baseRequest, idempotencyKey: randomUUID() });

    const restarted = new JobControlPlane({
      registry: defaultProviderRegistry(),
      store,
      now: () => NOW,
    });
    const runtime = fakeRuntime("codex");
    restarted.registerAdapter(runtime.adapter);
    await restarted.recover();

    const reconciler = new ControlPlaneReconciler({
      controlPlane: restarted,
      leases: leaseManager(),
      now: () => NOW,
    });
    await reconciler.reconcile();

    expect(runtime.dispatched).toHaveLength(0);
    expect(
      restarted.listJobs().filter((snapshot) => snapshot.record.lifecycle.status === "settled"),
    ).toHaveLength(0);
  });
});
