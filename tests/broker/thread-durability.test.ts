import { describe, expect, it, vi } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { BrokerEvent } from "../../src/domain/events.js";
import type { SessionRecord, StartSessionRequest } from "../../src/domain/session.js";
import { SessionRegistry, type PtyHandle } from "../../src/broker/session-registry.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../../src/providers/provider.js";
import type { AppendThreadEvent } from "../../src/persistence/thread-transcript-store.js";

const NOW = "2026-07-26T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

class FakePty implements PtyHandle {
  killCount = 0;
  private readonly outputListeners = new Set<(chunk: Buffer) => void>();
  private readonly exitListeners = new Set<(exitCode: number, signal?: number) => void>();
  private replay = "";

  constructor(readonly pid: number, private readonly exitOnKill = true) {}

  write(): void {}
  resize(): void {}
  snapshot(): Buffer { return Buffer.from(this.replay); }
  kill(): void {
    this.killCount += 1;
    if (this.exitOnKill) this.emitExit(0);
  }
  onOutput(listener: (chunk: Buffer) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }
  onExit(listener: (exitCode: number, signal?: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  emitOutput(text: string): void {
    this.replay += text;
    for (const listener of this.outputListeners) listener(Buffer.from(text));
  }
  emitExit(exitCode = 0): void {
    for (const listener of this.exitListeners) listener(exitCode);
  }
}

const adapter: ProviderAdapter = {
  id: "codex",
  buildLaunchSpec: (session) => ({ executable: "fake", args: [session.id], cwd: session.cwd, env: {} }),
  buildResumeSpec: (session) => ({ executable: "fake", args: ["resume", session.id], cwd: session.cwd, env: {} }),
};

function request(overrides: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return { provider: "codex", cwd: "/tmp/repo", detached: true, sandbox: "read-only", ...overrides };
}

function persisted(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "codex",
    cwd: "/tmp/repo",
    detached: true,
    sandbox: "read-only",
    kind: "worker",
    name: "Durable thread",
    createdAt: "2026-07-26T11:00:00.000Z",
    updatedAt: "2026-07-26T11:30:00.000Z",
    meaningfulUpdatedAt: "2026-07-26T11:30:00.000Z",
    executionState: "active",
    attachmentState: "detached",
    pid: 4321,
    exitCode: null,
    childIds: [],
    attentionState: "done",
    latestPreview: "The finished answer.",
    ...overrides,
  } as SessionRecord;
}

interface HarnessOptions {
  recoveredSessions?: readonly SessionRecord[];
  maxConcurrentWorkers?: number | null;
  threadRetention?: Record<string, unknown>;
  exitOnKill?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const ptys: FakePty[] = [];
  const events: BrokerEvent[] = [];
  const stored = new Map<string, SessionRecord>();
  const deleted: string[] = [];
  const registry = new SessionRegistry({
    adapters: { codex: adapter },
    ptyFactory: vi.fn((_spec: ProviderLaunchSpec) => {
      const pty = new FakePty(1000 + ptys.length, options.exitOnKill ?? true);
      ptys.push(pty);
      return pty;
    }),
    journal: { append: async (event) => { events.push(event); } },
    transcripts: { append: async (_event: AppendThreadEvent) => ({}) } as never,
    store: {
      put: async (record) => { stored.set(record.id, record); },
      delete: async (sessionId) => { stored.delete(sessionId); deleted.push(sessionId); },
    },
    ...(options.recoveredSessions === undefined ? {} : { recoveredSessions: options.recoveredSessions }),
    validateCwd: async () => undefined,
    config: BrokerRuntimeConfigSchema.parse({
      ...(options.maxConcurrentWorkers === undefined
        ? {}
        : { maxConcurrentWorkers: options.maxConcurrentWorkers }),
      ...(options.threadRetention === undefined ? {} : { threadRetention: options.threadRetention }),
    }),
  });
  return { registry, ptys, events, stored, deleted };
}

/** Drive a session through a working turn to the idle state the broker reads as a finished task. */
async function finishTurn(registry: SessionRegistry, pty: FakePty, sessionId: string): Promise<void> {
  pty.emitOutput("\u001b]0;\u2839 worker\u0007Working\nesc to interrupt");
  pty.emitOutput("\n\u001b[2JDone. The patch is applied.\n\u001b]0;worker\u0007");
  await vi.waitFor(() => expect(registry.get(sessionId).attentionState).toBe("done"));
}

/** Drain the fire-and-forget persistence and sweep chains the registry starts on exit paths. */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("thread records survive the broker", () => {
  it("rehydrates a thread that had finished its task as Done, not as interrupted", async () => {
    const { registry, stored } = harness({ recoveredSessions: [persisted()] });
    await registry.ready();

    expect(registry.list()).toEqual([expect.objectContaining({
      id: persisted().id,
      executionState: "exited",
      attentionState: "done",
      exitCode: 0,
      latestPreview: "The finished answer.",
    })]);
    // The rewrite is written back, so the finished state survives the *next* restart too.
    expect(stored.get(persisted().id)).toMatchObject({ executionState: "exited", attentionState: "done" });
  });

  it("rehydrates a thread that was mid-turn as interrupted", async () => {
    const { registry } = harness({
      recoveredSessions: [
        persisted({ id: "22222222-2222-4222-8222-222222222222", attentionState: "working" }),
        persisted({ id: "33333333-3333-4333-8333-333333333333", attentionState: "needs-input" }),
      ],
    });
    await registry.ready();

    expect(registry.list().map(({ attentionState }) => attentionState)).toEqual(["interrupted", "interrupted"]);
    expect(registry.list().map(({ executionState }) => executionState)).toEqual(["cancelled", "cancelled"]);
  });

  it("rehydrates a session that died inside a live process as failed", async () => {
    const { registry } = harness({
      recoveredSessions: [persisted({ executionState: "errored", attentionState: "failed" })],
    });
    await registry.ready();

    expect(registry.list()).toEqual([expect.objectContaining({
      executionState: "failed",
      attentionState: "failed",
      exitCode: 0,
    })]);
  });

  it("does not rewrite a finished thread to stopped while shutting the broker down", async () => {
    const { registry, ptys, stored } = harness();
    const record = await registry.start(request(), "do the work");
    ptys[0]!.emitExit(0);
    await settle();
    expect(registry.get(record.id)).toMatchObject({ executionState: "exited", attentionState: "done" });

    await registry.stopAll();

    expect(registry.get(record.id)).toMatchObject({ executionState: "exited", attentionState: "done" });
    expect(stored.get(record.id)).toMatchObject({ attentionState: "done" });
  });

  it("keeps a finished thread Done when shutdown kills the idle agent still holding it", async () => {
    const { registry, ptys, stored } = harness();
    const record = await registry.start(request(), "do the work");
    // The agent delivered its result and went idle; its process is still alive.
    await finishTurn(registry, ptys[0]!, record.id);

    await registry.stopAll();
    await settle();

    expect(registry.get(record.id)).toMatchObject({ executionState: "cancelled", attentionState: "done" });
    expect(stored.get(record.id)).toMatchObject({ attentionState: "done" });
  });

  it("still reports an operator-initiated stop as stopped", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request(), "do the work");
    await finishTurn(registry, ptys[0]!, record.id);

    await registry.stop(record.id);
    await settle();

    expect(registry.get(record.id)).toMatchObject({ executionState: "cancelled", attentionState: "stopped" });
  });

  it("carries a finished thread through a full stop, restart, and rehydrate cycle as Done", async () => {
    const first = harness();
    const record = await first.registry.start(request(), "do the work");
    first.ptys[0]!.emitExit(0);
    await settle();
    await first.registry.stopAll();

    const second = harness({ recoveredSessions: [...first.stored.values()] });
    await second.registry.ready();

    expect(second.registry.list()).toEqual([expect.objectContaining({
      id: record.id,
      executionState: "exited",
      attentionState: "done",
    })]);
  });
});

describe("the worker slot cap counts running agents only", () => {
  it("frees the slot a finished thread used to hold", async () => {
    const { registry, ptys } = harness({ maxConcurrentWorkers: 1 });
    await registry.start(request(), "first");
    expect(registry.workerCapacity()).toEqual({ activeWorkers: 1, maxConcurrentWorkers: 1 });

    ptys[0]!.emitExit(0);
    await settle();

    expect(registry.workerCapacity().activeWorkers).toBe(0);
    await expect(registry.start(request(), "second")).resolves.toMatchObject({ executionState: "active" });
    expect(registry.list()).toHaveLength(2);
  });

  it("frees the slot a rehydrated finished thread would otherwise hold", async () => {
    const { registry } = harness({ maxConcurrentWorkers: 1, recoveredSessions: [persisted()] });
    await registry.ready();

    expect(registry.workerCapacity().activeWorkers).toBe(0);
    await expect(registry.start(request(), "new work")).resolves.toMatchObject({ executionState: "active" });
  });

  it("still refuses to exceed the cap for genuinely running agents", async () => {
    const { registry } = harness({ maxConcurrentWorkers: 1 });
    await registry.start(request(), "first");
    await expect(registry.start(request(), "second")).rejects.toThrow(/Worker limit reached/u);
  });
});

describe("a session that dies inside a live process", () => {
  const fatal = "\r\nAPI Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\"}}\r\n";

  it("becomes terminal instead of reporting as an active worker", async () => {
    const { registry, ptys, events } = harness({ maxConcurrentWorkers: 1, exitOnKill: false });
    const record = await registry.start(request(), "do the work");

    ptys[0]!.emitOutput(fatal);
    await settle();

    expect(registry.get(record.id)).toMatchObject({
      executionState: "errored",
      attentionState: "failed",
      // The OS process is still there, so the exit code stays unknown and the thread still has to
      // be stopped before it can be deleted.
      exitCode: null,
    });
    expect(events.map(({ type }) => type)).toContain("session.errored");
    expect(registry.workerCapacity().activeWorkers).toBe(0);
  });

  it("never presents as needs-input, so nobody is invited to type at it", async () => {
    const { registry, ptys } = harness({ exitOnKill: false });
    const record = await registry.start(request(), "do the work");

    ptys[0]!.emitOutput("\r\nCodex needs your approval\r\nAllow\r\n");
    await settle();
    expect(registry.get(record.id).attentionState).toBe("needs-input");

    ptys[0]!.emitOutput(fatal);
    await settle();
    expect(registry.get(record.id).attentionState).toBe("failed");

    // Further provider chatter must not resurrect it.
    ptys[0]!.emitOutput("\r\nCodex needs your approval\r\nAllow\r\n");
    await settle();
    expect(registry.get(record.id).attentionState).toBe("failed");
  });

  it("refuses new input and can still be stopped", async () => {
    const { registry, ptys } = harness({ exitOnKill: false });
    const record = await registry.start(request(), "do the work");
    ptys[0]!.emitOutput(fatal);
    await settle();

    await expect(registry.write(record.id, undefined, Buffer.from("hello"))).rejects.toThrow(/not active/u);
    await registry.stop(record.id);
    expect(ptys[0]!.killCount).toBe(1);
  });
});

describe("thread retention", () => {
  it("retires finished threads that have aged out and keeps the rest", async () => {
    const aged = persisted({
      id: "44444444-4444-4444-8444-444444444444",
      executionState: "exited",
      exitCode: 0,
      updatedAt: "2026-06-01T10:00:00.000Z",
      meaningfulUpdatedAt: "2026-06-01T10:00:00.000Z",
    });
    const pinned = persisted({
      id: "55555555-5555-4555-8555-555555555555",
      executionState: "exited",
      exitCode: 0,
      pinned: true,
      updatedAt: "2026-06-01T10:00:00.000Z",
      meaningfulUpdatedAt: "2026-06-01T10:00:00.000Z",
    });
    const { registry, deleted } = harness({ recoveredSessions: [aged, pinned, persisted()] });
    await registry.ready();

    await expect(registry.sweepRetention(NOW_MS)).resolves.toEqual([aged.id]);
    expect(registry.list().map(({ id }) => id)).toEqual([pinned.id, persisted().id]);
    expect(deleted).toEqual([aged.id]);
  });

  it("leaves an aged thread alone once it is running again", async () => {
    const aged = persisted({
      executionState: "exited",
      exitCode: 0,
      updatedAt: "2026-06-01T10:00:00.000Z",
      meaningfulUpdatedAt: "2026-06-01T10:00:00.000Z",
    });
    const { registry } = harness({ recoveredSessions: [aged] });
    await registry.ready();
    await registry.resume(aged.id);

    await expect(registry.sweepRetention(NOW_MS)).resolves.toEqual([]);
    expect(registry.list()).toHaveLength(1);
  });

  it("sweeps automatically when a thread reaches a terminal state", async () => {
    const aged = persisted({
      executionState: "exited",
      exitCode: 0,
      updatedAt: "2026-06-01T10:00:00.000Z",
      meaningfulUpdatedAt: "2026-06-01T10:00:00.000Z",
    });
    const { registry, ptys, deleted } = harness({ recoveredSessions: [aged] });
    await registry.ready();

    await registry.start(request(), "fresh work");
    ptys[0]!.emitExit(0);
    await settle();

    expect(deleted).toEqual([aged.id]);
  });

  it("retains everything when the operator disables both bounds", async () => {
    const aged = persisted({
      executionState: "exited",
      exitCode: 0,
      updatedAt: "2020-01-01T10:00:00.000Z",
      meaningfulUpdatedAt: "2020-01-01T10:00:00.000Z",
    });
    const { registry } = harness({
      recoveredSessions: [aged],
      threadRetention: { maxAgeDays: null, maxThreads: null },
    });
    await registry.ready();

    await expect(registry.sweepRetention(NOW_MS)).resolves.toEqual([]);
    expect(registry.list()).toHaveLength(1);
  });
});
