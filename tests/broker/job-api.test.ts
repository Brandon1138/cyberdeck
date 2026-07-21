import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { BrokerServer } from "../../src/broker/server.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { SessionRegistry } from "../../src/broker/session-registry.js";
import { JobControlPlane } from "../../src/control-plane/job-control-plane.js";
import { defaultProviderRegistry } from "../../src/control-plane/provider-registry.js";
import { ControlPlaneRuntime } from "../../src/control-plane/runtime.js";
import type { JobDispatchAdapter } from "../../src/domain/dispatch.js";
import type { JobRecord } from "../../src/domain/job.js";
import { ServerFrameSchema, type ServerFrame } from "../../src/protocol/frames.js";
import { JsonlDecoder, encodeFrame } from "../../src/protocol/jsonl.js";

const NOW = "2026-07-21T00:00:00.000Z";

const baseRequest = {
  provider: "codex",
  cwd: "/tmp/repo",
  sandbox: "read-only" as const,
  instruction: "run the bounded job",
};

function acceptingAdapter(provider: string): JobDispatchAdapter {
  return {
    provider,
    async dispatch(request) {
      return { schemaVersion: 1, jobId: request.jobId, acceptedAt: NOW };
    },
    async cancel(request) {
      return { accepted: true, jobId: request.jobId };
    },
    onReport() {
      return () => {};
    },
  };
}

class TestClient {
  private readonly decoder = new JsonlDecoder(ServerFrameSchema);
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;

  private constructor(readonly socket: Socket) {
    socket.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const frame of this.decoder.push(bytes)) {
        if (frame.type === "response") {
          const pending = this.pending.get(frame.id);
          if (pending !== undefined) {
            this.pending.delete(frame.id);
            if (frame.ok) pending.resolve(frame.result);
            else pending.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
          }
        }
      }
    });
  }

  static async open(socketPath: string): Promise<TestClient> {
    const socket = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    this.socket.write(encodeFrame({ type: "request", id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
  }
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-job-api-"));
  const socketPath = join(directory, "broker.sock");
  const controlPlane = new JobControlPlane({ registry: defaultProviderRegistry(), now: () => NOW });
  controlPlane.registerAdapter(acceptingAdapter("codex"));
  const registry = { releaseClient: async () => {} } as unknown as SessionRegistry;
  const server = new BrokerServer({ socketPath, registry, controlPlane });
  await server.listen();
  return { server, socketPath };
}

/** The full composed runtime (admission, budgets, leases, reconciliation) behind the socket. */
async function composedHarness() {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-job-api-"));
  const socketPath = join(directory, "broker.sock");
  const runtime = new ControlPlaneRuntime({
    stateDirectory: directory,
    config: BrokerRuntimeConfigSchema.parse({}),
    adapters: [acceptingAdapter("codex")],
    now: () => NOW,
  });
  await runtime.start();
  const registry = { releaseClient: async () => {} } as unknown as SessionRegistry;
  const server = new BrokerServer({
    socketPath,
    registry,
    controlPlane: runtime.controlPlane,
    controlPlaneRuntime: runtime,
  });
  await server.listen();
  return { server, socketPath, runtime };
}

interface Snapshot {
  record: JobRecord;
  reportBack?: { state: string };
}

describe("broker job control-plane API", () => {
  it("submits, ingests completion, and acknowledges a delegated report-back over the socket", async () => {
    const { server, socketPath } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      const parent = await client.request<{ job: JobRecord; deduplicated: boolean }>("job.submit", {
        request: baseRequest,
        idempotencyKey: "parent",
      });
      expect(parent.job.lifecycle.status).toBe("dispatched");

      const child = await client.request<{ job: JobRecord }>("job.delegate", {
        delegationId: randomUUID(),
        correlationId: randomUUID(),
        parentJobId: parent.job.id,
        request: baseRequest,
      });

      const ingest = await client.request<{ status: string }>("job.report", {
        report: {
          jobId: child.job.id,
          correlationId: child.job.correlationId,
          reportedAt: NOW,
          result: { outcome: "completed", summary: "ok", artifacts: [] },
        },
      });
      expect(ingest.status).toBe("settled");

      const settled = await client.request<Snapshot>("job.get", { jobId: child.job.id });
      expect(settled.record.lifecycle.status).toBe("settled");
      expect(settled.reportBack?.state).toBe("pending");

      const acked = await client.request<{ state: string }>("job.acknowledgeReport", {
        jobId: child.job.id,
      });
      expect(acked.state).toBe("delivered");

      const listed = await client.request<Snapshot[]>("job.list", {});
      expect(listed).toHaveLength(2);
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("surfaces typed control-plane error codes over the wire", async () => {
    const { server, socketPath } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      await expect(
        client.request("job.submit", {
          request: { ...baseRequest, provider: "cursor" },
          idempotencyKey: "k-cursor",
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_NOT_REGISTERED" });

      await expect(client.request("job.cancel", { jobId: randomUUID() })).rejects.toMatchObject({
        code: "JOB_NOT_FOUND",
      });
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("answers queue, budget, report-back, and reconciliation queries over the socket", async () => {
    const { server, socketPath, runtime } = await composedHarness();
    const client = await TestClient.open(socketPath);
    try {
      const submitted = await client.request<{ job: JobRecord }>("job.submit", {
        request: baseRequest,
        idempotencyKey: "k-observability",
      });

      const queue = await client.request<{
        admissionOpen: boolean;
        reservations: Array<{ jobId: string }>;
        queued: unknown[];
      }>("control.queue", {});
      expect(queue.admissionOpen).toBe(true);
      expect(queue.reservations.map((entry) => entry.jobId)).toEqual([submitted.job.id]);

      const budget = await client.request<{ scopes: Array<{ scopeId: string }> }>(
        "control.budget",
        {},
      );
      expect(budget.scopes.map((scope) => scope.scopeId)).toEqual([submitted.job.id]);

      const reconciliation = await client.request<{ findings: unknown[] }>(
        "control.reconciliation",
        {},
      );
      expect(reconciliation.findings).toEqual([]);

      expect(await client.request("job.reportBacks", {})).toEqual([]);
      await runtime.shutdown("test");
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });
});
