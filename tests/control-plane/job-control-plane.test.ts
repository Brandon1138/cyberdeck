import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ControlPlaneError,
  JobControlPlane,
} from "../../src/control-plane/job-control-plane.js";
import { defaultProviderRegistry } from "../../src/control-plane/provider-registry.js";
import type {
  CancellationRequest,
  DispatchRequest,
  JobDispatchAdapter,
} from "../../src/domain/dispatch.js";
import type { ControlPlaneErrorCode } from "../../src/domain/control-plane.js";
import type { JobReport, JobResult } from "../../src/domain/job.js";

const NOW = "2026-07-21T00:00:00.000Z";

const baseRequest = {
  provider: "codex",
  cwd: "/tmp/repo",
  sandbox: "read-only" as const,
  instruction: "summarize the repository without changing files",
};

interface FakeAdapter {
  adapter: JobDispatchAdapter;
  dispatched: DispatchRequest[];
  cancelled: CancellationRequest[];
  emit(report: JobReport): void;
  failDispatch(error: Error): void;
  refuseCancel(code: ControlPlaneErrorCode): void;
}

function fakeAdapter(provider: string): FakeAdapter {
  const listeners = new Set<(report: JobReport) => void>();
  const dispatched: DispatchRequest[] = [];
  const cancelled: CancellationRequest[] = [];
  const state = {
    dispatchError: undefined as Error | undefined,
    cancelAccepted: true,
    cancelCode: "CANCELLATION_NOT_SUPPORTED" as ControlPlaneErrorCode,
  };
  const adapter: JobDispatchAdapter = {
    provider,
    async dispatch(request) {
      if (state.dispatchError !== undefined) throw state.dispatchError;
      dispatched.push(request);
      return { schemaVersion: 1, jobId: request.jobId, acceptedAt: NOW };
    },
    async cancel(request) {
      cancelled.push(request);
      return state.cancelAccepted
        ? { accepted: true, jobId: request.jobId }
        : { accepted: false, jobId: request.jobId, code: state.cancelCode };
    },
    onReport(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    adapter,
    dispatched,
    cancelled,
    emit(report) {
      for (const listener of [...listeners]) listener(report);
    },
    failDispatch(error) {
      state.dispatchError = error;
    },
    refuseCancel(code) {
      state.cancelAccepted = false;
      state.cancelCode = code;
    },
  };
}

function makeReport(
  jobId: string,
  correlationId: string,
  result: JobResult,
  usage?: JobReport["usage"],
): JobReport {
  return {
    schemaVersion: 1,
    jobId,
    correlationId,
    reportedAt: NOW,
    result,
    ...(usage !== undefined ? { usage } : {}),
  } as JobReport;
}

function newPlane(): JobControlPlane {
  return new JobControlPlane({ registry: defaultProviderRegistry(), now: () => NOW });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("JobControlPlane submission", () => {
  let plane: JobControlPlane;
  let codex: FakeAdapter;

  beforeEach(() => {
    plane = newPlane();
    codex = fakeAdapter("codex");
    plane.registerAdapter(codex.adapter);
  });

  it("submits a job as dispatched through the neutral port", async () => {
    const { job, deduplicated } = await plane.submit({
      request: baseRequest,
      idempotencyKey: "k1",
    });
    expect(deduplicated).toBe(false);
    expect(job.lifecycle.status).toBe("dispatched");
    expect(codex.dispatched).toHaveLength(1);
    expect(codex.dispatched[0]?.request.provider).toBe("codex");
    expect(codex.dispatched[0]?.jobId).toBe(job.id);
  });

  it("keeps arbitrary opaque model and role strings without routing on them", async () => {
    const { job } = await plane.submit({
      request: { ...baseRequest, model: "luna-anything", role: "night-shift-scribe" },
      idempotencyKey: "k-opaque",
    });
    expect(job.request.model).toBe("luna-anything");
    expect(job.request.role).toBe("night-shift-scribe");
    expect(codex.dispatched).toHaveLength(1);
  });

  it("does not create a duplicate job for a repeated idempotency key", async () => {
    const first = await plane.submit({ request: baseRequest, idempotencyKey: "same" });
    const second = await plane.submit({ request: baseRequest, idempotencyKey: "same" });
    expect(second.deduplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(plane.listJobs()).toHaveLength(1);
    expect(codex.dispatched).toHaveLength(1);
  });

  it("rejects an unregistered provider before creating a job", async () => {
    await expectCode(
      plane.submit({ request: { ...baseRequest, provider: "cursor" }, idempotencyKey: "k-cursor" }),
      "PROVIDER_NOT_REGISTERED",
    );
    expect(plane.listJobs()).toHaveLength(0);
  });
});

describe("JobControlPlane launch safety", () => {
  let plane: JobControlPlane;
  let claude: FakeAdapter;
  let codex: FakeAdapter;

  beforeEach(() => {
    plane = newPlane();
    claude = fakeAdapter("claude");
    codex = fakeAdapter("codex");
    plane.registerAdapter(claude.adapter);
    plane.registerAdapter(codex.adapter);
  });

  it("rejects a delegated Fable job before invoking the launch port", async () => {
    const parent = await plane.submit({ request: baseRequest, idempotencyKey: "parent" });
    await expectCode(
      plane.delegate({
        delegationId: randomUUID(),
        correlationId: randomUUID(),
        parentJobId: parent.job.id,
        request: { ...baseRequest, provider: "claude", model: "fable-5" },
      }),
      "FABLE_REQUIRES_EXPLICIT_HUMAN_START",
    );
    expect(claude.dispatched).toHaveLength(0);
  });

  it("inherits Caveman worker mode through a bounded job tree", async () => {
    const parent = await plane.submit({
      request: { ...baseRequest, workerMode: "caveman" },
      idempotencyKey: "parent-caveman",
    });
    const child = await plane.delegate({
      delegationId: randomUUID(),
      correlationId: randomUUID(),
      parentJobId: parent.job.id,
      request: baseRequest,
    });

    expect(child.job.request.workerMode).toBe("caveman");
    expect(codex.dispatched.at(-1)?.request.workerMode).toBe("caveman");
  });

  it("rejects a live Claude job with an omitted model, not treating omission as safe", async () => {
    await expectCode(
      plane.submit({ request: { ...baseRequest, provider: "claude" }, idempotencyKey: "k-omit" }),
      "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_MODEL",
    );
    expect(claude.dispatched).toHaveLength(0);
  });

  it("dispatches a Claude job given an explicit non-Fable model", async () => {
    const { job } = await plane.submit({
      request: { ...baseRequest, provider: "claude", model: "sonnet-5" },
      idempotencyKey: "k-claude-ok",
    });
    expect(job.lifecycle.status).toBe("dispatched");
    expect(claude.dispatched).toHaveLength(1);
  });

  it("dispatches an operator-submitted Claude job with an explicit Fable model", async () => {
    await plane.submit({
      request: { ...baseRequest, provider: "claude", model: "fable-5" },
      idempotencyKey: "k-fable-top-level",
    });
    expect(claude.dispatched).toHaveLength(1);
  });
});

describe("JobControlPlane completion", () => {
  let plane: JobControlPlane;
  let codex: FakeAdapter;

  beforeEach(() => {
    plane = newPlane();
    codex = fakeAdapter("codex");
    plane.registerAdapter(codex.adapter);
  });

  it("settles a job and exposes the terminal result envelope with reported usage", async () => {
    const { job } = await plane.submit({ request: baseRequest, idempotencyKey: "k" });
    const outcome = await plane.ingestReport(
      makeReport(
        job.id,
        job.correlationId,
        { outcome: "completed", summary: "done", artifacts: [] },
        { schemaVersion: 1, inputTokens: 10, outputTokens: 20 },
      ),
    );
    expect(outcome.status).toBe("settled");
    const snapshot = plane.getJob(job.id);
    expect(snapshot.record.lifecycle.status).toBe("settled");
    expect(snapshot.record.request.provider).toBe("codex");
    if (snapshot.record.lifecycle.status === "settled") {
      expect(snapshot.record.lifecycle.result.outcome).toBe("completed");
    }
    expect(snapshot.usage?.inputTokens).toBe(10);
    expect(snapshot.reportBack).toBeUndefined();
  });

  it("leaves usage unknown when the adapter omits it, never fabricating zero", async () => {
    const { job } = await plane.submit({ request: baseRequest, idempotencyKey: "k" });
    await plane.ingestReport(
      makeReport(job.id, job.correlationId, { outcome: "completed", artifacts: [] }),
    );
    expect(plane.getJob(job.id).usage).toBeUndefined();
  });

  it("is idempotent on a duplicate completion report", async () => {
    const { job } = await plane.submit({ request: baseRequest, idempotencyKey: "k" });
    const report = makeReport(job.id, job.correlationId, { outcome: "completed", artifacts: [] });
    const first = await plane.ingestReport(report);
    const second = await plane.ingestReport(report);
    expect(first.status).toBe("settled");
    expect(second.status).toBe("already-settled");
    expect(plane.listJobs()).toHaveLength(1);
  });

  it("keeps the first terminal result when a conflicting later report arrives", async () => {
    const { job } = await plane.submit({ request: baseRequest, idempotencyKey: "k" });
    await plane.ingestReport(
      makeReport(job.id, job.correlationId, { outcome: "completed", artifacts: [] }),
    );
    const second = await plane.ingestReport(
      makeReport(job.id, job.correlationId, {
        outcome: "failed",
        error: { code: "DISPATCH_REJECTED", message: "late failure" },
        artifacts: [],
      }),
    );
    expect(second.status).toBe("already-settled");
    const snapshot = plane.getJob(job.id);
    if (snapshot.record.lifecycle.status === "settled") {
      expect(snapshot.record.lifecycle.result.outcome).toBe("completed");
    }
  });

  it("returns unknown-job for a report with no matching job", async () => {
    const outcome = await plane.ingestReport(
      makeReport(randomUUID(), randomUUID(), { outcome: "completed", artifacts: [] }),
    );
    expect(outcome.status).toBe("unknown-job");
  });

  it("settles the job as failed when the adapter dispatch throws", async () => {
    codex.failDispatch(new Error("adapter exploded"));
    const { job } = await plane.submit({ request: baseRequest, idempotencyKey: "k" });
    const snapshot = plane.getJob(job.id);
    expect(snapshot.record.lifecycle.status).toBe("settled");
    if (snapshot.record.lifecycle.status === "settled") {
      const result = snapshot.record.lifecycle.result;
      expect(result.outcome).toBe("failed");
      if (result.outcome === "failed") expect(result.error.code).toBe("DISPATCH_REJECTED");
    }
    expect(codex.dispatched).toHaveLength(0);
  });

  it("routes a report emitted through the adapter subscription", async () => {
    const { job } = await plane.submit({ request: baseRequest, idempotencyKey: "k" });
    codex.emit(makeReport(job.id, job.correlationId, { outcome: "completed", artifacts: [] }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(plane.getJob(job.id).record.lifecycle.status).toBe("settled");
  });
});

describe("JobControlPlane cancellation", () => {
  let plane: JobControlPlane;
  let codex: FakeAdapter;

  beforeEach(() => {
    plane = newPlane();
    codex = fakeAdapter("codex");
    plane.registerAdapter(codex.adapter);
  });

  it("cancels a dispatched job through the port and settles it cancelled", async () => {
    const { job } = await plane.submit({ request: baseRequest, idempotencyKey: "k" });
    const result = await plane.cancel(job.id, "operator abort");
    expect(result.accepted).toBe(true);
    expect(codex.cancelled).toHaveLength(1);
    const snapshot = plane.getJob(job.id);
    if (snapshot.record.lifecycle.status === "settled") {
      expect(snapshot.record.lifecycle.result.outcome).toBe("cancelled");
    }
  });

  it("surfaces a cancellation refusal without settling the job", async () => {
    codex.refuseCancel("CANCELLATION_NOT_SUPPORTED");
    const { job } = await plane.submit({ request: baseRequest, idempotencyKey: "k" });
    const result = await plane.cancel(job.id);
    expect(result).toMatchObject({ accepted: false, code: "CANCELLATION_NOT_SUPPORTED" });
    expect(plane.getJob(job.id).record.lifecycle.status).toBe("dispatched");
  });

  it("refuses to cancel an already-terminal job", async () => {
    const { job } = await plane.submit({ request: baseRequest, idempotencyKey: "k" });
    await plane.ingestReport(
      makeReport(job.id, job.correlationId, { outcome: "completed", artifacts: [] }),
    );
    await expectCode(plane.cancel(job.id), "JOB_ALREADY_TERMINAL");
  });

  it("refuses to cancel an unknown job", async () => {
    await expectCode(plane.cancel(randomUUID()), "JOB_NOT_FOUND");
  });
});

describe("JobControlPlane report-back", () => {
  let plane: JobControlPlane;
  let codex: FakeAdapter;

  beforeEach(() => {
    plane = newPlane();
    codex = fakeAdapter("codex");
    plane.registerAdapter(codex.adapter);
  });

  async function settledChild(): Promise<{ parentId: string; childId: string }> {
    const parent = await plane.submit({ request: baseRequest, idempotencyKey: "parent" });
    const child = await plane.delegate({
      delegationId: randomUUID(),
      correlationId: randomUUID(),
      parentJobId: parent.job.id,
      request: baseRequest,
    });
    await plane.ingestReport(
      makeReport(child.job.id, child.job.correlationId, {
        outcome: "completed",
        summary: "child done",
        artifacts: [],
      }),
    );
    return { parentId: parent.job.id, childId: child.job.id };
  }

  it("records a pending report-back on settlement and does not consider it delivered", async () => {
    const { childId } = await settledChild();
    const snapshot = plane.getJob(childId);
    expect(snapshot.reportBack?.state).toBe("pending");
    expect(snapshot.reportBack?.deliveredAt).toBeUndefined();
  });

  it("marks a report-back delivered only on explicit acknowledgement, idempotently", async () => {
    const { childId } = await settledChild();
    const acked = await plane.acknowledgeReport(childId);
    expect(acked.state).toBe("delivered");
    expect(acked.deliveredAt).toBe(NOW);
    const again = await plane.acknowledgeReport(childId);
    expect(again.state).toBe("delivered");
    expect(plane.getJob(childId).reportBack?.state).toBe("delivered");
  });

  it("records a failed report-back attempt as retryable then deliverable", async () => {
    const { childId } = await settledChild();
    const failed = await plane.failReport(childId, "parent offline");
    expect(failed.state).toBe("failed");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe("parent offline");
    const delivered = await plane.acknowledgeReport(childId);
    expect(delivered.state).toBe("delivered");
  });

  it("throws when acknowledging a job with no report-back", async () => {
    const top = await plane.submit({ request: baseRequest, idempotencyKey: "top" });
    await plane.ingestReport(
      makeReport(top.job.id, top.job.correlationId, { outcome: "completed", artifacts: [] }),
    );
    await expectCode(plane.acknowledgeReport(top.job.id), "JOB_NOT_FOUND");
  });

  it("rejects a delegation whose parent job is unknown", async () => {
    await expectCode(
      plane.delegate({
        delegationId: randomUUID(),
        correlationId: randomUUID(),
        parentJobId: randomUUID(),
        request: baseRequest,
      }),
      "JOB_NOT_FOUND",
    );
  });
});

describe("JobControlPlane events", () => {
  it("emits job/delegation/result/report events without leaking the instruction body", async () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const plane = new JobControlPlane({
      registry: defaultProviderRegistry(),
      now: () => NOW,
      journal: {
        async append(event) {
          events.push({ type: event.type, data: event.data });
        },
      },
    });
    const codex = fakeAdapter("codex");
    plane.registerAdapter(codex.adapter);

    const parent = await plane.submit({ request: baseRequest, idempotencyKey: "parent" });
    const child = await plane.delegate({
      delegationId: randomUUID(),
      correlationId: randomUUID(),
      parentJobId: parent.job.id,
      request: baseRequest,
    });
    await plane.ingestReport(
      makeReport(child.job.id, child.job.correlationId, { outcome: "completed", artifacts: [] }),
    );
    await plane.acknowledgeReport(child.job.id);

    const types = events.map((event) => event.type);
    expect(types).toContain("job.submitted");
    expect(types).toContain("job.dispatched");
    expect(types).toContain("delegation.created");
    expect(types).toContain("job.settled");
    expect(types).toContain("job.reported");
    expect(types).toContain("job.report.acknowledged");

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(baseRequest.instruction);
  });

  it("throws a plain error type when misused with a bad job id", () => {
    const plane = newPlane();
    expect(() => plane.getJob("not-a-uuid")).toThrow();
    try {
      plane.getJob(randomUUID());
    } catch (error) {
      expect(error).toBeInstanceOf(ControlPlaneError);
    }
  });
});
