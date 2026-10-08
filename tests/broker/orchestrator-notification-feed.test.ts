import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { BrokerServer } from "../../src/broker/server.js";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { ObservedWorkerCoordinationService } from "../../src/broker/observed-worker-coordination.js";
import { composeOrchestratorNotificationFeed } from "../../src/broker/orchestrator-notification-feed.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import type { BrokerEvent } from "../../src/domain/events.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import type { OrchestratorNotification } from "../../src/domain/orchestrator-notification.js";
import type { InstructionRecord } from "../../src/domain/instruction.js";
import type { ProviderAdapter } from "../../src/providers/provider.js";
import { ServerFrameSchema } from "../../src/protocol/frames.js";
import { JsonlDecoder, encodeFrame } from "../../src/protocol/jsonl.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import { WorkerPreferenceStore } from "../../src/persistence/worker-preference-store.js";
import { AgentControlService } from "../../src/orchestration/agent-control-service.js";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { WorkerCoordinationRuntime } from "../../src/persistence/worker-coordination-runtime.js";
import { OrchestratorNotificationStore } from "../../src/persistence/orchestrator-notification-store.js";
import { OrchestratorNoticeFiles } from "../../src/persistence/orchestrator-notice-files.js";
import { observeInstructionRepository } from "../../src/orchestration/observed-instruction-repository.js";
import { orchestratorNoticeDirectory } from "../../src/cli/notice-hook.js";

/**
 * The test-broker layer of the acceptance table: a real broker server on its own socket over its
 * own state directory, composed exactly as `main.ts` composes the feed, with provider processes
 * replaced by fake PTYs so a worker can be settled on demand. Nothing here touches the live broker.
 */
class FakePty implements SessionRuntime {
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
  exit(code: number): void { for (const listener of this.exits) listener(code); }
  onOutput(listener: (chunk: Buffer) => void): () => void {
    this.output.add(listener);
    return () => this.output.delete(listener);
  }
  onExit(listener: (exitCode: number, signal?: number) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }
}

const adapters: Record<"codex" | "claude" | "cursor", ProviderAdapter> = {
  cursor: {
    id: "cursor",
    buildLaunchSpec: (session) => ({ executable: "fake", args: [], cwd: session.cwd, env: {} }),
    buildResumeSpec: (session) => ({ executable: "fake", args: ["resume", session.id], cwd: session.cwd, env: {} }),
  },
  codex: {
    id: "codex",
    buildLaunchSpec: (session, initialPrompt) => ({ executable: "fake", args: initialPrompt === undefined ? [] : [initialPrompt], cwd: session.cwd, env: {} }),
    buildResumeSpec: (session) => ({ executable: "fake", args: ["resume", session.id], cwd: session.cwd, env: {} }),
  },
  claude: {
    id: "claude",
    buildLaunchSpec: (session, initialPrompt) => ({ executable: "fake", args: initialPrompt === undefined ? [] : [initialPrompt], cwd: session.cwd, env: {} }),
    buildResumeSpec: (session) => ({ executable: "fake", args: ["resume", session.id], cwd: session.cwd, env: {} }),
  },
};

class TestClient {
  private readonly decoder = new JsonlDecoder(ServerFrameSchema);
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private constructor(readonly socket: Socket) {
    socket.on("data", (chunk) => {
      for (const frame of this.decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        if (frame.type !== "response") continue;
        const pending = this.pending.get(frame.id);
        if (pending === undefined) continue;
        this.pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
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
    return new Promise<T>((resolve, reject) => { this.pending.set(id, { resolve: (value) => resolve(value as T), reject }); });
  }
  close(): Promise<void> {
    this.socket.end();
    return new Promise((resolve) => this.socket.once("close", () => resolve()));
  }
}

interface ReadResult {
  notifications: Array<OrchestratorNotification & { result?: { status: string; retrieval: string } }>;
  nextCursor: number;
  pending: number;
  dropped: number;
  policy: { wake: string; coalesceMs: number };
}

const directories: string[] = [];
const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
  // Delivery and the queue finish their last serialized writes after stop(); removing the state
  // directory under them would turn that into an unhandled ENOENT rather than a test failure.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

async function testBroker(directory?: string) {
  const dir = directory ?? await mkdtemp(join(tmpdir(), "cyberdeck-notification-broker-"));
  if (directory === undefined) directories.push(dir);
  const socketPath = join(dir, `broker-${Math.random().toString(16).slice(2, 8)}.sock`);
  const ptys: FakePty[] = [];
  const ptyFactory = vi.fn(() => { const pty = new FakePty(3000 + ptys.length); ptys.push(pty); return pty; });
  const transcripts = new ThreadTranscriptStore(dir);
  const events: BrokerEvent[] = [];
  const journal = { append: async (event: BrokerEvent) => { events.push(event); } };
  const registry = new SessionRegistry({
    workerTurnObservation: new WorkerTurnObservationAdapter(),
    adapters,
    sessionRuntimeFactory: ptyFactory,
    journal,
    transcripts,
    store: { put: async () => undefined, delete: async () => undefined },
    validateCwd: async () => undefined,
    config: BrokerRuntimeConfigSchema.parse({ maxConcurrentWorkers: 8 }),
  });
  const orchestratorStore = new OrchestratorStore(dir);
  const workerPreferences = new WorkerPreferenceStore(dir);
  const coordination = new WorkerCoordinationRuntime({
    stateDirectory: dir,
    orchestrators: orchestratorStore,
    createService: (store) => new ObservedWorkerCoordinationService({ store }),
  });
  await coordination.start();
  const inbox = new OrchestratorNotificationStore(dir);
  await inbox.load();
  const instructionStore = new InstructionStore(dir);
  const feed = composeOrchestratorNotificationFeed({
    inbox,
    noticeFiles: new OrchestratorNoticeFiles(dir),
    bindings: orchestratorStore,
    registry,
    coordination: coordination.service,
    instructionRepository: instructionStore,
  });
  const instructions = new InstructionQueue(
    registry,
    orchestratorStore,
    observeInstructionRepository(instructionStore, (record) => feed.observeInstruction(record)),
  );
  instructions.start();
  await feed.start(instructions);
  const orchestrators = new OrchestratorManager(registry, orchestratorStore, workerPreferences);
  const agentControl = new AgentControlService(registry, orchestratorStore, transcripts, workerPreferences, {
    audit: journal,
    notifications: inbox,
  });
  const server = new BrokerServer({
    socketPath,
    registry,
    transcripts,
    orchestrators,
    agentControl,
    instructions,
    notifications: feed.control,
    workerPreferences,
    onShutdown: () => { void server.close(); },
  });
  await server.listen();
  const client = await TestClient.open(socketPath);
  const close = async () => {
    await client.close();
    feed.stop();
    instructions.stop();
    await server.close();
  };
  open.push(close);
  const ensure = (scope: "fleet" | "workspace", cwd = "/tmp/repo") => client.request<{ session: { id: string } }>(
    "orchestrator.ensure",
    { provider: "codex", model: "gpt-5.6-sol", effort: "high", cwd, scope },
  );
  const startWorker = (actorSessionId: string, cwd = "/tmp/repo") => client.request<{ sessionId: string }>(
    "agent.worker.start",
    { actorSessionId, provider: "codex", model: "gpt-5.6-terra", effort: "low", cwd, sandbox: "read-only", prompt: "Inspect" },
  );
  const read = (actorSessionId: string, extra: Record<string, unknown> = {}) =>
    client.request<ReadResult>("agent.notifications.read", { actorSessionId, ...extra });
  const notice = (actorSessionId: string) =>
    client.request<{ notice?: { pending: number; text: string } }>("agent.notifications.notice", { actorSessionId });
  const settle = async (actorSessionId: string, sessionId: string): Promise<void> => {
    const pty = ptys[ptyRecords().findIndex((record) => record.id === sessionId)];
    pty!.exit(0);
    await vi.waitFor(async () => {
      expect((await read(actorSessionId)).notifications.some((entry) => entry.sessionId === sessionId)).toBe(true);
    }, { timeout: 4_000 });
  };
  const ptyRecords = (): SessionRecord[] => registry.list()
    .slice()
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
  return { dir, socketPath, client, close, registry, inbox, orchestratorStore, ensure, startWorker, read, notice, settle, ptys, ptyRecords };
}

describe("orchestrator notification feed on a test broker", () => {
  it("settles a worker into the orchestrator's inbox, notices once, drains by cursor and replays until acknowledged (rows 1, 11)", async () => {
    const broker = await testBroker();
    const orc = (await broker.ensure("fleet")).session.id;
    await broker.client.request("agent.notifications.configure", { actorSessionId: orc, policy: { wake: "off" } });
    const worker = (await broker.startWorker(orc)).sessionId;
    await expect(broker.notice(orc)).resolves.toEqual({});
    await broker.settle(orc, worker);

    const first = await broker.notice(orc);
    expect(first.notice).toMatchObject({ pending: 1, text: expect.stringContaining("cyberdeck_notifications_read") });
    expect(first.notice!.text.length).toBeLessThanOrEqual(200);
    await expect(broker.notice(orc)).resolves.toEqual({});

    const page = await broker.read(orc);
    expect(page.notifications).toHaveLength(1);
    expect(page.notifications[0]).toMatchObject({ kind: "settled", sessionId: worker, deliveredVia: ["tool-result"] });
    expect(page.notifications[0]!.summary).toMatch(/exited|stopped|settled|terminal/iu);
    const replay = await broker.read(orc);
    expect(replay.notifications.map((entry) => entry.id)).toEqual(page.notifications.map((entry) => entry.id));
    const after = await broker.read(orc, { acknowledgeThrough: page.nextCursor });
    expect(after.notifications).toEqual([]);
    expect(after.pending).toBe(0);
    await expect(broker.notice(orc)).resolves.toEqual({});
  });

  it("wakes an idle orchestrator through the instruction queue with a broker-owned notice line (row 3)", async () => {
    const broker = await testBroker();
    const orc = (await broker.ensure("fleet")).session.id;
    await broker.client.request("agent.notifications.configure", { actorSessionId: orc, policy: { coalesceMs: 0 } });
    const worker = (await broker.startWorker(orc)).sessionId;
    await broker.settle(orc, worker);
    // The queue flushes the wake asynchronously after accepting it; wait for the delivery verdict.
    const wake = await vi.waitFor(async () => {
      const records = await broker.client.request<InstructionRecord[]>("agent.instruction.list", { targetSessionId: orc });
      const found = records.find((record) => record.brokerOwned === true);
      expect(found).toBeDefined();
      expect(found!.status).not.toBe("accepted");
      return found!;
    }, { timeout: 4_000 });
    expect(wake.message.startsWith("[cyberdeck notice] ")).toBe(true);
    expect(wake.message).toContain("cyberdeck_notifications_read");
    expect(["rendered", "queued", "submitted", "acknowledged", "completed"]).toContain(wake.status);
    expect(wake.actorSessionId).toBe(orc);
    // One wake per inbox head: the deterministic message id makes a retry a no-op.
    const again = await broker.client.request<InstructionRecord[]>("agent.instruction.list", { targetSessionId: orc });
    expect(again.filter((record) => record.brokerOwned === true)).toHaveLength(1);
  });

  it("holds the wake while a human controls the orchestrator and still answers the busy-path notice (row 5)", async () => {
    const broker = await testBroker();
    const orc = (await broker.ensure("fleet")).session.id;
    await broker.client.request("agent.notifications.configure", { actorSessionId: orc, policy: { coalesceMs: 0 } });
    const human = await TestClient.open(broker.socketPath);
    open.push(() => human.close());
    await human.request("session.attach", { sessionId: orc });
    const worker = (await broker.startWorker(orc)).sessionId;
    await broker.settle(orc, worker);
    const wake = await vi.waitFor(async () => {
      const records = await broker.client.request<InstructionRecord[]>("agent.instruction.list", { targetSessionId: orc });
      const found = records.find((record) => record.brokerOwned === true);
      expect(found).toMatchObject({ status: "queued", holdReason: "human-controller" });
      return found!;
    }, { timeout: 4_000 });
    expect(wake.message.startsWith("[cyberdeck notice] ")).toBe(true);
    const notice = await broker.notice(orc);
    expect(notice.notice?.pending).toBe(1);
  });

  it("keeps each orchestrator's records to itself (row 14)", async () => {
    const broker = await testBroker();
    const fleet = (await broker.ensure("fleet")).session.id;
    const workspace = (await broker.ensure("workspace", "/tmp/repo-two")).session.id;
    for (const actor of [fleet, workspace]) {
      await broker.client.request("agent.notifications.configure", { actorSessionId: actor, policy: { wake: "off" } });
    }
    const fleetWorker = (await broker.startWorker(fleet)).sessionId;
    const workspaceWorker = (await broker.startWorker(workspace, "/tmp/repo-two")).sessionId;
    await broker.settle(fleet, fleetWorker);
    await broker.settle(workspace, workspaceWorker);
    const fleetPage = await broker.read(fleet);
    const workspacePage = await broker.read(workspace);
    expect(fleetPage.notifications.map((entry) => entry.sessionId)).toEqual([fleetWorker]);
    expect(workspacePage.notifications.map((entry) => entry.sessionId)).toEqual([workspaceWorker]);
    expect(fleetPage.notifications[0]!.controllerId).not.toBe(workspacePage.notifications[0]!.controllerId);
  });

  it("replays pending records and rewrites the notice file after a broker restart without duplicating settled (row 13)", async () => {
    const first = await testBroker();
    const orc = (await first.ensure("fleet")).session.id;
    await first.client.request("agent.notifications.configure", { actorSessionId: orc, policy: { wake: "off" } });
    const worker = (await first.startWorker(orc)).sessionId;
    await first.settle(orc, worker);
    const before = await first.read(orc);
    expect(before.notifications).toHaveLength(1);
    const noticeFile = join(orchestratorNoticeDirectory(first.dir, orc), "notice.json");
    await vi.waitFor(async () => { expect(JSON.parse(await readFile(noticeFile, "utf8"))).toMatchObject({ pending: 1, sessionId: orc }); });
    await first.close();
    open.splice(open.indexOf(first.close), 1);
    await rm(noticeFile, { force: true });

    const second = await testBroker(first.dir);
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(noticeFile, "utf8"))).toMatchObject({ pending: 1, sessionId: orc, cursor: before.nextCursor });
    });
    const after = await second.read(orc);
    expect(after.notifications.map((entry) => entry.id)).toEqual(before.notifications.map((entry) => entry.id));
    expect(after.pending).toBe(1);
    expect(after.policy.wake).toBe("off");
    await second.read(orc, { acknowledgeThrough: after.nextCursor });
    await vi.waitFor(async () => {
      await expect(readFile(noticeFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
