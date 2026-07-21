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
});
