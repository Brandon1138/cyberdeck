import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { BrokerEvent } from "../../src/domain/events.js";
import type { SessionRecord, StartSessionRequest } from "../../src/domain/session.js";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude.js";
import type {
  ProviderAdapter,
  ProviderLaunchSpec,
  ProviderSessionTerminal,
} from "../../src/providers/provider.js";
import type { PtyHandle } from "../../src/broker/session-registry.js";
import {
  ThreadTranscriptStore,
  type AppendThreadEvent,
} from "../../src/persistence/thread-transcript-store.js";

class FakePty implements PtyHandle {
  readonly pid: number;
  killCount = 0;
  readonly killSignals: Array<string | undefined> = [];
  readonly writes: Buffer[] = [];
  private readonly outputListeners = new Set<(chunk: Buffer) => void>();
  private readonly exitListeners = new Set<(exitCode: number, signal?: number) => void>();
  private replay = "";

  constructor(pid: number, private readonly exitOnKill = true) {
    this.pid = pid;
  }

  write(data: Buffer): void { this.writes.push(Buffer.from(data)); }
  resize(): void {}
  snapshot(): Buffer { return Buffer.from(this.replay); }
  kill(signal?: string): void {
    this.killCount += 1;
    this.killSignals.push(signal);
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

function harness(options: {
  failAttachJournal?: boolean;
  maxConcurrentWorkers?: number | null;
  exitOnKill?: boolean;
  workerStallSeconds?: number;
  now?: () => number;
  adapters?: Record<string, ProviderAdapter>;
} = {}) {
  const ptys: FakePty[] = [];
  const events: BrokerEvent[] = [];
  const transcripts: AppendThreadEvent[] = [];
  const ptyFactory = vi.fn((_spec: ProviderLaunchSpec) => {
    const pty = new FakePty(1000 + ptys.length, options.exitOnKill ?? true);
    ptys.push(pty);
    return pty;
  });
  const registry = new SessionRegistry({
    adapters: options.adapters ?? adapters,
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
    validateCwd: async () => undefined,
    config: BrokerRuntimeConfigSchema.parse({
      ...(options.maxConcurrentWorkers === undefined
        ? {}
        : { maxConcurrentWorkers: options.maxConcurrentWorkers }),
      ...(options.workerStallSeconds === undefined
        ? {}
        : { workerStallSeconds: options.workerStallSeconds }),
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { registry, ptys, events, transcripts, ptyFactory };
}

describe("SessionRegistry", () => {
  it("records provider, optional model, opaque role, and PID", async () => {
    const { registry } = harness();
    const record = await registry.start(request({ provider: "claude", model: "opus", role: "writer" }));
    expect(record).toMatchObject({
      provider: "claude",
      model: "opus",
      role: "writer",
      pid: 1000,
      generation: 1,
    });
  });

  it("increments the durable process generation on resume", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request());
    ptys[0]!.emitExit(0);

    await expect(registry.resume(record.id)).resolves.toMatchObject({ generation: 2 });
  });

  it("rehydrates a conversation lost mid-turn as interrupted and resumes exact provider state", async () => {
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
      attentionState: "working" as const,
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
      validateCwd: async () => undefined,
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
      validateCwd: async () => undefined,
      config: BrokerRuntimeConfigSchema.parse({}),
    });

    await registry.start(request());

    expect(prepareLaunch).toHaveBeenCalledOnce();
    expect(ptyFactory).toHaveBeenCalledOnce();
    expect(prepareLaunch.mock.invocationCallOrder[0]).toBeLessThan(ptyFactory.mock.invocationCallOrder[0]!);
  });

  it("finishes provider setup before submitting a deferred initial prompt", async () => {
    const initializeSession = vi.fn(async (
      _session: SessionRecord,
      terminal: ProviderSessionTerminal,
    ) => {
      terminal.write(Buffer.from("SETUP"));
    });
    const submitInputToTerminal = vi.fn(async (
      message: string,
      terminal: ProviderSessionTerminal,
    ) => {
      terminal.write(Buffer.from(message));
    });
    const cursor: ProviderAdapter = {
      id: "cursor",
      buildLaunchSpec: (session, initialPrompt) => ({
        executable: "fake",
        args: initialPrompt === undefined ? [] : [initialPrompt],
        cwd: session.cwd,
        env: {},
      }),
      deferInitialPrompt: () => true,
      initializeSession,
      buildResumeSpec: () => {
        throw new Error("not used");
      },
      submitInputToTerminal,
    };
    const { registry, ptys, ptyFactory, transcripts } = harness({
      adapters: { ...adapters, cursor },
    });

    await registry.start(
      request({
        provider: "cursor",
        model: "composer",
        approvalMode: "auto",
        workerMode: "caveman",
      }),
      "Open the pull request",
    );

    expect(ptyFactory.mock.calls[0]?.[0]).toMatchObject({ args: [] });
    expect(initializeSession).toHaveBeenCalledOnce();
    expect(submitInputToTerminal).toHaveBeenCalledOnce();
    expect(ptys[0]!.writes[0]!.toString()).toBe("SETUP");
    expect(ptys[0]!.writes[1]!.toString()).toContain(
      "CAVEMAN MODE ACTIVE — Cyberdeck worker output policy.",
    );
    expect(ptys[0]!.writes[1]!.toString()).toContain(
      "WORKER TASK\nOpen the pull request",
    );
    expect(transcripts.filter(({ kind }) => kind === "prompt")).toEqual([
      expect.objectContaining({ text: "Open the pull request" }),
    ]);
  });

  it("does not count Composer permission setup as worker task completion", async () => {
    let ptys: FakePty[] = [];
    const cursor: ProviderAdapter = {
      id: "cursor",
      buildLaunchSpec: (session) => ({
        executable: "fake",
        args: [],
        cwd: session.cwd,
        env: {},
      }),
      deferInitialPrompt: () => true,
      initializeSession: async () => {
        ptys[0]!.emitOutput("Composing 5.53k tokens\nctrl+c to stop");
        ptys[0]!.emitOutput("\nRun Everything enabled\n→ \n");
        await new Promise((resolve) => setTimeout(resolve, 250));
      },
      buildResumeSpec: () => {
        throw new Error("not used");
      },
      submitInput: (message) => Buffer.from(`${message}\r`),
    };
    const setup = harness({ adapters: { ...adapters, cursor } });
    ptys = setup.ptys;

    const record = await setup.registry.start(
      request({ provider: "cursor", model: "composer", approvalMode: "auto" }),
      "Open the pull request",
    );

    await expect(setup.registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 0, 500)).resolves.toMatchObject({
      timedOut: true,
      results: [{ status: "waiting", completedTurns: 0 }],
    });

    ptys[0]!.emitOutput("Composing 6k tokens\nctrl+c to stop");
    ptys[0]!.emitOutput("\nOpened pull request #7\nCursor is waiting for you\n");
    await expect(setup.registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000, 500)).resolves.toMatchObject({
      timedOut: false,
      results: [{
        status: "completed",
        completedTurns: 1,
        text: expect.stringContaining("Opened pull request #7"),
      }],
    });
  });

  it("fails closed and removes the session when provider permission setup cannot be verified", async () => {
    const cursor: ProviderAdapter = {
      id: "cursor",
      buildLaunchSpec: (session) => ({
        executable: "fake",
        args: [],
        cwd: session.cwd,
        env: {},
      }),
      deferInitialPrompt: () => true,
      initializeSession: async () => {
        throw Object.assign(
          new Error("Composer /run-everything setup failed: provider still reports manual mode"),
          { code: "PROVIDER_PERMISSION_MODE_NOT_APPLIED" },
        );
      },
      buildResumeSpec: () => {
        throw new Error("not used");
      },
    };
    const { registry, ptys, events } = harness({ adapters: { ...adapters, cursor } });

    await expect(registry.start(
      request({ provider: "cursor", model: "composer", approvalMode: "auto" }),
      "Open the pull request",
    )).rejects.toMatchObject({
      code: "PROVIDER_PERMISSION_MODE_NOT_APPLIED",
      message: expect.stringContaining("still reports manual mode"),
    });
    expect(ptys[0]!.killCount).toBe(1);
    expect(registry.list()).toEqual([]);
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.exited" }),
    ]));

    ptys[0]!.emitExit(0);
    ptys[0]!.emitOutput("late stale output");
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.exited" }),
    ]));
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
        retrieval: "fresh",
        completedAt: expect.any(String),
      }],
    });
    expect((await waiting).results[0]!.text.length).toBeLessThanOrEqual(300);
  });

  it("replays a completed target idempotently after the first delivery is lost in transport", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request({ name: "install-worker" }));
    const target = [{ sessionId: record.id, completionTarget: 1 }];
    // The orchestrator's transport dies while this wait is outstanding; the broker still resolves it.
    const abandoned = registry.waitForWorkerResults(target, 5_000, 300);

    ptys[0]!.emitOutput("\u001b]0;⠹ install-worker\u0007\u001b[2JWorking");
    ptys[0]!.emitOutput("\u001b[2Jdevice install applied once\r\n\u001b]0;install-worker\u0007");
    const lost = await abandoned;
    expect(lost.results[0]).toMatchObject({ status: "completed", retrieval: "fresh" });

    const retry = await registry.waitForWorkerResults(target, 5_000, 300);
    expect(retry).toMatchObject({
      timedOut: false,
      results: [{
        status: "completed",
        retrieval: "replay",
        completedAt: lost.results[0]!.completedAt,
        text: lost.results[0]!.text,
      }],
    });

    // A later turn must not rewrite the answer target 1 already recorded.
    ptys[0]!.emitOutput("\u001b]0;⠹ install-worker\u0007\u001b[2JWorking");
    ptys[0]!.emitOutput("\u001b[2Jsecond turn output\r\n\u001b]0;install-worker\u0007");
    const second = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 2 },
    ], 5_000, 300);
    expect(second.results[0]!.text).toContain("second turn output");
    const replayed = await registry.waitForWorkerResults(target, 5_000, 300);
    expect(replayed.results[0]).toMatchObject({
      retrieval: "replay",
      text: lost.results[0]!.text,
    });
  });

  it("returns a structured timeout instead of throwing when a worker is still working", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request({ name: "slow-worker" }));
    ptys[0]!.emitOutput("\u001b]0;⠹ slow-worker\u0007\u001b[2JWorking");

    await expect(registry.waitForWorkerResults(
      [{ sessionId: record.id, completionTarget: 1 }],
      50,
      300,
    )).resolves.toMatchObject({
      timedOut: true,
      results: [{ status: "working" }],
    });
  });

  it("completes a Composer turn when an idle slash-command overlay covers the prompt", async () => {
    const cursor: ProviderAdapter = {
      id: "cursor",
      buildLaunchSpec: (session, initialPrompt) => ({
        executable: "fake",
        args: initialPrompt === undefined ? [] : [initialPrompt],
        cwd: session.cwd,
        env: {},
      }),
      buildResumeSpec: () => {
        throw new Error("not used");
      },
      submitInput: (message) => Buffer.from(`${message}\r`),
    };
    const { registry, ptys } = harness({ adapters: { ...adapters, cursor } });
    const record = await registry.start(
      request({ provider: "cursor", model: "composer" }),
      "Open the pull request",
    );
    const waiting = registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000, 500);

    ptys[0]!.emitOutput("Composing 5.53k tokens\nctrl+c to stop");
    ptys[0]!.emitOutput([
      "\nOpened pull request #4",
      "→ /",
      "No matches",
      "/model [filter] Select model (Tab to edit)",
      "/run-everything Toggle Run Everything (currently enabled)",
    ].join("\n"));

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      results: [{ status: "completed", completedTurns: 1 }],
    });
  });

  it("returns stalled when idle transcript and token count stay byte-identical past threshold", async () => {
    let now = 0;
    const { registry, ptys } = harness({
      workerStallSeconds: 60,
      now: () => now,
    });
    const record = await registry.start(request(), "Finish the task");
    ptys[0]!.emitOutput("Result may be complete\n5.53k tokens");

    await expect(registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 0, 500)).resolves.toMatchObject({
      timedOut: true,
      results: [{ status: "waiting" }],
    });

    now = 61_000;
    await expect(registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 0, 500)).resolves.toMatchObject({
      timedOut: false,
      results: [{
        status: "stalled",
        stalledForSeconds: 61,
        stallReason: "transcript-and-token-count-unchanged-while-idle",
        tokenCount: 5_530,
      }],
    });
  });

  it("uses Claude native final responses for two gap-free semantic completion targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-native-turns-"));
    const claudeProjects = join(root, "claude-projects");
    const project = join(claudeProjects, "-tmp-repo");
    const fixture = await readFile(
      join(process.cwd(), "tests", "fixtures", "claude-native-semantic-turns.jsonl"),
      "utf8",
    );
    const lines = fixture.trimEnd().split("\n");
    const firstTurn = `${lines.slice(0, 5).join("\n")}\n`;
    const secondTurn = `${lines.slice(5).join("\n")}\n`;
    const transcripts = new ThreadTranscriptStore(join(root, "state"), {
      claudeProjectsDirectory: claudeProjects,
    });
    const ptys: FakePty[] = [];
    const registry = new SessionRegistry({
      adapters,
      ptyFactory: () => {
        const pty = new FakePty(2000 + ptys.length);
        ptys.push(pty);
        return pty;
      },
      journal: { append: async () => {} },
      transcripts,
      validateCwd: async () => undefined,
      config: BrokerRuntimeConfigSchema.parse({}),
    });
    const record = await registry.start(
      request({ provider: "claude", model: "opus" }),
      "Inspect semantic turns",
    );
    await mkdir(project, { recursive: true });
    const nativePath = join(project, `${record.id}.jsonl`);
    await writeFile(nativePath, firstTurn);

    const firstWait = registry.waitForWorkerResults(
      [{ sessionId: record.id, completionTarget: 1 }],
      5_000,
      4_000,
    );
    ptys[0]!.emitOutput("\u001b]0;⠹ worker\u0007Working\nesc to interrupt");
    ptys[0]!.emitOutput("\n\u001b[2J⠹ spinner text\n❯ prompt text\nRunning stop hook output\n\u001b]0;worker\u0007");
    const first = await firstWait;
    expect(first.results[0]).toMatchObject({
      status: "completed",
      completedTurns: 1,
    });
    const firstText = first.results[0]!.text;
    expect(firstText).toContain("BEGIN-DISTINCTIVE-FIRST-RESPONSE");
    expect(firstText).toContain("[elided; original length: 5632 characters]");
    expect(firstText).not.toContain("END-DISTINCTIVE-FIRST-RESPONSE");
    expect(firstText).not.toMatch(/\u001b|⠹|Running stop hook|❯/u);

    await appendFile(nativePath, secondTurn);
    await registry.submitInstruction(record.id, "Second semantic turn");
    const secondWait = registry.waitForWorkerResults(
      [{ sessionId: record.id, completionTarget: 2 }],
      5_000,
      4_000,
    );
    ptys[0]!.emitOutput("\u001b]0;⠹ worker\u0007Working\nesc to interrupt");
    ptys[0]!.emitOutput("\n\u001b]0;worker\u0007");
    await expect(secondWait).resolves.toMatchObject({
      timedOut: false,
      results: [{
        status: "completed",
        completedTurns: 2,
        text: "BEGIN-DISTINCTIVE-SECOND-RESPONSE. Completion target two reached exactly once.",
      }],
    });

    const semanticTurns: string[] = [];
    let cursor = 0;
    while (true) {
      const page = await transcripts.read(record.id, cursor, 1);
      if (page.events.length === 0) break;
      expect(page.nextCursor).toBeGreaterThan(cursor);
      cursor = page.nextCursor;
      const event = page.events[0]!;
      if (event.kind === "turn") semanticTurns.push(event.text!);
    }
    expect(semanticTurns).toHaveLength(2);
    expect(semanticTurns.filter((text) =>
      text.includes("BEGIN-DISTINCTIVE-FIRST-RESPONSE"))).toHaveLength(1);
    expect(semanticTurns.filter((text) =>
      text.includes("BEGIN-DISTINCTIVE-SECOND-RESPONSE"))).toHaveLength(1);
    expect(semanticTurns.join("\n")).not.toMatch(/\u001b|⠹|Running stop hook|❯/u);
  });

  it("returns a blocking provider prompt without waiting for the timeout", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request());
    ptys[0]!.emitOutput("Do you trust the contents of this project?\r\n> Yes, I trust this folder");

    await expect(registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000)).resolves.toMatchObject({
      timedOut: false,
      results: [{ status: "needs-input", completedTurns: 0 }],
    });
  });

  it("persists provider approval waits as Needs Input while preserving attach, approve, and detach", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request({ provider: "claude", model: "opus" }), "Run the checks");
    ptys[0]!.emitOutput([
      "Claude needs your permission to use Bash",
      "  pnpm test",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again for pnpm test commands",
      "  3. No",
      "Esc to cancel · Tab to amend",
    ].join("\r\n"));

    await vi.waitFor(() => expect(registry.get(record.id).attentionState).toBe("needs-input"));
    await registry.attach(record.id, "operator", "control", () => undefined);
    await registry.write(record.id, "operator", Buffer.from("1\r"));
    await registry.detach(record.id, "operator");
    expect(ptys[0]!.writes.at(-1)?.toString()).toBe("1\r");
    expect(registry.get(record.id).attachmentState).toBe("detached");

    ptys[0]!.emitOutput("\r\nWorking\r\nesc to interrupt");
    await vi.waitFor(() => expect(registry.get(record.id).attentionState).toBe("working"));
  });

  it("rejects an invalid cwd before constructing a provider process", async () => {
    const ptyFactory = vi.fn((_spec: ProviderLaunchSpec) => new FakePty(1000));
    const registry = new SessionRegistry({
      adapters,
      ptyFactory,
      journal: { append: async () => {} },
      config: BrokerRuntimeConfigSchema.parse({}),
    });

    await expect(registry.start(request({
      cwd: `/tmp/cyberdeck-missing-${crypto.randomUUID()}`,
    }))).rejects.toMatchObject({ code: "INVALID_SESSION_CWD" });
    expect(ptyFactory).not.toHaveBeenCalled();
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

  it("reserves worker capacity while concurrent provider launches prepare", async () => {
    let releaseFirstPrepare!: () => void;
    const firstPrepare = new Promise<void>((resolve) => {
      releaseFirstPrepare = resolve;
    });
    let preparing = 0;
    const slowAdapter: ProviderAdapter = {
      ...adapters.codex,
      prepareLaunch: async () => {
        preparing += 1;
        if (preparing === 1) await firstPrepare;
      },
    };
    const { registry } = harness({
      maxConcurrentWorkers: 1,
      adapters: { codex: slowAdapter },
    });
    const first = registry.start(request({ kind: "worker" }));
    await vi.waitFor(() => expect(preparing).toBe(1));

    try {
      await expect(registry.start(request({ kind: "worker" }))).rejects.toMatchObject({
        code: "MAX_CONCURRENT_WORKERS",
        message: "Worker limit reached: 1 active / 1 allowed",
      });
    } finally {
      releaseFirstPrepare();
    }
    await expect(first).resolves.toMatchObject({ executionState: "active" });
    expect(preparing).toBe(1);
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
      expect.objectContaining({
        args: ["codex", expect.stringContaining("Inspect the failure\n\nCYBERDECK WORKER REPORTING")],
      }),
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
    const { registry, ptys, transcripts } = harness();
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
    expect(transcripts.filter((event) => event.kind === "output")).toEqual([]);
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

  it("keeps repeated graceful stops idempotent and reserves SIGKILL for explicit force", async () => {
    const { registry, ptys } = harness({ exitOnKill: false });
    const record = await registry.start(request());
    await registry.stop(record.id);
    await registry.stop(record.id);
    expect(ptys[0]!.killCount).toBe(1);
    expect(ptys[0]!.killSignals).toEqual(["SIGTERM"]);

    registry.forceStop(record.id);
    expect(ptys[0]!.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("durably marks a naturally completed session as stopped without rewriting its exit result", async () => {
    const { registry, ptys, events, transcripts } = harness();
    const record = await registry.start(request());
    ptys[0]!.emitExit(0);
    expect(registry.get(record.id)).toMatchObject({
      executionState: "exited",
      exitCode: 0,
      attentionState: "done",
    });

    await registry.stop(record.id);
    await registry.stop(record.id);

    expect(registry.get(record.id)).toMatchObject({
      executionState: "exited",
      exitCode: 0,
      attentionState: "stopped",
    });
    expect(events.filter((event) =>
      event.type === "session.stopped" && event.sessionId === record.id)).toHaveLength(1);
    expect(transcripts.filter((event) =>
      event.kind === "lifecycle"
      && event.sessionId === record.id
      && event.text === "session stopped")).toHaveLength(1);
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

  it("lets a replaced PTY's late exit fall on the floor rather than on the resumed session", async () => {
    // A real PTY acknowledges a kill asynchronously, so the orphan's exit and any trailing output
    // arrive after the replacement is already live.
    const { registry, ptys } = harness({ exitOnKill: false });
    const record = await registry.start(request());
    ptys[0]!.emitOutput("API Error: 401 authentication_error\n");
    await vi.waitFor(() => expect(registry.get(record.id).executionState).toBe("errored"));

    await registry.resume(record.id);
    const delivered: string[] = [];
    const output = vi.fn((chunk: Buffer) => { delivered.push(chunk.toString("utf8")); });
    const ended = vi.fn();
    await registry.attach(record.id, "human", "control", output, ended);
    expect(ptys[0]!.killCount).toBe(1);

    ptys[0]!.emitOutput("orphan chatter\n");
    ptys[0]!.emitExit(0);

    expect(registry.get(record.id)).toMatchObject({
      executionState: "active",
      attachmentState: "controlled",
      exitCode: null,
      pid: 1001,
    });
    expect(ended).not.toHaveBeenCalled();
    expect(delivered).not.toContain("orphan chatter\n");

    ptys[1]!.emitOutput("resumed and working\n");
    expect(delivered).toContain("resumed and working\n");
  });

  it("keeps the outgoing PTY when the resume spawn fails, so the process can still be stopped", async () => {
    const ptys: FakePty[] = [];
    const ptyFactory = vi.fn((_spec: ProviderLaunchSpec) => {
      if (ptys.length === 1) throw new Error("provider binary vanished");
      const pty = new FakePty(1000 + ptys.length, false);
      ptys.push(pty);
      return pty;
    });
    const registry = new SessionRegistry({
      adapters,
      ptyFactory,
      journal: { append: async () => {} },
      validateCwd: async () => undefined,
      config: BrokerRuntimeConfigSchema.parse({}),
    });
    const record = await registry.start(request());
    ptys[0]!.emitOutput("API Error: 401 authentication_error\n");
    await vi.waitFor(() => expect(registry.get(record.id).executionState).toBe("errored"));

    await expect(registry.resume(record.id)).rejects.toThrow("provider binary vanished");

    await registry.stop(record.id);
    expect(ptys[0]!.killCount).toBe(2);
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

  it("deletes an orchestrator without deleting or corrupting its worker threads", async () => {
    const { registry, ptys, transcripts } = harness();
    const parent = await registry.start(request({ kind: "orchestrator", role: "orchestrator" }));
    const child = await registry.start(request({
      provider: "claude",
      cwd: "/tmp/worker-repo",
      model: "opus",
      parentSessionId: parent.id,
      kind: "worker",
      role: "worker",
    }), "Preserve this worker transcript");
    ptys[1]!.emitOutput("Worker result remains available");
    await registry.stop(parent.id);
    await registry.stop(child.id);
    await expect(registry.delete(parent.id)).resolves.toBeUndefined();

    expect(() => registry.get(parent.id)).toThrow();
    const survivingWorker = registry.get(child.id);
    expect(survivingWorker).toMatchObject({
      id: child.id,
      provider: "claude",
      model: "opus",
      cwd: "/tmp/worker-repo",
      executionState: "cancelled",
    });
    expect(survivingWorker).not.toHaveProperty("parentSessionId");
    expect(registry.snapshot(child.id).toString()).toContain("Worker result remains available");
    expect(transcripts).toContainEqual(expect.objectContaining({
      sessionId: child.id,
      kind: "prompt",
      text: "Preserve this worker transcript",
    }));
  });

  it("stops an owned tree from the root without deleting its terminal records", async () => {
    const { registry, ptys } = harness();
    const parent = await registry.start(request({ kind: "orchestrator", role: "orchestrator" }));
    const first = await registry.start(request({ parentSessionId: parent.id, kind: "worker" }));
    const second = await registry.start(request({ parentSessionId: parent.id, kind: "worker" }));

    await expect(registry.stopTree(parent.id)).resolves.toMatchObject({
      rootSessionId: parent.id,
      rootKind: "orchestrator",
      total: 3,
      terminal: 3,
      stopping: 0,
    });
    expect(ptys.map((pty) => pty.killCount)).toEqual([1, 1, 1]);

    expect(registry.list().map(({ id }) => id)).toEqual(expect.arrayContaining([parent.id, first.id, second.id]));
  });

  it("keeps a tree visible when any process has not confirmed exit", async () => {
    const { registry, ptys } = harness({ exitOnKill: false });
    const parent = await registry.start(request({ kind: "orchestrator" }));
    await registry.start(request({ parentSessionId: parent.id, kind: "worker" }));

    await expect(registry.stopTree(parent.id)).resolves.toMatchObject({
      total: 2,
      terminal: 0,
      stopping: 2,
    });
    ptys.forEach((pty) => pty.emitExit(0));
    expect(registry.list()).toHaveLength(2);
  });

  it("refuses new children as soon as their parent begins stopping", async () => {
    const { registry } = harness({ exitOnKill: false });
    const parent = await registry.start(request({ kind: "orchestrator" }));
    await registry.stopTree(parent.id);

    await expect(registry.start(request({ parentSessionId: parent.id, kind: "worker" })))
      .rejects.toMatchObject({ code: "PARENT_SESSION_NOT_ACTIVE" });
  });

  it("records delegated children under their parent", async () => {
    const { registry } = harness();
    const parent = await registry.start(request());
    const child = await registry.start(request({ provider: "claude", parentSessionId: parent.id }));
    expect(registry.get(parent.id).childIds).toContain(child.id);
  });

  it("allows an operator-owned child start with an explicit Fable model", async () => {
    const { registry, ptyFactory } = harness();
    const parent = await registry.start(request());
    await expect(
      registry.start(request({ provider: "claude", model: "fable", parentSessionId: parent.id })),
    ).resolves.toMatchObject({ model: "fable", parentSessionId: parent.id });
    expect(ptyFactory).toHaveBeenCalledTimes(2);
  });

  it.each(["scout", "writer", "cheap-task"])("does not interpret role %s", async (role) => {
    const { registry } = harness();
    await expect(registry.start(request({ role }))).resolves.toMatchObject({ role });
  });
});

const SENTINEL_SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-SENTINEL-REGISTRY",
  GITHUB_TOKEN: "ghp_SENTINELREGISTRY",
};

const temporaryDirectories: string[] = [];

function launchFilesDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "cyberdeck-launch-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function claudeRequest(overrides: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return {
    provider: "claude",
    cwd: "/tmp/repo",
    detached: true,
    sandbox: "read-only",
    model: "opus",
    providerInstructions: "Cyberdeck guidance",
    ...overrides,
  };
}

interface SpawnObservation {
  spec: ProviderLaunchSpec;
  payloadFilesPresent: boolean[];
}

/** A registry wired to the real Claude adapter so launch artifacts are the actual private files. */
function claudeHarness(options: { failSpawn?: boolean } = {}) {
  const directory = launchFilesDirectory();
  const adapter = new ClaudeProviderAdapter({
    directory,
    mcp: { nodePath: "/node", cliPath: "/cyberdeck.js" },
  });
  const ptys: FakePty[] = [];
  const spawns: SpawnObservation[] = [];
  const transcripts: AppendThreadEvent[] = [];
  const ptyFactory = vi.fn((spec: ProviderLaunchSpec) => {
    spawns.push({
      spec,
      payloadFilesPresent: payloadPaths(spec).map((path) => existsSync(path)),
    });
    if (options.failSpawn === true) throw new Error("pty construction failed");
    const pty = new FakePty(3000 + ptys.length);
    ptys.push(pty);
    return pty;
  });
  const registry = new SessionRegistry({
    adapters: { claude: adapter },
    ptyFactory,
    journal: { append: async () => {} },
    transcripts: { append: async (event: AppendThreadEvent) => {
      transcripts.push(event);
      return {} as never;
    } } as never,
    validateCwd: async () => undefined,
    config: BrokerRuntimeConfigSchema.parse({}),
  });
  return { registry, adapter, directory, ptys, spawns, ptyFactory, transcripts };
}

function payloadPaths(spec: ProviderLaunchSpec): string[] {
  return ["--append-system-prompt-file", "--mcp-config"]
    .map((flag) => spec.args[spec.args.indexOf(flag) + 1])
    .filter((path): path is string => path !== undefined);
}

describe("SessionRegistry provider launch artifacts", () => {
  it("recreates the payload files a resume spec references before the PTY is constructed", async () => {
    const { registry, ptys, spawns, directory } = claudeHarness();
    const record = await registry.start(claudeRequest());
    expect(spawns[0]?.payloadFilesPresent).toEqual([true, true]);

    ptys[0]!.emitExit(0);
    await until(() => !existsSync(join(directory, record.id)), "launch artifacts to be removed on exit");

    await registry.resume(record.id);

    expect(spawns).toHaveLength(2);
    expect(payloadPaths(spawns[1]!.spec)).toHaveLength(2);
    expect(spawns[1]?.payloadFilesPresent).toEqual([true, true]);
  });

  it("removes launch artifacts when the durable thread is deleted, after an exit already removed them", async () => {
    const { registry, ptys, directory } = claudeHarness();
    const record = await registry.start(claudeRequest());
    const sessionDirectory = join(directory, record.id);
    expect(existsSync(sessionDirectory)).toBe(true);

    ptys[0]!.emitExit(0);
    await until(() => !existsSync(sessionDirectory), "launch artifacts to be removed on exit");

    await expect(registry.delete(record.id)).resolves.toBeUndefined();
    expect(existsSync(sessionDirectory)).toBe(false);
  });

  it("removes prepared artifacts when a launch fails before a live PTY takes ownership", async () => {
    const { registry, directory, spawns } = claudeHarness({ failSpawn: true });

    await expect(registry.start(claudeRequest())).rejects.toThrow("pty construction failed");

    expect(spawns[0]?.payloadFilesPresent).toEqual([true, true]);
    expect(existsSync(join(directory, spawns[0]!.spec.args[1]!))).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it("leaves runtime state untouched when a resume preflight fails", async () => {
    const { registry, adapter, ptys } = claudeHarness();
    const record = await registry.start(claudeRequest());
    ptys[0]!.emitExit(0);
    await until(() => registry.get(record.id).executionState === "exited", "the session to exit");

    const prepareLaunch = vi.spyOn(adapter, "prepareLaunch")
      .mockRejectedValueOnce(new Error("preflight unavailable"));

    await expect(registry.resume(record.id)).rejects.toThrow("preflight unavailable");
    expect(registry.get(record.id)).toMatchObject({ executionState: "exited", exitCode: 0 });
    prepareLaunch.mockRestore();

    await expect(registry.resume(record.id)).resolves.toMatchObject({ executionState: "active" });
  });

  it("records a cleanup failure without masking the exit that triggered it", async () => {
    const ptys: FakePty[] = [];
    const transcripts: AppendThreadEvent[] = [];
    const adapter: ProviderAdapter = {
      id: "claude",
      buildLaunchSpec: (session) => ({ executable: "fake", args: [], cwd: session.cwd, env: {} }),
      buildResumeSpec: (session) => ({ executable: "fake", args: [], cwd: session.cwd, env: {} }),
      prepareLaunch: async () => undefined,
      cleanupLaunch: async () => { throw new Error("artifact directory is busy"); },
    };
    const registry = new SessionRegistry({
      adapters: { claude: adapter },
      ptyFactory: () => {
        const pty = new FakePty(4000 + ptys.length);
        ptys.push(pty);
        return pty;
      },
      journal: { append: async () => {} },
      transcripts: { append: async (event: AppendThreadEvent) => {
        transcripts.push(event);
        return {} as never;
      } } as never,
      validateCwd: async () => undefined,
      config: BrokerRuntimeConfigSchema.parse({}),
    });

    const record = await registry.start(claudeRequest());
    ptys[0]!.emitExit(0);
    await until(
      () => transcripts.some((event) => event.text === "provider launch artifact cleanup failed"),
      "the cleanup failure to be recorded",
    );

    expect(registry.get(record.id)).toMatchObject({ executionState: "exited", exitCode: 0 });
    expect(transcripts.find((event) => event.text === "provider launch artifact cleanup failed"))
      .toMatchObject({
        sessionId: record.id,
        kind: "lifecycle",
        data: { reason: "session-exited", message: "artifact directory is busy" },
      });
  });
});

describe("SessionRegistry resolved launch records", () => {
  function secretHarness() {
    const puts: SessionRecord[] = [];
    const specs: ProviderLaunchSpec[] = [];
    const ptys: FakePty[] = [];
    const adapter: ProviderAdapter = {
      id: "claude",
      buildLaunchSpec: (session) => ({
        executable: "claude",
        args: ["--session-id", session.id, "--model", session.model ?? "opus"],
        cwd: session.cwd,
        env: { ...SENTINEL_SECRETS, PATH: "/usr/bin", CYBERDECK_PROCESS_ROLE: "worker", DISABLE_UPDATES: "1" },
      }),
      buildResumeSpec: (session) => ({
        executable: "claude",
        args: ["--resume", session.id],
        cwd: session.cwd,
        env: { ...SENTINEL_SECRETS, CYBERDECK_PROCESS_ROLE: "worker" },
      }),
      prepareLaunch: vi.fn(async () => undefined),
    };
    const registry = new SessionRegistry({
      adapters: { claude: adapter },
      ptyFactory: (spec: ProviderLaunchSpec) => {
        specs.push(spec);
        const pty = new FakePty(5000 + ptys.length);
        ptys.push(pty);
        return pty;
      },
      journal: { append: async () => {} },
      store: { put: async (value) => { puts.push(value); }, delete: async () => {} },
      validateCwd: async () => undefined,
      config: BrokerRuntimeConfigSchema.parse({}),
    });
    return { registry, adapter, puts, specs, ptys };
  }

  it("captures the executable, argv, and cwd the PTY was actually spawned with", async () => {
    const { registry, specs } = secretHarness();
    const record = await registry.start(claudeRequest());

    expect(registry.launchRecord(record.id)).toMatchObject({
      mode: "launch",
      executable: specs[0]!.executable,
      args: specs[0]!.args,
      cwd: specs[0]!.cwd,
      truncated: false,
    });
  });

  it("never exposes an inherited environment value through the record", async () => {
    const { registry } = secretHarness();
    const record = await registry.start(claudeRequest());
    const serialized = JSON.stringify({
      launchRecord: registry.launchRecord(record.id),
      session: registry.get(record.id),
      list: registry.list(),
    });

    for (const [key, value] of Object.entries(SENTINEL_SECRETS)) {
      expect(serialized).not.toContain(value);
      expect(serialized).not.toContain(key);
    }
    expect(registry.launchRecord(record.id)).toMatchObject({
      cyberdeckEnv: { CYBERDECK_PROCESS_ROLE: "worker", DISABLE_UPDATES: "1" },
      inheritedEnvCount: 3,
    });
  });

  it("replaces the launch record with the resume it actually performed", async () => {
    const { registry, ptys, specs } = secretHarness();
    const record = await registry.start(claudeRequest());
    ptys[0]!.emitExit(0);
    await until(() => registry.get(record.id).executionState === "exited", "the session to exit");

    await registry.resume(record.id);

    expect(registry.launchRecord(record.id)).toMatchObject({
      mode: "resume",
      args: specs[1]!.args,
      cwd: specs[1]!.cwd,
    });
  });

  it("persists the record so inspection survives a broker restart", async () => {
    const { registry, puts } = secretHarness();
    const record = await registry.start(claudeRequest());
    const persisted = puts.filter((value) => value.id === record.id).at(-1);

    expect(persisted?.launchRecord).toMatchObject({ mode: "launch", executable: "claude" });
    expect(JSON.stringify(persisted)).not.toContain("SENTINEL");
  });

  it("reads without writing or rebuilding a provider spec", async () => {
    const { registry, adapter, puts } = secretHarness();
    const record = await registry.start(claudeRequest());
    const writesBefore = puts.length;
    const preflights = (adapter.prepareLaunch as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(registry.launchRecord(record.id)).toBeDefined();
    expect(registry.launchRecord(record.id)).toBeDefined();

    expect(puts).toHaveLength(writesBefore);
    expect((adapter.prepareLaunch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(preflights);
  });

  it("hands back a copy so a caller cannot mutate broker state", async () => {
    const { registry } = secretHarness();
    const record = await registry.start(claudeRequest());
    const first = registry.launchRecord(record.id)!;
    first.args.push("--injected");

    expect(registry.launchRecord(record.id)?.args).not.toContain("--injected");
  });

  it("refuses to answer for a session the broker does not hold", () => {
    const { registry } = secretHarness();
    expect(() => registry.launchRecord("22222222-2222-4222-8222-222222222222"))
      .toThrow(expect.objectContaining({ code: "SESSION_NOT_FOUND" }));
  });

  it("captures a record for any registered provider, not only Claude and Codex", async () => {
    const specs: ProviderLaunchSpec[] = [];
    const adapter: ProviderAdapter = {
      id: "cursor",
      buildLaunchSpec: (session) => ({
        executable: "cursor-agent",
        args: ["--cwd", session.cwd],
        cwd: session.cwd,
        env: { ...SENTINEL_SECRETS },
      }),
      buildResumeSpec: (session) => ({
        executable: "cursor-agent",
        args: ["resume"],
        cwd: session.cwd,
        env: {},
      }),
    };
    const registry = new SessionRegistry({
      adapters: { cursor: adapter },
      ptyFactory: (spec: ProviderLaunchSpec) => {
        specs.push(spec);
        return new FakePty(6000);
      },
      journal: { append: async () => {} },
      validateCwd: async () => undefined,
      config: BrokerRuntimeConfigSchema.parse({}),
    });

    const record = await registry.start(claudeRequest({ provider: "cursor" }));

    expect(registry.launchRecord(record.id)).toMatchObject({
      mode: "launch",
      executable: "cursor-agent",
      args: specs[0]!.args,
      cyberdeckEnv: {},
      inheritedEnvCount: 2,
    });
  });
});
