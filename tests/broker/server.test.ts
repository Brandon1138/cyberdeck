import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { BrokerServer } from "../../src/broker/server.js";
import { SessionRegistry, type PtyHandle } from "../../src/broker/session-registry.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../../src/providers/provider.js";
import { ServerFrameSchema, type ServerFrame, type WireFrame } from "../../src/protocol/frames.js";
import { JsonlDecoder, encodeFrame } from "../../src/protocol/jsonl.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import { WorkerPreferenceStore } from "../../src/persistence/worker-preference-store.js";
import { FleetDetachStore } from "../../src/persistence/fleet-detach-store.js";
import { AgentControlService } from "../../src/orchestration/agent-control-service.js";

class FakePty implements PtyHandle {
  readonly pid: number;
  private readonly output = new Set<(chunk: Buffer) => void>();
  private readonly exits = new Set<(exitCode: number, signal?: number) => void>();

  constructor(pid: number) { this.pid = pid; }
  write(data: Buffer): void {
    for (const listener of this.output) listener(Buffer.from(`ECHO:${data.toString("utf8")}`));
  }
  resize(): void {}
  snapshot(): Buffer { return Buffer.from("READY\r\n"); }
  kill(): void { for (const listener of this.exits) listener(0); }
  onOutput(listener: (chunk: Buffer) => void): () => void {
    this.output.add(listener);
    return () => this.output.delete(listener);
  }
  onExit(listener: (exitCode: number, signal?: number) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }
}

/** Stands in for the API keys and tokens a real adapter inherits from `process.env`. */
const SENTINEL_SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-SENTINEL-BROKER",
  GITHUB_TOKEN: "ghp_SENTINELBROKER",
};

const adapters: Record<"codex" | "claude", ProviderAdapter> = {
  codex: {
    id: "codex",
    buildLaunchSpec: (session, initialPrompt) => ({ executable: "fake", args: initialPrompt === undefined ? [] : [initialPrompt], cwd: session.cwd, env: { ...SENTINEL_SECRETS } }),
    buildResumeSpec: (session) => ({ executable: "fake", args: ["resume", session.id], cwd: session.cwd, env: {} }),
  },
  claude: {
    id: "claude",
    buildLaunchSpec: (session, initialPrompt) => ({ executable: "fake", args: initialPrompt === undefined ? [] : [initialPrompt], cwd: session.cwd, env: { DISABLE_UPDATES: "1" } }),
    buildResumeSpec: (session) => ({ executable: "fake", args: ["resume", session.id], cwd: session.cwd, env: { DISABLE_UPDATES: "1" } }),
  },
};

class TestClient {
  private readonly decoder = new JsonlDecoder(ServerFrameSchema);
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly frames: ServerFrame[] = [];
  private readonly waiters: Array<{ predicate: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void }> = [];
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
        } else {
          this.frames.push(frame);
          const waiter = this.waiters.find(({ predicate }) => predicate(frame));
          if (waiter !== undefined) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
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

  send(frame: WireFrame): void { this.socket.write(encodeFrame(frame)); }

  waitFor(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame> {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }

  close(): Promise<void> {
    this.socket.end();
    return new Promise((resolve) => this.socket.once("close", () => resolve()));
  }
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-server-"));
  const socketPath = join(directory, "broker.sock");
  const ptyFactory = vi.fn((_spec: ProviderLaunchSpec) => new FakePty(2000 + ptyFactory.mock.calls.length));
  const transcripts = new ThreadTranscriptStore(directory);
  const catalogWrites: string[] = [];
  const registry = new SessionRegistry({
    adapters,
    ptyFactory,
    journal: { append: async () => {} },
    transcripts,
    store: {
      put: async (record) => { catalogWrites.push(`put:${record.id}`); },
      delete: async (sessionId) => { catalogWrites.push(`delete:${sessionId}`); },
    },
    validateCwd: async () => undefined,
    config: BrokerRuntimeConfigSchema.parse({ maxConcurrentWorkers: 8 }),
  });
  const orchestratorStore = new OrchestratorStore(directory);
  const workerPreferences = new WorkerPreferenceStore(directory);
  const fleetDetaches = new FleetDetachStore(directory);
  const orchestrators = new OrchestratorManager(registry, orchestratorStore, workerPreferences);
  const agentControl = new AgentControlService(registry, orchestratorStore, transcripts, workerPreferences);
  let server: BrokerServer;
  server = new BrokerServer({
    socketPath,
    registry,
    transcripts,
    orchestrators,
    agentControl,
    fleetDetaches,
    workerPreferences,
    onShutdown: () => { void server.close(); },
  });
  await server.listen();
  return {
    server,
    socketPath,
    ptyFactory,
    orchestratorStore,
    fleetDetaches,
    orchestrators,
    workerPreferences,
    catalogWrites,
  };
}

describe("BrokerServer", () => {
  it("restricts the broker socket to the current user", async () => {
    const { server, socketPath } = await harness();
    try {
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    } finally {
      await server.close();
    }
  });

  it("persists Caveman mode without an Orc and injects it into new worker tasks", async () => {
    const { server, socketPath, ptyFactory, workerPreferences } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      await expect(client.request("orchestrator.cavemanWorkers", { enabled: true })).resolves.toEqual({
        scope: "box",
        enabled: true,
      });
      const worker = await client.request<{ id: string; workerMode: string }>("session.startWithPrompt", {
        provider: "codex",
        cwd: "/tmp/repo",
        detached: true,
        sandbox: "read-only",
        initialPrompt: "Describe the result",
      });

      expect(worker.workerMode).toBe("caveman");
      expect(ptyFactory.mock.calls[0]?.[0].args[0]).toContain("CAVEMAN MODE ACTIVE");
      expect(ptyFactory.mock.calls[0]?.[0].args[0]).toContain("WORKER TASK\nDescribe the result");
      await expect(workerPreferences.get()).resolves.toEqual({ caveman: true });
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("routes lifecycle requests and treats direct broker starts as operator-owned", async () => {
    const { server, socketPath, ptyFactory } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      const parent = await client.request<{ id: string }>("session.startWithPrompt", {
        provider: "codex", cwd: "/tmp/repo", detached: true, sandbox: "read-only",
        initialPrompt: "Inspect the failure",
      });
      const second = await client.request<{ id: string }>("session.start", {
        provider: "claude", cwd: "/tmp/repo", detached: true, sandbox: "read-only",
      });
      const listed = await client.request<Array<{ id: string }>>("session.list", {});
      expect(listed.map(({ id }) => id)).toEqual([parent.id, second.id]);
      expect(ptyFactory.mock.calls[0]?.[0]).toMatchObject({ args: ["Inspect the failure"] });
      const thread = await client.request<{ events: Array<{ text?: string }>; nextCursor: number }>(
        "thread.read",
        { sessionId: parent.id },
      );
      expect(thread.events).toContainEqual(expect.objectContaining({ text: "Inspect the failure" }));
      expect(thread.nextCursor).toBeGreaterThan(0);

      const snapshot = await client.request<{ data: string }>("session.snapshot", { sessionId: parent.id });
      expect(Buffer.from(snapshot.data, "base64").toString()).toContain("READY");

      await client.request("session.attach", { sessionId: parent.id });
      const output = client.waitFor((frame) => frame.type === "output" && frame.sessionId === parent.id);
      await client.request("session.send", { sessionId: parent.id, data: Buffer.from("hello\n").toString("base64") });
      await expect(output).resolves.toMatchObject({ type: "output", sessionId: parent.id });

      await expect(client.request("session.start", {
        provider: "claude", cwd: "/tmp/repo", detached: true, sandbox: "read-only",
        model: "fable", parentSessionId: parent.id,
      })).resolves.toMatchObject({ model: "fable", parentSessionId: parent.id });
      expect(ptyFactory).toHaveBeenCalledTimes(3);

      await client.request("session.stop", { sessionId: second.id });
      await expect(client.request("session.attach", { sessionId: second.id }))
        .rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
      await expect(client.request("session.resume", { sessionId: second.id }))
        .resolves.toMatchObject({ id: second.id, executionState: "active", exitCode: null });
      expect(ptyFactory).toHaveBeenCalledTimes(4);
      await client.request("session.stop", { sessionId: second.id });
      await expect(client.request("session.delete", { sessionId: second.id })).resolves.toEqual({ deleted: true });
      await expect(client.request("session.snapshot", { sessionId: second.id }))
        .rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
      await expect(client.request("broker.shutdown", {})).resolves.toEqual({ shuttingDown: true });
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("keeps watchers read-only and releases controller leases on disconnect", async () => {
    const { server, socketPath } = await harness();
    const owner = await TestClient.open(socketPath);
    const watcher = await TestClient.open(socketPath);
    const successor = await TestClient.open(socketPath);
    try {
      const session = await owner.request<{ id: string }>("session.start", {
        provider: "codex", cwd: "/tmp/repo", detached: true, sandbox: "read-only",
      });
      await owner.request("session.attach", { sessionId: session.id });
      await watcher.request("session.watch", { sessionId: session.id });
      watcher.send({
        type: "input",
        sessionId: session.id,
        data: Buffer.from("must-not-send\n").toString("base64"),
      });
      const protocolError = await watcher.waitFor((frame) => frame.type === "protocol-error");
      expect(protocolError).toMatchObject({ type: "protocol-error" });

      await owner.close();
      await expect(successor.request("session.attach", { sessionId: session.id })).resolves.toBeTruthy();
    } finally {
      watcher.socket.destroy();
      successor.socket.destroy();
      await server.close();
    }
  });

  it("reattaches only the latest explicit target, isolates identities, and clears stale targets", async () => {
    const { server, socketPath, fleetDetaches } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      const first = await client.request<{ id: string }>("session.start", {
        provider: "codex", cwd: "/tmp/repo", detached: true, sandbox: "read-only",
      });
      const second = await client.request<{ id: string }>("session.start", {
        provider: "claude", cwd: "/tmp/repo", detached: true, sandbox: "read-only",
      });

      await client.request("session.attach", { sessionId: first.id, detachIdentity: "operator:one" });
      await client.request("session.detach", { sessionId: first.id });
      await expect(client.request("fleet.reattach", { detachIdentity: "operator:one" }))
        .resolves.toMatchObject({ status: "ready", record: { id: first.id }, requiresResume: false });

      await client.request("session.attach", { sessionId: second.id, detachIdentity: "operator:one" });
      await client.request("session.detach", { sessionId: second.id });
      await client.request("session.attach", { sessionId: first.id, detachIdentity: "orchestrator:other" });
      await client.request("session.detach", { sessionId: first.id });
      await client.request("session.submit", { sessionId: first.id, message: "background update" });
      await expect(client.request("fleet.reattach", { detachIdentity: "operator:one" }))
        .resolves.toMatchObject({ status: "ready", record: { id: second.id }, requiresResume: false });
      await expect(client.request("fleet.reattach", { detachIdentity: "orchestrator:other" }))
        .resolves.toMatchObject({ status: "ready", record: { id: first.id }, requiresResume: false });
      await expect(client.request("fleet.reattach", { detachIdentity: "operator:missing" }))
        .resolves.toEqual({ status: "none" });

      const leaseHolder = await TestClient.open(socketPath);
      try {
        await leaseHolder.request("session.attach", { sessionId: second.id });
        await expect(client.request("fleet.reattach", { detachIdentity: "operator:one" }))
          .resolves.toMatchObject({ status: "unavailable", record: { id: second.id } });
        await leaseHolder.request("session.detach", { sessionId: second.id });
        await expect(client.request("fleet.reattach", { detachIdentity: "operator:one" }))
          .resolves.toMatchObject({ status: "ready", record: { id: second.id } });
      } finally {
        leaseHolder.socket.destroy();
      }

      await client.request("session.stop", { sessionId: second.id });
      await expect(client.request("fleet.reattach", { detachIdentity: "operator:one" }))
        .resolves.toEqual({ status: "stale" });
      await expect(client.request("fleet.reattach", { detachIdentity: "operator:one" }))
        .resolves.toEqual({ status: "none" });

      await client.request("session.attach", { sessionId: first.id, detachIdentity: "operator:one" });
      await client.request("session.detach", { sessionId: first.id });
      await client.request("session.stop", { sessionId: first.id });
      await expect(client.request("fleet.reattach", { detachIdentity: "operator:one" }))
        .resolves.toEqual({ status: "stale" });
      await client.request("session.delete", { sessionId: first.id });
      await fleetDetaches.record("operator:one", first.id);
      await expect(client.request("fleet.reattach", { detachIdentity: "operator:one" }))
        .resolves.toEqual({ status: "stale" });
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("creates a unique peer orchestrator without replacing or stopping the current one", async () => {
    const { server, socketPath, orchestratorStore } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      const request = {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        cwd: "/tmp/repo",
        scope: "fleet",
      };
      const primary = await client.request<{ session: { id: string } }>("orchestrator.ensure", request);
      const peer = await client.request<{
        session: { id: string; executionState: string };
        binding: { key: string; grant: { capabilities: string[] } };
      }>("orchestrator.create", request);

      expect(peer.session.id).not.toBe(primary.session.id);
      expect(peer.binding.key).toBe(`fleet:peer:${peer.session.id}`);
      expect(peer.binding.grant.capabilities).toContain("worker.start");
      const worker = await client.request<{ sessionId: string }>("agent.worker.start", {
        actorSessionId: peer.session.id,
        provider: "codex",
        model: "gpt-5.6-terra",
        effort: "low",
        cwd: "/tmp/repo",
        sandbox: "read-only",
        prompt: "Inspect the peer scope",
      });
      expect(worker.sessionId).not.toBe(peer.session.id);
      expect(worker.sessionId).not.toBe(primary.session.id);
      await expect(client.request<Array<{ id: string; kind?: string; executionState: string }>>(
        "session.list",
        {},
      )).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: primary.session.id, kind: "orchestrator", executionState: "active" }),
        expect.objectContaining({ id: peer.session.id, kind: "orchestrator", executionState: "active" }),
      ]));
      await expect(orchestratorStore.get("fleet")).resolves.toMatchObject({
        sessionId: primary.session.id,
      });
      await expect(orchestratorStore.findBySessionId(peer.session.id)).resolves.toMatchObject({
        sessionId: peer.session.id,
        key: `fleet:peer:${peer.session.id}`,
      });
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("describes an actor over the wire so an MCP server can name its own scope", async () => {
    const { server, socketPath } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      const primary = await client.request<{ session: { id: string } }>("orchestrator.ensure", {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        cwd: "/tmp/repo",
        scope: "fleet",
      });

      await expect(client.request("agent.actor.describe", {
        actorSessionId: primary.session.id,
      })).resolves.toMatchObject({
        status: "bound",
        bound: true,
        familyKey: "fleet",
        familyHolderSessionId: primary.session.id,
        executionState: "active",
      });
      // Answerable for an actor the broker has never heard of: an MCP server has to be able to
      // tell "wrong broker" from "no tools registered" without guessing.
      await expect(client.request("agent.actor.describe", {
        actorSessionId: "66666666-6666-4666-8666-666666666666",
      })).resolves.toMatchObject({ status: "unknown-session", bound: false });
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("deletes only an orchestrator while preserving its workers and clearing its durable binding", async () => {
    const { server, socketPath, orchestratorStore, orchestrators, workerPreferences } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      const ensured = await client.request<{ session: { id: string } }>("orchestrator.ensure", {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        cwd: "/tmp/repo",
        scope: "fleet",
      });
      await expect(client.request("orchestrator.fableWorkers", {
        cwd: "/tmp/repo",
        scope: "fleet",
        enabled: true,
      })).resolves.toMatchObject({
        key: "fleet",
        configured: true,
        enabled: true,
        sessionId: ensured.session.id,
      });
      await expect(client.request("orchestrator.cavemanWorkers", {
        enabled: true,
      })).resolves.toMatchObject({
        scope: "box",
        enabled: true,
      });
      await expect(orchestratorStore.get("fleet")).resolves.toMatchObject({
        grant: { capabilities: expect.arrayContaining(["worker.start.fable"]) },
      });
      await expect(workerPreferences.get()).resolves.toEqual({ caveman: true });
      const child = await client.request<{ id: string }>("session.start", {
        provider: "codex",
        cwd: "/tmp/repo",
        detached: true,
        sandbox: "read-only",
        kind: "worker",
        parentSessionId: ensured.session.id,
      });

      await expect(client.request("session.stopOne", { sessionId: ensured.session.id }))
        .resolves.toEqual({ stopped: true });
      await expect(client.request<Array<Record<string, unknown>>>("session.list", {}))
        .resolves.toContainEqual(expect.objectContaining({
          id: child.id,
          executionState: "active",
        }));

      vi.spyOn(orchestrators, "resetSessionBinding")
        .mockRejectedValueOnce(new Error("binding store unavailable"));
      await expect(client.request("session.delete", { sessionId: ensured.session.id }))
        .rejects.toThrow("binding store unavailable");
      await expect(client.request<Array<Record<string, unknown>>>("session.list", {}))
        .resolves.toContainEqual(expect.objectContaining({
          id: ensured.session.id,
          kind: "orchestrator",
        }));
      await expect(orchestratorStore.findBySessionId(ensured.session.id))
        .resolves.toMatchObject({ sessionId: ensured.session.id });

      await expect(client.request("session.delete", { sessionId: ensured.session.id })).resolves.toEqual({ deleted: true });
      const remaining = await client.request<Array<Record<string, unknown>>>("session.list", {});
      expect(remaining).toEqual([expect.objectContaining({ id: child.id, cwd: "/tmp/repo", kind: "worker" })]);
      expect(remaining[0]).not.toHaveProperty("parentSessionId");
      await expect(orchestratorStore.findBySessionId(ensured.session.id)).resolves.toBeUndefined();
      await expect(client.request("session.snapshot", { sessionId: child.id })).resolves.toMatchObject({ data: expect.any(String) });
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });
});

describe("BrokerServer launch record inspection", () => {
  it("answers with the spec the PTY was spawned with and never writes", async () => {
    const { server, socketPath, ptyFactory, catalogWrites } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      const session = await client.request<{ id: string }>("session.start", {
        provider: "codex", cwd: "/tmp/repo", detached: true, sandbox: "read-only",
      });
      const spawned = ptyFactory.mock.calls[0]![0];
      const writesBefore = catalogWrites.length;

      const first = await client.request<Record<string, unknown>>(
        "session.launchRecord",
        { sessionId: session.id },
      );
      const second = await client.request<Record<string, unknown>>(
        "session.launchRecord",
        { sessionId: session.id },
      );

      expect(first).toMatchObject({
        sessionId: session.id,
        provider: "codex",
        launchRecord: {
          mode: "launch",
          executable: spawned.executable,
          args: spawned.args,
          cwd: spawned.cwd,
          truncated: false,
        },
      });
      expect(second).toEqual(first);
      expect(catalogWrites).toHaveLength(writesBefore);
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("omits inherited environment values from the operator-facing result", async () => {
    const { server, socketPath } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      const session = await client.request<{ id: string }>("session.start", {
        provider: "codex", cwd: "/tmp/repo", detached: true, sandbox: "read-only",
      });

      const result = await client.request<Record<string, unknown>>(
        "session.launchRecord",
        { sessionId: session.id },
      );
      const serialized = JSON.stringify(result);

      for (const [key, value] of Object.entries(SENTINEL_SECRETS)) {
        expect(serialized).not.toContain(value);
        expect(serialized).not.toContain(key);
      }
      expect(result.launchRecord).toMatchObject({ cyberdeckEnv: {}, inheritedEnvCount: 2 });
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("reports the resume it actually performed after a stopped session comes back", async () => {
    const { server, socketPath, ptyFactory } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      const session = await client.request<{ id: string }>("session.start", {
        provider: "codex", cwd: "/tmp/repo", detached: true, sandbox: "read-only",
      });
      await client.request("session.stop", { sessionId: session.id });
      await client.request("session.resume", { sessionId: session.id });
      const resumeSpec = ptyFactory.mock.calls[1]![0];

      await expect(client.request("session.launchRecord", { sessionId: session.id }))
        .resolves.toMatchObject({
          launchRecord: { mode: "resume", args: resumeSpec.args, cwd: resumeSpec.cwd },
        });
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("rejects an unknown session instead of reconstructing a spec for it", async () => {
    const { server, socketPath } = await harness();
    const client = await TestClient.open(socketPath);
    try {
      await expect(client.request("session.launchRecord", {
        sessionId: "33333333-3333-4333-8333-333333333333",
      })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });
});
