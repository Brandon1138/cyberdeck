import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerJobDispatchAdapter } from "../src/app-server/dispatch-adapter.js";
import { BrokerRuntimeConfigSchema } from "../src/config.js";
import { ControlPlaneError, type JobSnapshot } from "../src/control-plane/job-control-plane.js";
import { ControlPlaneRuntime } from "../src/control-plane/runtime.js";
import type {
  CancellationRequest,
  DispatchRequest,
  JobDispatchAdapter,
} from "../src/domain/dispatch.js";
import type { JobReport } from "../src/domain/job.js";

if (process.env.CYBERDECK_RUN_LIVE_CODEX_GATE !== "1") {
  throw new Error("Refusing a paid runtime call without CYBERDECK_RUN_LIVE_CODEX_GATE=1");
}

class ControlledFixtureAdapter implements JobDispatchAdapter {
  readonly provider = "gate-fixture";
  private readonly listeners = new Set<(report: JobReport) => void>();
  private readonly requests = new Map<string, DispatchRequest>();

  async dispatch(request: DispatchRequest) {
    this.requests.set(request.jobId, request);
    return { schemaVersion: 1 as const, jobId: request.jobId, acceptedAt: new Date().toISOString() };
  }

  async cancel(request: CancellationRequest) {
    return { accepted: false as const, jobId: request.jobId, code: "JOB_ALREADY_TERMINAL" as const };
  }

  onReport(listener: (report: JobReport) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  complete(jobId: string): void {
    const request = this.requests.get(jobId);
    if (request === undefined) throw new Error(`Fixture job ${jobId} was not dispatched`);
    const report: JobReport = {
      schemaVersion: 1,
      jobId: request.jobId,
      correlationId: request.correlationId,
      reportedAt: new Date().toISOString(),
      result: { outcome: "completed", summary: "gate parent complete", artifacts: [] },
    };
    for (const listener of this.listeners) listener(report);
  }
}

async function waitForTerminal(
  runtime: ControlPlaneRuntime,
  jobId: string,
  timeoutMs = 180_000,
): Promise<JobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = runtime.controlPlane.getJob(jobId);
    if (snapshot.record.lifecycle.status === "settled") return snapshot;
    if (snapshot.record.lifecycle.status === "interrupted") {
      throw new Error(`Job ${jobId} was interrupted: ${snapshot.record.lifecycle.reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

const stateDirectory = await mkdtemp(join(tmpdir(), "cyberdeck-live-codex-gate-"));
let runtime: ControlPlaneRuntime | undefined;
let recovered: ControlPlaneRuntime | undefined;

try {
  const fixture = new ControlledFixtureAdapter();
  let codexAdapter: AppServerJobDispatchAdapter | undefined;
  runtime = new ControlPlaneRuntime({
    stateDirectory,
    config: BrokerRuntimeConfigSchema.parse({
      concurrency: { maxConcurrentJobs: 1 },
      budget: { maxJobs: 2 },
    }),
    adapters: ({ leases, artifacts }) => {
      codexAdapter = new AppServerJobDispatchAdapter({
        leaseManager: leases,
        artifactStore: artifacts,
        timeoutMs: 120_000,
      });
      return [codexAdapter, fixture];
    },
  });

  const startingReconciliation = await runtime.start();
  if (runtime.controlPlane.listJobs().length !== 0 || codexAdapter?.activeJobCount !== 0) {
    throw new Error("Live gate did not begin from an empty runtime");
  }

  const parent = await runtime.controlPlane.submit({
    idempotencyKey: `gate-parent-${randomUUID()}`,
    request: {
      schemaVersion: 1,
      provider: fixture.provider,
      cwd: process.cwd(),
      sandbox: "read-only",
      instruction: "deterministic parent for the live Codex delegation gate",
      role: "gate-parent",
    },
  });
  fixture.complete(parent.job.id);
  await waitForTerminal(runtime, parent.job.id);

  const child = await runtime.controlPlane.delegate({
    delegationId: randomUUID(),
    correlationId: parent.job.correlationId,
    parentJobId: parent.job.id,
    request: {
      schemaVersion: 1,
      provider: "codex",
      cwd: process.cwd(),
      sandbox: "read-only",
      instruction: "Reply with exactly CYBERDECK_GATE_OK. Do not use tools.",
      role: "gate-opaque-role",
    },
  });
  const live = await waitForTerminal(runtime, child.job.id);
  if (live.record.lifecycle.status !== "settled" || live.record.lifecycle.result.outcome !== "completed") {
    throw new Error(`Live Codex job did not complete: ${JSON.stringify(live.record.lifecycle)}`);
  }
  if (live.record.lifecycle.result.summary?.trim() !== "CYBERDECK_GATE_OK") {
    throw new Error(`Unexpected live Codex result: ${live.record.lifecycle.result.summary ?? "<missing>"}`);
  }
  const descriptor = live.record.lifecycle.result.artifacts[0];
  if (descriptor === undefined) throw new Error("Live Codex result did not persist an artifact");
  const resolved = await runtime.artifacts.resolve(descriptor);
  if (resolved.toString("utf8").trim() !== "CYBERDECK_GATE_OK") {
    throw new Error("Persisted live artifact did not resolve to the validated result");
  }

  const acknowledged = await runtime.controlPlane.acknowledgeReport(child.job.id);
  if (acknowledged.state !== "delivered") throw new Error("Live child report-back was not delivered");

  let budgetCode: string | undefined;
  try {
    await runtime.controlPlane.delegate({
      delegationId: randomUUID(),
      correlationId: parent.job.correlationId,
      parentJobId: parent.job.id,
      request: {
        schemaVersion: 1,
        provider: "codex",
        cwd: process.cwd(),
        sandbox: "read-only",
        instruction: "must never dispatch",
      },
    });
  } catch (error) {
    if (error instanceof ControlPlaneError) budgetCode = error.code;
  }
  if (budgetCode !== "BUDGET_EXCEEDED" || codexAdapter?.activeJobCount !== 0) {
    throw new Error(`Budget refusal failed closed incorrectly: ${budgetCode ?? "no error"}`);
  }

  let claudeSafetyCode: string | undefined;
  try {
    await runtime.controlPlane.submit({
      idempotencyKey: `gate-claude-${randomUUID()}`,
      request: {
        schemaVersion: 1,
        provider: "claude",
        cwd: process.cwd(),
        sandbox: "read-only",
        instruction: "must never dispatch",
      },
    });
  } catch (error) {
    if (error instanceof ControlPlaneError) claudeSafetyCode = error.code;
  }
  if (claudeSafetyCode !== "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL") {
    throw new Error(`Omitted-model Claude safety failed: ${claudeSafetyCode ?? "no error"}`);
  }

  const lease = await runtime.leases.acquire({
    repositoryPath: process.cwd(),
    worktreePath: process.cwd(),
    access: "workspace-write",
    holderJobId: child.job.id,
  });
  let leaseConflictCode: string | undefined;
  try {
    await runtime.leases.acquire({
      repositoryPath: process.cwd(),
      worktreePath: process.cwd(),
      access: "workspace-write",
      holderJobId: randomUUID(),
    });
  } catch (error) {
    leaseConflictCode = (error as { code?: string }).code;
  }
  if (leaseConflictCode !== "LEASE_CONFLICT") {
    throw new Error(`Lease conflict was not refused: ${leaseConflictCode ?? "no error"}`);
  }
  await runtime.leases.release(lease);

  await runtime.shutdown("live gate restart");
  runtime = undefined;

  let recoveredCodexAdapter: AppServerJobDispatchAdapter | undefined;
  recovered = new ControlPlaneRuntime({
    stateDirectory,
    config: BrokerRuntimeConfigSchema.parse({
      concurrency: { maxConcurrentJobs: 1 },
      budget: { maxJobs: 2 },
    }),
    adapters: ({ leases, artifacts }) => {
      recoveredCodexAdapter = new AppServerJobDispatchAdapter({
        leaseManager: leases,
        artifactStore: artifacts,
        timeoutMs: 120_000,
      });
      return [recoveredCodexAdapter, new ControlledFixtureAdapter()];
    },
  });
  const restartReconciliation = await recovered.start();
  const rebuilt = recovered.controlPlane.getJob(child.job.id);
  if (
    rebuilt.record.lifecycle.status !== "settled" ||
    rebuilt.reportBack?.state !== "delivered" ||
    recoveredCodexAdapter?.activeJobCount !== 0
  ) {
    throw new Error("Restart did not reconstruct terminal state without recovering a runtime");
  }
  const rebuiltDescriptor =
    rebuilt.record.lifecycle.status === "settled" &&
    rebuilt.record.lifecycle.result.outcome === "completed"
      ? rebuilt.record.lifecycle.result.artifacts[0]
      : undefined;
  if (rebuiltDescriptor === undefined) throw new Error("Restart lost the live artifact descriptor");
  await recovered.artifacts.resolve(rebuiltDescriptor);

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    provider: "codex",
    liveModelCalls: 1,
    fableProcessesStarted: 0,
    parentJobId: parent.job.id,
    liveJobId: child.job.id,
    correlationId: child.job.correlationId,
    role: child.job.request.role,
    model: child.job.request.model ?? null,
    outcome: rebuilt.record.lifecycle.result.outcome,
    artifactId: rebuiltDescriptor.id,
    artifactBytes: rebuiltDescriptor.byteLength,
    reportBack: rebuilt.reportBack?.state,
    budgetRefusal: budgetCode,
    omittedClaudeRefusal: claudeSafetyCode,
    leaseConflict: leaseConflictCode,
    startingFindings: startingReconciliation.findings.length,
    restartFindings: restartReconciliation.findings.length,
    recoveredProviderProcesses: recoveredCodexAdapter?.activeJobCount ?? 0,
  })}\n`);
} finally {
  await runtime?.shutdown("live gate cleanup").catch(() => undefined);
  await recovered?.shutdown("live gate cleanup").catch(() => undefined);
  await rm(stateDirectory, { recursive: true, force: true });
}
