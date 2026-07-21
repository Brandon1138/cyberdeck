import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobControlPlane } from "../../src/control-plane/job-control-plane.js";
import { defaultProviderRegistry } from "../../src/control-plane/provider-registry.js";
import type { DispatchRequest, JobDispatchAdapter } from "../../src/domain/dispatch.js";
import { CorrelationIdSchema, JobIdSchema } from "../../src/domain/control-plane.js";
import type { JobReport } from "../../src/domain/job.js";
import { JobStore } from "../../src/persistence/job-store.js";

const directories: string[] = [];
const NOW = "2026-07-21T10:00:00.000Z";

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stateDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "cyberdeck-recovery-"));
  directories.push(path);
  return path;
}

function fakeAdapter() {
  const listeners = new Set<(report: JobReport) => void>();
  const dispatches: DispatchRequest[] = [];
  const adapter: JobDispatchAdapter = {
    provider: "codex",
    async dispatch(request) {
      dispatches.push(request);
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
    dispatches,
    complete(request: DispatchRequest) {
      const report: JobReport = {
        schemaVersion: 1,
        jobId: request.jobId,
        correlationId: request.correlationId,
        reportedAt: NOW,
        result: { outcome: "completed", summary: "fixture complete", artifacts: [] },
      };
      for (const listener of [...listeners]) listener(report);
    },
  };
}

const request = {
  provider: "codex",
  cwd: "/tmp/repo",
  sandbox: "read-only" as const,
  instruction: "bounded fixture work",
};

describe("durable job recovery", () => {
  it("maps unverifiable in-flight work to interrupted without redispatch", async () => {
    const directory = await stateDirectory();
    const store = new JobStore(directory, { now: () => NOW });
    const firstRuntime = fakeAdapter();
    const first = new JobControlPlane({ registry: defaultProviderRegistry(), store, now: () => NOW });
    first.registerAdapter(firstRuntime.adapter);
    const submitted = await first.submit({ request, idempotencyKey: "once" });
    expect(firstRuntime.dispatches).toHaveLength(1);

    const secondRuntime = fakeAdapter();
    const restarted = new JobControlPlane({ registry: defaultProviderRegistry(), store, now: () => NOW });
    restarted.registerAdapter(secondRuntime.adapter);
    await restarted.recover();

    const recovered = restarted.getJob(submitted.job.id);
    expect(recovered.record.lifecycle.status).toBe("interrupted");
    if (recovered.record.lifecycle.status === "interrupted") {
      expect(recovered.record.lifecycle.reason).toMatch(/ownership.*unverifiable/i);
    }
    expect(secondRuntime.dispatches).toHaveLength(0);
  });

  it("preserves a terminal result and pending report-back exactly", async () => {
    const directory = await stateDirectory();
    const store = new JobStore(directory, { now: () => NOW });
    const runtime = fakeAdapter();
    const first = new JobControlPlane({ registry: defaultProviderRegistry(), store, now: () => NOW });
    first.registerAdapter(runtime.adapter);
    const parent = await first.submit({ request, idempotencyKey: "parent" });
    const child = await first.delegate({
      delegationId: randomUUID(),
      correlationId: randomUUID(),
      parentJobId: parent.job.id,
      request,
    });
    runtime.complete(runtime.dispatches[1]!);
    await first.whenIdle();
    const before = first.getJob(child.job.id);
    expect(before.reportBack?.state).toBe("pending");

    const restarted = new JobControlPlane({ registry: defaultProviderRegistry(), store, now: () => NOW });
    await restarted.recover();
    expect(restarted.getJob(child.job.id)).toEqual(before);
  });

  it("makes repeated recovery idempotent and preserves submission deduplication", async () => {
    const directory = await stateDirectory();
    const store = new JobStore(directory, { now: () => NOW });
    const runtime = fakeAdapter();
    const first = new JobControlPlane({ registry: defaultProviderRegistry(), store, now: () => NOW });
    first.registerAdapter(runtime.adapter);
    const submitted = await first.submit({ request, idempotencyKey: "same-key" });

    const second = new JobControlPlane({ registry: defaultProviderRegistry(), store, now: () => NOW });
    await second.recover();
    const lineCountAfterFirstRecovery = (await readFile(store.path, "utf8")).trim().split("\n").length;

    const thirdRuntime = fakeAdapter();
    const third = new JobControlPlane({ registry: defaultProviderRegistry(), store, now: () => NOW });
    third.registerAdapter(thirdRuntime.adapter);
    await third.recover();
    const lineCountAfterSecondRecovery = (await readFile(store.path, "utf8")).trim().split("\n").length;
    const duplicate = await third.submit({ request, idempotencyKey: "same-key" });

    expect(lineCountAfterSecondRecovery).toBe(lineCountAfterFirstRecovery);
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.job.id).toBe(submitted.job.id);
    expect(thirdRuntime.dispatches).toHaveLength(0);
  });

  it("preserves an omitted Claude model as data without treating it as safe to relaunch", async () => {
    const directory = await stateDirectory();
    const store = new JobStore(directory, { now: () => NOW });
    const jobId = JobIdSchema.parse(randomUUID());
    await store.append({
      idempotencyKey: "legacy-claude",
      record: {
        schemaVersion: 1,
        id: jobId,
        correlationId: CorrelationIdSchema.parse(randomUUID()),
        request: { ...request, schemaVersion: 1, provider: "claude" },
        lifecycle: { status: "running", startedAt: NOW },
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    const restarted = new JobControlPlane({ registry: defaultProviderRegistry(), store, now: () => NOW });
    await restarted.recover();
    const recovered = restarted.getJob(jobId);
    expect(recovered.record.request.model).toBeUndefined();
    expect(recovered.record.lifecycle.status).toBe("interrupted");
  });
});
