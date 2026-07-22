import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBroker } from "../../src/broker/main.js";
import { RpcClient } from "../../src/client/rpc-client.js";
import { CorrelationIdSchema, JobIdSchema } from "../../src/domain/control-plane.js";
import type { JobSnapshot } from "../../src/control-plane/job-control-plane.js";
import { JobStore } from "../../src/persistence/job-store.js";
import { SessionStore } from "../../src/persistence/session-store.js";
import type { SessionRecord } from "../../src/domain/session.js";

const NOW = "2026-07-21T10:00:00.000Z";

describe("broker durable startup", () => {
  it("rebuilds jobs from an injected temporary state directory without launching a provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-broker-recovery-"));
    const socketPath = join(directory, "broker.sock");
    const jobId = JobIdSchema.parse(randomUUID());
    const store = new JobStore(directory, { now: () => NOW });
    await store.append({
      idempotencyKey: "restart-proof",
      record: {
        schemaVersion: 1,
        id: jobId,
        correlationId: CorrelationIdSchema.parse(randomUUID()),
        request: {
          schemaVersion: 1,
          provider: "codex",
          cwd: "/tmp/repo",
          sandbox: "read-only",
          instruction: "fixture only",
        },
        lifecycle: { status: "dispatched", dispatchedAt: NOW },
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    const server = await runBroker(socketPath, directory);
    const client = await RpcClient.connect(socketPath);
    try {
      const jobs = await client.request<JobSnapshot[]>("job.list", {});
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.record.id).toBe(jobId);
      expect(jobs[0]?.record.lifecycle.status).toBe("interrupted");
    } finally {
      client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rehydrates interactive thread metadata and preview without relaunching a provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-session-recovery-"));
    const socketPath = join(directory, "broker.sock");
    const sessionId = randomUUID();
    const record: SessionRecord = {
      id: sessionId,
      provider: "claude",
      model: "opus",
      effort: "high",
      cwd: "/tmp/repo",
      detached: true,
      sandbox: "read-only",
      kind: "worker",
      name: "Persistent conversation",
      createdAt: NOW,
      updatedAt: NOW,
      meaningfulUpdatedAt: NOW,
      executionState: "active",
      attachmentState: "detached",
      pid: 4321,
      exitCode: null,
      childIds: [],
      attentionState: "done",
      latestPreview: "The saved answer survives restart.",
    };
    await new SessionStore(directory).put(record);

    const server = await runBroker(socketPath, directory);
    const client = await RpcClient.connect(socketPath);
    try {
      await expect(client.request<SessionRecord[]>("session.list", {})).resolves.toEqual([
        expect.objectContaining({
          id: sessionId,
          executionState: "cancelled",
          attentionState: "interrupted",
          latestPreview: "The saved answer survives restart.",
        }),
      ]);
      await expect(client.request<{ data: string }>("session.snapshot", { sessionId })).resolves.toEqual({ data: "" });
    } finally {
      client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
