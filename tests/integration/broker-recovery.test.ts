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
import { FleetDetachStore } from "../../src/persistence/fleet-detach-store.js";
import { collectFleetSnapshot, createFleetState, renderFleet } from "../../src/client/fleet.js";

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

  it("rehydrates a thread that was mid-turn as interrupted, keeping metadata and preview", async () => {
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
      attentionState: "working",
      latestPreview: "The saved answer survives restart.",
    };
    await new SessionStore(directory).put(record);
    await new FleetDetachStore(directory).record("operator:one", sessionId);

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
      await expect(client.request("fleet.reattach", { detachIdentity: "operator:one" })).resolves.toMatchObject({
        status: "ready",
        record: { id: sessionId, attentionState: "interrupted" },
        requiresResume: true,
      });
      await expect(client.request("fleet.reattach", { detachIdentity: "operator:other" }))
        .resolves.toEqual({ status: "none" });
    } finally {
      client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("brings finished threads back as Done, holding no worker slot, and retires aged history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-thread-durability-"));
    const socketPath = join(directory, "broker.sock");
    const store = new SessionStore(directory);
    const finished = durableRecord({ name: "Finished the task", attentionState: "done" });
    const midTurn = durableRecord({ name: "Cut off mid-turn", attentionState: "working" });
    const ancient = durableRecord({
      name: "Ancient history",
      executionState: "exited",
      exitCode: 0,
      attentionState: "done",
      updatedAt: "2025-01-01T10:00:00.000Z",
      meaningfulUpdatedAt: "2025-01-01T10:00:00.000Z",
    });
    for (const record of [finished, midTurn, ancient]) await store.put(record);

    const server = await runBroker(socketPath, directory);
    const client = await RpcClient.connect(socketPath);
    try {
      const sessions = await client.request<SessionRecord[]>("session.list", {});
      const byId = new Map(sessions.map((record) => [record.id, record]));

      // 1. The thread that had finished its task is Done again, not interrupted, not stopped.
      expect(byId.get(finished.id)).toMatchObject({
        executionState: "exited",
        attentionState: "done",
        exitCode: 0,
        latestPreview: "The saved answer survives restart.",
      });
      // A thread that was genuinely mid-turn still reports the work it lost.
      expect(byId.get(midTurn.id)).toMatchObject({
        executionState: "cancelled",
        attentionState: "interrupted",
      });
      // 4. Retention retired the aged thread without anyone stopping and deleting it by hand.
      expect(byId.has(ancient.id)).toBe(false);

      // 2. Neither rehydrated thread holds a worker slot.
      await expect(client.request<{ workers: { activeWorkers: number } }>("broker.status", {}))
        .resolves.toMatchObject({ workers: { activeWorkers: 0 } });

      // 3. The header counters agree with the rehydrated set: no live agents, one done, one
      //    interrupted, and nothing counted as working or needing input.
      const snapshot = await collectFleetSnapshot(client);
      const rendered = renderFleet(snapshot, createFleetState(snapshot), {
        color: false,
        width: 150,
        height: 40,
        now: Date.parse("2026-07-26T12:00:00.000Z"),
        home: "/Users/brandon",
      });
      expect(rendered).toContain("0 agents · 0 needs input · 0 working · 1 done · 1 interrupted");
      expect(rendered).toContain("Finished the task");
    } finally {
      client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a rehydrated finished thread Done across a second restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-thread-durability-"));
    const socketPath = join(directory, "broker.sock");
    const finished = durableRecord({ name: "Finished the task", attentionState: "done" });
    await new SessionStore(directory).put(finished);

    const first = await runBroker(socketPath, directory);
    await first.close();

    const second = await runBroker(socketPath, directory);
    const client = await RpcClient.connect(socketPath);
    try {
      await expect(client.request<SessionRecord[]>("session.list", {})).resolves.toEqual([
        expect.objectContaining({
          id: finished.id,
          executionState: "exited",
          attentionState: "done",
        }),
      ]);
    } finally {
      client.close();
      await second.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/** A thread the previous broker left behind: live-looking on disk, with no process to inherit. */
function durableRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: randomUUID(),
    provider: "claude",
    model: "opus",
    cwd: "/tmp/repo",
    detached: true,
    sandbox: "read-only",
    kind: "worker",
    name: "Durable thread",
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
    ...overrides,
  } as SessionRecord;
}
