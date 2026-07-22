import { describe, expect, it, vi } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { BrokerEvent } from "../../src/domain/events.js";
import type { StartSessionRequest } from "../../src/domain/session.js";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../../src/providers/provider.js";
import type { PtyHandle } from "../../src/broker/session-registry.js";
import type { AppendThreadEvent } from "../../src/persistence/thread-transcript-store.js";

class FakePty implements PtyHandle {
  readonly pid: number;
  killCount = 0;
  readonly writes: Buffer[] = [];
  private readonly outputListeners = new Set<(chunk: Buffer) => void>();
  private readonly exitListeners = new Set<(exitCode: number, signal?: number) => void>();
  private replay = "";

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: Buffer): void { this.writes.push(Buffer.from(data)); }
  resize(): void {}
  snapshot(): Buffer { return Buffer.from(this.replay); }
  kill(): void {
    this.killCount += 1;
    this.emitExit(0);
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

const adapters: Record<"codex" | "claude", ProviderAdapter> = {
  codex: {
    id: "codex",
    buildLaunchSpec: (session, initialPrompt) => ({
      executable: "fake",
      args: [session.provider, ...(initialPrompt === undefined ? [] : [initialPrompt])],
      cwd: session.cwd,
      env: {},
    }),
    buildResumeSpec: (session) => ({
      executable: "fake",
      args: ["resume", session.id],
      cwd: session.cwd,
      env: {},
    }),
  },
  claude: {
    id: "claude",
    buildLaunchSpec: (session, initialPrompt) => ({
      executable: "fake",
      args: [session.provider, ...(initialPrompt === undefined ? [] : [initialPrompt])],
      cwd: session.cwd,
      env: { DISABLE_UPDATES: "1" },
    }),
    buildResumeSpec: (session) => ({
      executable: "fake",
      args: ["resume", session.id],
      cwd: session.cwd,
      env: { DISABLE_UPDATES: "1" },
    }),
  },
};

function request(overrides: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return {
    provider: "codex",
    cwd: "/tmp/repo",
    detached: true,
    sandbox: "read-only",
    ...overrides,
  };
}

function harness(options: { failAttachJournal?: boolean; maxConcurrentWorkers?: number | null } = {}) {
  const ptys: FakePty[] = [];
  const events: BrokerEvent[] = [];
  const transcripts: AppendThreadEvent[] = [];
  const ptyFactory = vi.fn((_spec: ProviderLaunchSpec) => {
    const pty = new FakePty(1000 + ptys.length);
    ptys.push(pty);
    return pty;
  });
  const registry = new SessionRegistry({
    adapters,
    ptyFactory,
    journal: { append: async (event) => {
      if (options.failAttachJournal === true && event.type === "session.attached") {
        throw new Error("journal unavailable");
      }
      events.push(event);
    } },
    transcripts: { append: async (event: AppendThreadEvent) => {
      transcripts.push(event);
      return {} as never;
    } } as never,
    config: BrokerRuntimeConfigSchema.parse({
      ...(options.maxConcurrentWorkers === undefined
        ? {}
        : { maxConcurrentWorkers: options.maxConcurrentWorkers }),
    }),
  });
  return { registry, ptys, events, transcripts, ptyFactory };
}

describe("SessionRegistry", () => {
  it("records provider, optional model, opaque role, and PID", async () => {
    const { registry } = harness();
    const record = await registry.start(request({ provider: "claude", model: "opus", role: "writer" }));
    expect(record).toMatchObject({ provider: "claude", model: "opus", role: "writer", pid: 1000 });
  });

  it("rehydrates a broker-lost conversation as interrupted and resumes exact provider state", async () => {
    const persisted = {
      id: "11111111-1111-4111-8111-111111111111",
      provider: "codex" as const,
      model: "gpt-5.6-sol",
      cwd: "/tmp/repo",
      detached: true,
      sandbox: "read-only" as const,
      kind: "worker" as const,
      name: "Persist me",
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:01:00.000Z",
      meaningfulUpdatedAt: "2026-07-22T10:01:00.000Z",
      executionState: "active" as const,
      attachmentState: "detached" as const,
      pid: 4321,
      exitCode: null,
      childIds: [],
      attentionState: "done" as const,
      latestPreview: "Persisted answer",
    };
    const ptys: FakePty[] = [];
    const puts: unknown[] = [];
    const registry = new SessionRegistry({
      adapters,
      recoveredSessions: [persisted],
      store: {
        put: async (value) => { puts.push(value); },
        delete: async () => {},
      },
      ptyFactory: vi.fn(() => {
        const pty = new FakePty(9001);
        ptys.push(pty);
        return pty;
      }),
      journal: { append: async () => {} },
      config: BrokerRuntimeConfigSchema.parse({}),
    });

    await registry.ready();
    expect(registry.list()).toEqual([expect.objectContaining({
      id: persisted.id,
      executionState: "cancelled",
      attentionState: "interrupted",
      latestPreview: "Persisted answer",
    })]);
    expect(registry.snapshot(persisted.id)).toEqual(Buffer.alloc(0));
    await registry.resume(persisted.id);
    expect(ptys).toHaveLength(1);
    expect(registry.get(persisted.id)).toMatchObject({ executionState: "active", attentionState: "done" });
    expect(puts.length).toBeGreaterThanOrEqual(2);
  });

  it("runs provider preflight after command validation and before PTY spawn", async () => {
    const prepareLaunch = vi.fn(async () => undefined);
    const ptyFactory = vi.fn((_spec: ProviderLaunchSpec) => new FakePty(1000));
    const registry = new SessionRegistry({
      adapters: { codex: { ...adapters.codex, prepareLaunch } },
      ptyFactory,
      journal: { append: async () => {} },
      config: BrokerRuntimeConfigSchema.parse({}),
    });

    await registry.start(request());

    expect(prepareLaunch).toHaveBeenCalledOnce();
    expect(ptyFactory).toHaveBeenCalledOnce();
    expect(prepareLaunch.mock.invocationCallOrder[0]).toBeLessThan(ptyFactory.mock.invocationCallOrder[0]!);
  });

  it("idles until a worker returns to input and emits only a compact result", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request({ name: "math-worker", model: "gpt-5.6-sol", effort: "low" }));
    const waiting = registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000, 300);

    ptys[0]!.emitOutput("\u001b]0;⠹ math-worker\u0007\u001b[2JWorking");
    ptys[0]!.emitOutput("\u001b[2J42 + 1000 = 1042\r\n\u001b]0;math-worker\u0007");

    await expect(waiting).resolves.toEqual({
      timedOut: false,
      results: [{
        sessionId: record.id,
        name: "math-worker",
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "low",
        status: "completed",
        completedTurns: 1,
        text: expect.stringContaining("1042"),
      }],
    });
    expect((await waiting).results[0]!.text.length).toBeLessThanOrEqual(300);
  });

  it("returns a blocking provider prompt without waiting for the timeout", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request());
    ptys[0]!.emitOutput("Do you trust the contents of this project?\r\n> Yes, I trust this folder");

    await expect(registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000)).resolves.toMatchObject({
      timedOut: false,
      results: [{ status: "blocked", completedTurns: 0 }],
    });
  });

  it("limits workers independently from orchestrators and reports the active count", async () => {
    const { registry } = harness({ maxConcurrentWorkers: 1 });
    await registry.start(request({ kind: "orchestrator" }));
    await registry.start(request({ kind: "worker" }));
    expect(registry.workerCapacity()).toEqual({ activeWorkers: 1, maxConcurrentWorkers: 1 });

    await expect(registry.start(request({ kind: "worker" }))).rejects.toMatchObject({
      code: "MAX_CONCURRENT_WORKERS",
      message: "Worker limit reached: 1 active / 1 allowed",
    });
  });

  it("rejects a syntactically valid provider without an interactive adapter", async () => {
    const { registry } = harness();
    await expect(registry.start(request({ provider: "cursor" }))).rejects.toMatchObject({
      code: "PROVIDER_NOT_REGISTERED",
    });
  });

  it("forwards an initial task to the provider without persisting it in the session record", async () => {
    const { registry, ptyFactory, transcripts } = harness();
    const record = await registry.start(request(), "Inspect the failure");
    expect(ptyFactory).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["codex", "Inspect the failure"] }),
      expect.any(Number),
    );
    expect(record).not.toHaveProperty("initialPrompt");
    expect(transcripts).toContainEqual(expect.objectContaining({
      sessionId: record.id,
      kind: "prompt",
      source: "human",
      text: "Inspect the failure",
    }));
  });

  it("allows one controller and multiple watchers and broadcasts output", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request());
    const controller = vi.fn();
    const watcherOne = vi.fn();
    const watcherTwo = vi.fn();
    await registry.attach(record.id, "controller", "control", controller);
    await registry.attach(record.id, "watcher-1", "watch", watcherOne);
    await registry.attach(record.id, "watcher-2", "watch", watcherTwo);

    await expect(
      registry.attach(record.id, "other-controller", "control", vi.fn()),
    ).rejects.toMatchObject({ code: "SESSION_ALREADY_CONTROLLED" });
    ptys[0]!.emitOutput("hello");
    expect(controller).toHaveBeenCalledOnce();
    expect(watcherOne).toHaveBeenCalledOnce();
    expect(watcherTwo).toHaveBeenCalledOnce();
    expect(registry.get(record.id).attachmentState).toBe("controlled");
  });

  it("detaches a controller without killing the PTY", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request());
    await registry.attach(record.id, "controller", "control", vi.fn());
    await registry.detach(record.id, "controller");
    expect(registry.get(record.id).attachmentState).toBe("detached");
    expect(ptys[0]!.killCount).toBe(0);
  });

  it("releases attachments on provider exit and refuses to control a terminal PTY", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request());
    const ended = vi.fn();
    await registry.attach(record.id, "controller", "control", vi.fn(), ended);

    ptys[0]!.emitExit(7);

    expect(ended).toHaveBeenCalledWith(7);
    expect(registry.get(record.id)).toMatchObject({
      executionState: "failed",
      attachmentState: "detached",
      exitCode: 7,
    });
    await expect(registry.attach(record.id, "next", "control", vi.fn()))
      .rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
  });

  it("rolls back a controller claim when attachment journaling fails", async () => {
    const { registry } = harness({ failAttachJournal: true });
    const record = await registry.start(request());

    await expect(registry.attach(record.id, "controller", "control", vi.fn()))
      .rejects.toThrow("journal unavailable");
    expect(registry.get(record.id).attachmentState).toBe("detached");
  });

  it("stops a session by killing its PTY exactly once", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request());
    await registry.stop(record.id);
    await registry.stop(record.id);
    expect(ptys[0]!.killCount).toBe(1);
  });

  it("replaces a terminal PTY with the provider's exact resume command", async () => {
    const { registry, ptys, ptyFactory, events } = harness();
    const record = await registry.start(request());
    await registry.stop(record.id);

    const resumed = await registry.resume(record.id);

    expect(resumed).toMatchObject({
      id: record.id,
      executionState: "active",
      attachmentState: "detached",
      exitCode: null,
      pid: 1001,
    });
    expect(ptys).toHaveLength(2);
    expect(ptyFactory.mock.calls[1]?.[0]).toMatchObject({ args: ["resume", record.id] });
    expect(events.at(-1)).toMatchObject({ type: "session.resumed", sessionId: record.id });
  });

  it("submits a logical message through the selected provider adapter", async () => {
    const { registry, ptys, transcripts } = harness();
    const record = await registry.start(request());
    await registry.submit(record.id, undefined, "ping");
    expect(ptys[0]!.writes.at(-1)?.toString("utf8")).toBe("ping\n");
    expect(transcripts).toContainEqual(expect.objectContaining({ kind: "prompt", text: "ping" }));
  });

  it("never lets an orchestrator instruction write through a human controller", async () => {
    const { registry, ptys, transcripts } = harness();
    const record = await registry.start(request());
    await registry.attach(record.id, "human", "control", vi.fn());

    await expect(registry.submitInstruction(record.id, "queued instruction"))
      .rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect(ptys[0]!.writes).toEqual([]);
    await registry.detach(record.id, "human");
    await expect(registry.submitInstruction(record.id, "queued instruction")).resolves.toBeUndefined();
    expect(ptys[0]!.writes.at(-1)?.toString()).toBe("queued instruction\n");
    expect(transcripts).toContainEqual(expect.objectContaining({
      kind: "instruction",
      source: "orchestrator",
      text: "queued instruction",
    }));
  });

  it("deletes only terminal sessions and journals the deletion", async () => {
    const { registry, events } = harness();
    const record = await registry.start(request());
    await expect(registry.delete(record.id)).rejects.toMatchObject({ code: "SESSION_STILL_ACTIVE" });
    await registry.stop(record.id);
    await registry.delete(record.id);
    expect(registry.list()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "session.deleted", sessionId: record.id });
  });

  it("does not delete a parent while child thread records still exist", async () => {
    const { registry } = harness();
    const parent = await registry.start(request());
    const child = await registry.start(request({ parentSessionId: parent.id }));
    await registry.stop(parent.id);
    await registry.stop(child.id);
    await expect(registry.delete(parent.id)).rejects.toMatchObject({ code: "SESSION_HAS_CHILDREN" });
    await registry.delete(child.id);
    await expect(registry.delete(parent.id)).resolves.toBeUndefined();
  });

  it("records delegated children under their parent", async () => {
    const { registry } = harness();
    const parent = await registry.start(request());
    const child = await registry.start(request({ provider: "claude", parentSessionId: parent.id }));
    expect(registry.get(parent.id).childIds).toContain(child.id);
  });

  it("rejects delegated Fable before creating a PTY", async () => {
    const { registry, ptyFactory } = harness();
    const parent = await registry.start(request());
    await expect(
      registry.start(request({ provider: "claude", model: "fable", parentSessionId: parent.id })),
    ).rejects.toMatchObject({ code: "FABLE_REQUIRES_EXPLICIT_HUMAN_START" });
    expect(ptyFactory).toHaveBeenCalledTimes(1);
  });

  it.each(["scout", "writer", "cheap-task"])("does not interpret role %s", async (role) => {
    const { registry } = harness();
    await expect(registry.start(request({ role }))).resolves.toMatchObject({ role });
  });
});
