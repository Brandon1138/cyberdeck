import { mkdtemp } from "node:fs/promises";
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

const adapters: Record<"codex" | "claude", ProviderAdapter> = {
  codex: {
    id: "codex",
    buildLaunchSpec: (session, initialPrompt) => ({ executable: "fake", args: initialPrompt === undefined ? [] : [initialPrompt], cwd: session.cwd, env: {} }),
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
  const registry = new SessionRegistry({
    adapters,
    ptyFactory,
    journal: { append: async () => {} },
    transcripts,
    config: BrokerRuntimeConfigSchema.parse({ maxConcurrentWorkers: 8 }),
  });
  let server: BrokerServer;
  server = new BrokerServer({
    socketPath,
    registry,
    transcripts,
    onShutdown: () => { void server.close(); },
  });
  await server.listen();
  return { server, socketPath, ptyFactory };
}

describe("BrokerServer", () => {
  it("routes lifecycle requests, streams output, and rejects delegated Fable", async () => {
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
      })).rejects.toMatchObject({ code: "FABLE_REQUIRES_EXPLICIT_HUMAN_START" });
      expect(ptyFactory).toHaveBeenCalledTimes(2);

      await client.request("session.stop", { sessionId: second.id });
      await expect(client.request("session.attach", { sessionId: second.id }))
        .rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
      await expect(client.request("session.resume", { sessionId: second.id }))
        .resolves.toMatchObject({ id: second.id, executionState: "active", exitCode: null });
      expect(ptyFactory).toHaveBeenCalledTimes(3);
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
});
