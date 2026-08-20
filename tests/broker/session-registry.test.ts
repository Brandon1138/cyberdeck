import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { BrokerEvent } from "../../src/domain/events.js";
import type { SessionRecord, StartSessionRequest } from "../../src/domain/session.js";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import type {
  WorkerWorkspace,
  WorktreeProvisionRequest,
  WorktreeProvisioner,
} from "../../src/domain/worker-workspace.js";
import { GitWorktreeProvisioner } from "../../src/orchestration/git-worktree-provisioner.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude.js";
import type {
  ProviderAdapter,
  ProviderLaunchSpec,
  ProviderSessionTerminal,
} from "../../src/providers/provider.js";
import type { InstructionStateUpdate } from "../../src/broker/session-registry.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import type {
  WorkerTurnObservation,
  WorkerTurnTranscript,
} from "../../src/orchestration/session/worker-turn-ports.js";
import {
  ThreadTranscriptStore,
  type AppendThreadEvent,
} from "../../src/persistence/thread-transcript-store.js";

class FakePty implements SessionRuntime {
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

  /** How many times the registry asked for the whole replay buffer. See the MIK-87 ingest test. */
  snapshotCount = 0;

  write(data: Buffer): void { this.writes.push(Buffer.from(data)); }
  resize(): void {}
  snapshot(): Buffer {
    this.snapshotCount += 1;
    return Buffer.from(this.replay);
  }
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
  worktreeProvisioner?: WorktreeProvisioner;
  failJournal?: (event: BrokerEvent) => boolean;
  /** Provider-native turns a side-effect-free observation can find. */
  providerTurns?: readonly { id: string; text: string }[];
  /** Held open after side-effect-free observation, before the engine can enqueue its commit. */
  onProviderTurnsRead?: () => Promise<void>;
  /** Held inside the serialized durable commit after the engine has reserved its ordinals. */
  onProviderTurnsCommit?: () => Promise<void>;
  /** Real persistence boundary for end-to-end ordinal/transcript integration cases. */
  transcriptStore?: ThreadTranscriptStore;
} = {}) {
  const ptys: FakePty[] = [];
  const events: BrokerEvent[] = [];
  const transcripts: AppendThreadEvent[] = [];
  const captured = new Set<string>();
  const captureCalls: string[] = [];
  const commitCalls: WorkerTurnObservation[] = [];
  const observeProviderTurns = async (input: {
    sessionId: string;
    provider: string;
    turnNumber: number;
    fallbackText?: string;
    allowFallback?: boolean;
  }): Promise<WorkerTurnObservation> => {
    const pending = (options.providerTurns ?? []).filter((turn) => !captured.has(turn.id));
    captureCalls.push(input.allowFallback === true ? "fallback-allowed" : "native-only");
    await options.onProviderTurnsRead?.();
    const observed = pending.length > 0
      ? pending.map((turn) => ({
          providerTurnId: turn.id,
          providerOccurredAt: "2026-08-20T09:00:00.000Z",
          text: turn.text,
          transport: "provider-native" as const,
        }))
      : input.allowFallback === true
        ? [{
            providerTurnId: `fallback:${input.turnNumber}`,
            providerOccurredAt: "2026-08-20T09:00:00.000Z",
            text: input.fallbackText ?? "",
            transport: "terminal-replay-fallback" as const,
          }]
        : [];
    return {
      sessionId: input.sessionId,
      provider: input.provider,
      turnNumber: input.turnNumber,
      turns: observed,
    };
  };
  let commitTail = Promise.resolve();
  const commitProviderTurns = (observation: WorkerTurnObservation): Promise<WorkerTurnTranscript[]> => {
    commitCalls.push(observation);
    const committed = commitTail.then(async () => {
      await options.onProviderTurnsCommit?.();
      const turns: WorkerTurnTranscript[] = [];
      for (const turn of observation.turns) {
        if (captured.has(turn.providerTurnId)) continue;
        captured.add(turn.providerTurnId);
        turns.push({
          text: turn.text,
          data: { ...(turn.data ?? {}), transport: turn.transport },
        });
      }
      return turns;
    });
    commitTail = committed.then(() => undefined, () => undefined);
    return committed;
  };
  const ptyFactory = vi.fn((_spec: ProviderLaunchSpec) => {
    const pty = new FakePty(1000 + ptys.length, options.exitOnKill ?? true);
    ptys.push(pty);
    return pty;
  });
  const transcriptPort = options.transcriptStore ?? {
    append: async (event: AppendThreadEvent) => {
      transcripts.push(event);
      return {} as never;
    },
    // Only supplied when a test says what the provider transcript holds. A registry with no
    // capture at all is the shape every other test in this file runs under.
    ...(options.providerTurns === undefined
      ? {}
      : { observeProviderTurns, commitProviderTurns }),
  };
  const registry = new SessionRegistry({
    workerTurnObservation: new WorkerTurnObservationAdapter(),
    adapters: options.adapters ?? adapters,
    sessionRuntimeFactory: ptyFactory,
    journal: { append: async (event) => {
      if (options.failAttachJournal === true && event.type === "session.attached") {
        throw new Error("journal unavailable");
      }
      if (options.failJournal?.(event) === true) throw new Error("journal unavailable");
      events.push(event);
    } },
    transcripts: transcriptPort as never,
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
    ...(options.worktreeProvisioner === undefined
      ? {}
      : { worktreeProvisioner: options.worktreeProvisioner }),
  });
  return { registry, ptys, events, transcripts, ptyFactory, captureCalls, commitCalls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

/** A provisioner that records what it was asked to do and touches no disk. */
function fakeProvisioner(overrides: { failWith?: Error } = {}) {
  const provisioned: WorktreeProvisionRequest[] = [];
  const discarded: WorkerWorkspace[] = [];
  const provisioner: WorktreeProvisioner = {
    provision: async (provisionRequest) => {
      provisioned.push(provisionRequest);
      if (overrides.failWith !== undefined) throw overrides.failWith;
      return {
        workspace: {
          ...provisionRequest.workspace,
          worktreePath: "/tmp/repo-mik-75",
          repositoryPath: "/tmp/repo",
        },
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
        warnings: ["/tmp/repo-mik-75 has no node_modules"],
      };
    },
    discard: async (workspace) => { discarded.push(workspace); },
  };
  return { provisioner, provisioned, discarded };
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

/** A throwaway repository with one commit, for the provisioning paths that have no useful fake. */
async function gitRepository(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "cyberdeck-registry-worktree-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "project");
  await mkdir(root, { recursive: true });
  await gitOutput(root, ["init", "--initial-branch", "main"]);
  await gitOutput(root, ["config", "user.email", "test@example.com"]);
  await gitOutput(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "base\n", "utf8");
  await gitOutput(root, ["add", "."]);
  await gitOutput(root, ["commit", "-m", "base"]);
  // The system temp directory is a symlink on macOS and git answers in real paths.
  return realpath(root);
}

const cyberdeckProvisioned: WorkerWorkspace = {
  branch: "cyberdeck/mik-75",
  baseRef: "HEAD",
  provisioning: "cyberdeck-provisioned",
  writableRoots: [],
};

describe("SessionRegistry worktree provisioning", () => {
  it("cuts the worktree before the provider starts and runs the session in it", async () => {
    const { provisioner, provisioned } = fakeProvisioner();
    const { registry, events, ptyFactory } = harness({ worktreeProvisioner: provisioner });

    const record = await registry.start(request({ workspace: cyberdeckProvisioned }));

    expect(record.cwd).toBe("/tmp/repo-mik-75");
    expect(record.workspace?.worktreePath).toBe("/tmp/repo-mik-75");
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]?.sessionId).toBe(record.id);
    expect(ptyFactory.mock.calls[0]?.[0]?.cwd).toBe("/tmp/repo-mik-75");
    expect(events.filter((event) => event.type === "workspace.provisioned"))
      .toEqual([expect.objectContaining({
        sessionId: record.id,
        data: expect.objectContaining({
          worktreePath: "/tmp/repo-mik-75",
          branch: "cyberdeck/mik-75",
          warnings: ["/tmp/repo-mik-75 has no node_modules"],
        }),
      })]);
  });

  it("refuses the start when no provisioner is configured rather than sharing the checkout", async () => {
    const { registry } = harness();

    await expect(registry.start(request({ workspace: cyberdeckProvisioned })))
      .rejects.toMatchObject({ code: "WORKSPACE_PROVISIONER_UNAVAILABLE" });
  });

  it("reports a provisioning failure as a start failure", async () => {
    const { provisioner } = fakeProvisioner({ failWith: new Error("branch already exists") });
    const { registry } = harness({ worktreeProvisioner: provisioner });

    await expect(registry.start(request({ workspace: cyberdeckProvisioned })))
      .rejects.toMatchObject({ code: "WORKSPACE_PROVISION_FAILED" });
  });

  it("provisions nothing for a pre-provisioned workspace", async () => {
    const { provisioner, provisioned } = fakeProvisioner();
    const { registry } = harness({ worktreeProvisioner: provisioner });

    const record = await registry.start(request({
      workspace: {
        worktreePath: "/tmp/repo",
        branch: "brandon/mik-70",
        baseRef: "main",
        provisioning: "pre-provisioned",
        writableRoots: [],
      },
    }));

    expect(provisioned).toEqual([]);
    expect(record.cwd).toBe("/tmp/repo");
  });

  it("discards the worktree it just cut when the launch fails", async () => {
    const { provisioner, discarded } = fakeProvisioner();
    const { registry } = harness({
      worktreeProvisioner: provisioner,
      adapters: {
        codex: {
          ...adapters.codex,
          buildLaunchSpec: () => { throw new Error("provider missing"); },
        } as ProviderAdapter,
      },
    });

    await expect(registry.start(request({ workspace: cyberdeckProvisioned }))).rejects.toThrow();

    expect(discarded).toEqual([expect.objectContaining({ worktreePath: "/tmp/repo-mik-75" })]);
  });

  it("gives the worktree back when the journal rejects, leaving the branch free to retry", async () => {
    // A real provisioner and a real repository, because the failure being tested is the state left
    // on disk: a start that throws after `git worktree add` and before the caller can see the
    // result would leave a branch and a directory whose deterministic names then refuse the retry.
    const root = await gitRepository();
    let journalWorks = false;
    const provisioner = new GitWorktreeProvisioner();
    const { registry } = harness({
      worktreeProvisioner: provisioner,
      failJournal: (event) => event.type === "workspace.provisioned" && !journalWorks,
    });
    const start = () => registry.start(request({
      cwd: root,
      workspace: { ...cyberdeckProvisioned, branch: "cyberdeck/journal-gap" },
    }));

    await expect(start()).rejects.toMatchObject({ code: "WORKSPACE_PROVISION_FAILED" });

    expect(await gitOutput(root, ["branch", "--list", "cyberdeck/journal-gap"])).toBe("");
    expect(existsSync(join(root, "..", "project-journal-gap"))).toBe(false);

    journalWorks = true;
    const record = await start();
    expect(record.workspace?.worktreePath).toBe(join(root, "..", "project-journal-gap"));
  });
});

describe("SessionRegistry", () => {
  it("requires the worker-turn observation boundary before recovery can start", () => {
    const recovered: SessionRecord = {
      id: "44444444-4444-4444-8444-444444444444",
      provider: "codex",
      cwd: "/tmp/repo",
      detached: true,
      sandbox: "read-only",
      createdAt: "2026-08-20T09:00:00.000Z",
      updatedAt: "2026-08-20T09:01:00.000Z",
      executionState: "active",
      attachmentState: "detached",
      pid: 4242,
      exitCode: null,
      childIds: [],
      attentionState: "working",
    };
    const put = vi.fn(async () => undefined);
    const sessionRuntimeFactory = vi.fn(() => new FakePty(1000));

    expect(() => new SessionRegistry({
      workerTurnObservation: undefined as never,
      adapters,
      recoveredSessions: [recovered],
      store: { put, delete: async () => undefined },
      sessionRuntimeFactory,
      journal: { append: async () => undefined },
      config: BrokerRuntimeConfigSchema.parse({}),
    })).toThrow(new TypeError("SessionRegistry requires workerTurnObservation"));
    expect(put).not.toHaveBeenCalled();
    expect(sessionRuntimeFactory).not.toHaveBeenCalled();
  });

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
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters,
      recoveredSessions: [persisted],
      store: {
        put: async (value) => { puts.push(value); },
        delete: async () => {},
      },
      sessionRuntimeFactory: vi.fn(() => {
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

  it("resumes a durable read-only Claude session without widening it to automatic mode", async () => {
    const persisted: SessionRecord = {
      id: "22222222-2222-4222-8222-222222222222",
      provider: "claude",
      model: "opus",
      approvalMode: "auto",
      cwd: "/tmp/repo",
      detached: true,
      sandbox: "read-only",
      kind: "orchestrator",
      role: "orchestrator",
      name: "Claude Orc",
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:01:00.000Z",
      executionState: "active",
      attachmentState: "detached",
      pid: 4321,
      exitCode: null,
      childIds: [],
    };
    const ptyFactory = vi.fn((_spec: ProviderLaunchSpec) => new FakePty(9002));
    const registry = new SessionRegistry({
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters: { claude: new ClaudeProviderAdapter() },
      recoveredSessions: [persisted],
      store: {
        put: async () => {},
        delete: async () => {},
      },
      sessionRuntimeFactory: ptyFactory,
      journal: { append: async () => {} },
      validateCwd: async () => undefined,
      config: BrokerRuntimeConfigSchema.parse({}),
    });

    await registry.ready();
    await registry.resume(persisted.id);

    expect(registry.get(persisted.id)).toMatchObject({
      approvalMode: "auto",
      executionState: "active",
    });
    expect(ptyFactory.mock.calls[0]?.[0]).toMatchObject({
      // `approvalMode: "auto"` answers the approval question, not the write question. Resuming a
      // read-only session into `--permission-mode auto` would grant on resume what the stored
      // request refused at launch.
      args: expect.arrayContaining(["--resume", persisted.id, "--permission-mode", "plan"]),
    });
    expect(ptyFactory.mock.calls[0]?.[0]?.args).not.toContain("auto");
    expect(registry.launchRecord(persisted.id)).toMatchObject({
      mode: "resume",
      args: expect.arrayContaining(["--permission-mode", "plan"]),
    });
  });

  it("runs provider preflight after command validation and before PTY spawn", async () => {
    const prepareLaunch = vi.fn(async () => undefined);
    const ptyFactory = vi.fn((_spec: ProviderLaunchSpec) => new FakePty(1000));
    const registry = new SessionRegistry({
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters: { codex: { ...adapters.codex, prepareLaunch } },
      sessionRuntimeFactory: ptyFactory,
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

  // A provider with no system-prompt flag submits its instructions as the first message, so that
  // turn — and any broker call it makes — happens inside `start`. Whatever the caller has to make
  // durable first gets its chance before the provider is spoken to at all.
  it("runs the caller's activation before the provider's first turn", async () => {
    const order: string[] = [];
    const cursor: ProviderAdapter = {
      id: "cursor",
      buildLaunchSpec: (session) => ({
        executable: "fake",
        args: [],
        cwd: session.cwd,
        env: {},
      }),
      deferInitialPrompt: () => true,
      initializeSession: async () => { order.push("instructions"); },
      submitInputToTerminal: async () => { order.push("prompt"); },
      buildResumeSpec: () => {
        throw new Error("not used");
      },
    };
    const { registry } = harness({ adapters: { ...adapters, cursor } });
    const activated: SessionRecord[] = [];

    const record = await registry.start(
      request({ provider: "cursor", model: "composer", approvalMode: "auto" }),
      "Open the pull request",
      async (started) => {
        order.push("activate");
        activated.push(started);
      },
    );

    expect(order).toEqual(["activate", "instructions", "prompt"]);
    expect(activated).toEqual([expect.objectContaining({ id: record.id, pid: record.pid })]);
  });

  it("leaves no live session behind when activation fails", async () => {
    const initializeSession = vi.fn(async () => undefined);
    const cursor: ProviderAdapter = {
      id: "cursor",
      buildLaunchSpec: (session) => ({
        executable: "fake",
        args: [],
        cwd: session.cwd,
        env: {},
      }),
      deferInitialPrompt: () => true,
      initializeSession,
      buildResumeSpec: () => {
        throw new Error("not used");
      },
    };
    const { registry, ptys, events } = harness({ adapters: { ...adapters, cursor } });

    await expect(registry.start(
      request({ provider: "cursor", model: "composer", approvalMode: "auto" }),
      "Open the pull request",
      async () => {
        throw Object.assign(new Error("binding store unavailable"), { code: "STORE_UNAVAILABLE" });
      },
    )).rejects.toMatchObject({
      code: "STORE_UNAVAILABLE",
      message: "binding store unavailable",
    });
    expect(initializeSession).not.toHaveBeenCalled();
    expect(ptys[0]!.killCount).toBe(1);
    expect(registry.list()).toEqual([]);
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.created" }),
    ]));
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
        // No provider transcript behind this one, and the snapshot says so rather than
        // letting a screen scrape pass for a canonical turn.
        provenance: "terminal-replay",
        truth: expect.objectContaining({ state: "idle", completedTurns: 1, canonicalTurns: 0 }),
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

  it("projects the model a Claude session switched to mid-session onto its record", async () => {
    // MIK-80: launched on Sonnet, switched to Opus inside the provider's CLI. The switch becomes a
    // fact when the first turn the new model produced is written, so that is when it is read.
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-observed-model-"));
    const claudeProjects = join(root, "claude-projects");
    const project = join(claudeProjects, "-tmp-repo");
    const transcripts = new ThreadTranscriptStore(join(root, "state"), {
      claudeProjectsDirectory: claudeProjects,
    });
    const ptys: FakePty[] = [];
    const registry = new SessionRegistry({
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters,
      sessionRuntimeFactory: () => {
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
      request({ provider: "claude", model: "sonnet", effort: "low" }),
      "Inspect the failing test",
    );
    expect(registry.get(record.id).observedModel).toBeUndefined();

    await mkdir(project, { recursive: true });
    await writeFile(join(project, `${record.id}.jsonl`), [
      JSON.stringify({
        type: "assistant",
        uuid: "20000000-0000-4000-8000-000000000001",
        timestamp: "2026-07-25T10:00:04.000Z",
        effort: "high",
        message: {
          id: "msg_after_switch",
          role: "assistant",
          model: "claude-opus-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Answered on the new model." }],
        },
      }),
      "",
    ].join("\n"));

    const wait = registry.waitForWorkerResults(
      [{ sessionId: record.id, completionTarget: 1 }],
      5_000,
      4_000,
    );
    ptys[0]!.emitOutput("\u001b]0;⠹ worker\u0007Working\nesc to interrupt");
    ptys[0]!.emitOutput("\n\u001b]0;worker\u0007");
    await expect(wait).resolves.toMatchObject({ timedOut: false });

    // The launch request is untouched — it still says what the session was started with.
    expect(registry.get(record.id)).toMatchObject({
      model: "sonnet",
      effort: "low",
      observedModel: {
        model: "claude-opus-5",
        effort: "high",
        observedAt: "2026-07-25T10:00:04.000Z",
      },
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
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters,
      sessionRuntimeFactory: () => {
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
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters,
      sessionRuntimeFactory: ptyFactory,
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

  // The composer refuses these first, but the broker is the boundary every caller crosses — an MCP
  // orchestrator can build a start request the composer never saw.
  it("refuses images for a provider whose CLI has no flag to carry them", async () => {
    const { registry } = harness();
    await expect(
      registry.start(request({ provider: "cursor", imageAttachments: ["/tmp/shot.png"] })),
    ).rejects.toMatchObject({
      code: "PROVIDER_NO_IMAGE_INPUT",
      message:
        "Cursor cannot be given an image: cursor-agent advertises no image flag and no path attachment",
    });
  });

  // Claude's images travel in the prompt text. Accepting a list here would persist an attachment no
  // launch argument ever made, so the caller is told where its paths already belong.
  it("refuses an attachment list for a provider that reads its images out of the prompt", async () => {
    const { registry } = harness();
    await expect(
      registry.start(request({ provider: "claude", imageAttachments: ["/tmp/a.png", "/tmp/b.png"] })),
    ).rejects.toMatchObject({
      code: "PROVIDER_NO_IMAGE_INPUT",
      message:
        "Claude takes 2 images as path in prompt; Claude opens the file, not as a launch attachment",
    });
  });

  it("carries the attachment paths into the record the adapter builds its launch from", async () => {
    const { registry } = harness();
    const record = await registry.start(
      request({ provider: "codex", imageAttachments: ["/tmp/shot.png"] }),
      "Why is this misaligned?",
    );
    expect(record.imageAttachments).toEqual(["/tmp/shot.png"]);
  });

  it("rejects a relative attachment path before any provider sees it", async () => {
    const { registry } = harness();
    await expect(registry.start(request({ imageAttachments: ["shot.png"] })))
      .rejects.toThrow(/image attachment must be an absolute path/u);
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
    const sessionUpdate = vi.fn();
    const unsubscribe = registry.onSessionUpdate(sessionUpdate);
    await registry.stop(record.id);
    await vi.waitFor(() => expect(sessionUpdate).toHaveBeenCalledWith(record.id));
    sessionUpdate.mockClear();

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
    expect(sessionUpdate).toHaveBeenCalledWith(record.id);
    unsubscribe();
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

  it("quiesces old native truth before resume exposes a reusable ordinal", async () => {
    const oldCaptureGate = deferred<void>();
    const oldCaptureStarted = deferred<void>();
    const oldCaptureReturned = deferred<void>();
    const resumeLaunchGate = deferred<void>();
    const resumeLaunchStarted = deferred<void>();
    const providerTurns = [{ id: "old-turn", text: "stale old-generation answer" }];
    const gatedCodex: ProviderAdapter = {
      ...adapters.codex,
      prepareLaunch: async (_record, spec) => {
        if (spec.args[0] !== "resume") return;
        resumeLaunchStarted.resolve();
        await resumeLaunchGate.promise;
      },
    };
    const { registry, ptys, captureCalls, commitCalls } = harness({
      adapters: { ...adapters, codex: gatedCodex },
      exitOnKill: false,
      providerTurns,
      onProviderTurnsRead: async () => {
        oldCaptureStarted.resolve();
        await oldCaptureGate.promise;
        oldCaptureReturned.resolve();
      },
    });
    const record = await registry.start(request({ name: "resume-capture-race" }));
    const instructionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const states: InstructionStateUpdate[] = [];
    registry.onInstructionState((update) => states.push(update));
    await expect(registry.submitInstruction(
      record.id,
      "old generation task",
      "orchestrator",
      {},
      instructionId,
    )).resolves.toMatchObject({ state: "rendered", expectedTurn: 1 });

    ptys[0]!.emitOutput(
      "\u001b]0;\u2839 resume-capture-race\u0007\u001b[2JWorking\r\nesc to interrupt",
    );
    ptys[0]!.emitOutput(
      "\u001b[2Jstale old-generation answer\r\n\u001b]0;resume-capture-race\u0007",
    );
    await oldCaptureStarted.promise;

    await registry.stop(record.id);
    expect(ptys[0]!.killSignals).toEqual(["SIGTERM"]);
    const resume = registry.resume(record.id);
    await flushMicrotasks();
    expect(ptys).toHaveLength(1);
    expect(commitCalls).toEqual([]);

    oldCaptureGate.resolve();
    await oldCaptureReturned.promise;
    await resumeLaunchStarted.promise;

    // The stale read itself did not commit. The resume barrier freshly observed and durably adopted
    // the old native ID before provider launch could advance the generation.
    expect(captureCalls).toEqual(["native-only", "native-only"]);
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0]).toMatchObject({
      turnNumber: 1,
      turns: [{ providerTurnId: "old-turn", text: "stale old-generation answer" }],
    });
    expect(registry.workerTruth(record.id)).toMatchObject({ completedTurns: 1, canonicalTurns: 1 });
    expect(registry.get(record.id)).toMatchObject({
      executionState: "cancelled",
      attentionState: "stopping",
    });
    expect(states.filter(({ state }) => state === "completed")).toEqual([]);

    resumeLaunchGate.resolve();
    const resumed = await resume;

    expect(resumed).toMatchObject({
      executionState: "active",
      generation: 2,
      pid: 1001,
    });
    expect(registry.workerTruth(record.id)).toMatchObject({ completedTurns: 1, canonicalTurns: 1 });
    expect(states.filter(({ state }) => state === "completed")).toEqual([]);

    const resumedInstructionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await expect(registry.submitInstruction(
      record.id,
      "new generation task",
      "orchestrator",
      {},
      resumedInstructionId,
    )).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });
    providerTurns.push({ id: "new-turn", text: "new generation answer" });

    ptys[1]!.emitOutput(
      "\u001b]0;\u2839 resume-capture-race\u0007\u001b[2JWorking\r\nesc to interrupt",
    );
    ptys[1]!.emitOutput(
      "\u001b[2Jnew generation answer\r\n\u001b]0;resume-capture-race\u0007",
    );
    const result = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 2 },
    ], 5_000, 300);

    expect(result).toMatchObject({
      timedOut: false,
      results: [{
        status: "completed",
        text: "new generation answer",
        provenance: "provider-transcript",
      }],
    });
    expect(commitCalls).toHaveLength(2);
    expect(commitCalls[1]).toMatchObject({
      turnNumber: 2,
      turns: [{ providerTurnId: "new-turn", text: "new generation answer" }],
    });
    expect(states).toContainEqual(expect.objectContaining({
      instructionId: resumedInstructionId,
      state: "completed",
      turn: 2,
    }));
    expect(states).not.toContainEqual(expect.objectContaining({
      instructionId,
      state: "completed",
    }));
  });

  it("commits a frozen Codex screen fallback before a fast stop and resume advances ordinals", async () => {
    const { registry, ptys, captureCalls, commitCalls, events } = harness({
      exitOnKill: false,
      providerTurns: [],
    });
    const record = await registry.start(request({ name: "fast-screen-resume" }));
    ptys[0]!.emitOutput(
      "\u001b]0;\u2839 fast-screen-resume\u0007\u001b[2JWorking\r\nesc to interrupt",
    );
    ptys[0]!.emitOutput(
      "\u001b[2Jexact frozen answer before resume\r\n\u001b]0;fast-screen-resume\u0007",
    );
    const frozenReplay = ptys[0]!.snapshot().toString("utf8");
    const expectedFallback = new WorkerTurnObservationAdapter().fallbackTerminal(frozenReplay);
    expect(captureCalls).toEqual([]);

    // Stop and process exit both beat the 200 ms screen bank. The exit boundary freezes the old raw
    // replay, and resume must durably account that proven screen before generation 2 can launch.
    await registry.stop(record.id);
    expect(ptys[0]!.killSignals).toEqual(["SIGTERM"]);
    ptys[0]!.emitExit(0);
    const resumed = await registry.resume(record.id);

    expect(resumed).toMatchObject({ executionState: "active", generation: 2, pid: 1001 });
    expect(captureCalls).toEqual([
      "native-only",
      "native-only",
      "native-only",
      "fallback-allowed",
    ]);
    expect(commitCalls).toEqual([expect.objectContaining({
      turnNumber: 1,
      turns: [expect.objectContaining({
        providerTurnId: "fallback:1",
        text: expectedFallback,
        transport: "terminal-replay-fallback",
      })],
    })]);
    expect(registry.workerTruth(record.id)).toMatchObject({
      completedTurns: 1,
      canonicalTurns: 0,
    });
    expect(events.filter(({ type }) => type === "session.turn_reconciled")).toEqual([]);

    await expect(registry.submitInstruction(
      record.id,
      "new generation task",
      "orchestrator",
      {},
      "fffffff0-ffff-4fff-8fff-fffffffffff0",
    )).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });
    expect(ptys[1]!.writes.at(-1)?.toString()).toBe("new generation task\n");
  });

  it("waits for a pending commit and drains deferred old high-water before resume", async () => {
    const commitGate = deferred<void>();
    const providerTurns = [{ id: "old-one", text: "old first answer" }];
    const { registry, ptys, commitCalls } = harness({
      exitOnKill: false,
      providerTurns,
      onProviderTurnsCommit: () => commitGate.promise,
    });
    const record = await registry.start(request({ name: "resume-commit-barrier" }));
    const oldFirstInstruction = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const oldSecondInstruction = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const states: InstructionStateUpdate[] = [];
    registry.onInstructionState((update) => states.push(update));

    await expect(registry.submitInstruction(
      record.id,
      "old first task",
      "orchestrator",
      {},
      oldFirstInstruction,
    )).resolves.toMatchObject({ state: "rendered", expectedTurn: 1 });
    ptys[0]!.emitOutput(
      "\u001b]0;\u2839 resume-commit-barrier\u0007\u001b[2JWorking\r\nesc to interrupt",
    );
    ptys[0]!.emitOutput(
      "\u001b[2Jold first answer\r\n\u001b]0;resume-commit-barrier\u0007",
    );
    await vi.waitFor(() => expect(commitCalls).toHaveLength(1));

    await expect(registry.submitInstruction(
      record.id,
      "old second task",
      "orchestrator",
      {},
      oldSecondInstruction,
    )).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });
    providerTurns.push({ id: "old-two", text: "old deferred second answer" });
    ptys[0]!.emitOutput(
      "\u001b]0;\u2839 resume-commit-barrier\u0007\u001b[2JWorking again\r\nesc to interrupt",
    );
    ptys[0]!.emitOutput(
      "\u001b[2Jold deferred second answer\r\n\u001b]0;resume-commit-barrier\u0007",
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(commitCalls).toHaveLength(1);

    await registry.stop(record.id);
    let resumeSettled = false;
    const resume = registry.resume(record.id).then((resumed) => {
      resumeSettled = true;
      return resumed;
    });
    await flushMicrotasks();
    expect(resumeSettled).toBe(false);
    expect(ptys).toHaveLength(1);

    commitGate.resolve();
    const resumed = await resume;

    expect(resumed).toMatchObject({ executionState: "active", generation: 2, pid: 1001 });
    expect(commitCalls).toHaveLength(2);
    expect(commitCalls.map((observation) => observation.turnNumber)).toEqual([1, 2]);
    expect(commitCalls[1]).toMatchObject({
      turns: [{ providerTurnId: "old-two", text: "old deferred second answer" }],
    });
    expect(registry.workerTruth(record.id)).toMatchObject({
      completedTurns: 2,
      canonicalTurns: 2,
      pendingInstructions: 0,
    });
    expect(states).toContainEqual(expect.objectContaining({
      instructionId: oldFirstInstruction,
      state: "undelivered",
    }));
    expect(states).toContainEqual(expect.objectContaining({
      instructionId: oldSecondInstruction,
      state: "undelivered",
    }));
    expect(states.filter(({ state }) => state === "completed")).toEqual([]);

    const resumedInstruction = "33333333-cccc-4ccc-8ccc-cccccccccccc";
    await expect(registry.submitInstruction(
      record.id,
      "new generation task",
      "orchestrator",
      {},
      resumedInstruction,
    )).resolves.toMatchObject({ state: "rendered", expectedTurn: 3 });

    // The replaced process may acknowledge its earlier SIGTERM after generation 2 is already live.
    ptys[0]!.emitExit(0);
    expect(registry.get(record.id)).toMatchObject({
      executionState: "active",
      generation: 2,
      pid: 1001,
    });
  });

  it("restores the outgoing handle when a pending durable commit rejects during resume", async () => {
    const commitGate = deferred<void>();
    const failure = new Error("durable transcript write failed after enqueue");
    const { registry, ptys, commitCalls } = harness({
      exitOnKill: false,
      providerTurns: [{ id: "indeterminate-old", text: "possibly durable old answer" }],
      onProviderTurnsCommit: () => commitGate.promise,
    });
    const record = await registry.start(request({ name: "resume-commit-rejection" }));
    await registry.submitInstruction(
      record.id,
      "old task",
      "orchestrator",
      {},
      "88888888-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    ptys[0]!.emitOutput(
      "\u001b]0;\u2839 resume-commit-rejection\u0007\u001b[2JWorking\r\nesc to interrupt",
    );
    ptys[0]!.emitOutput(
      "\u001b[2Jpossibly durable old answer\r\n\u001b]0;resume-commit-rejection\u0007",
    );
    await vi.waitFor(() => expect(commitCalls).toHaveLength(1));

    await registry.stop(record.id);
    const resume = registry.resume(record.id);
    await flushMicrotasks();
    expect(ptys).toHaveLength(1);

    commitGate.reject(failure);
    await expect(resume).rejects.toBe(failure);

    expect(ptys).toHaveLength(1);
    expect(registry.get(record.id)).toMatchObject({
      executionState: "cancelled",
      generation: 1,
      pid: 1000,
    });
    expect(registry.workerTruth(record.id)).toMatchObject({ completedTurns: 0 });
    registry.forceStop(record.id);
    expect(ptys[0]!.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("keeps real-store native transcript ordinals aligned across resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-resume-native-store-"));
    temporaryDirectories.push(root);
    const codexRoot = join(root, "codex-sessions");
    const day = join(codexRoot, "2026", "08", "20");
    await mkdir(day, { recursive: true });
    const rolloutPath = join(day, "rollout.jsonl");
    const store = new ThreadTranscriptStore(root, { codexSessionsDirectory: codexRoot });
    const { registry, ptys } = harness({ transcriptStore: store });
    const record = await registry.start(request({ name: "real-store-resume" }));
    const sessionMeta = JSON.stringify({
      type: "session_meta",
      timestamp: record.createdAt,
      payload: {
        id: "019f0000-0000-7000-8000-000000000101",
        timestamp: record.createdAt,
        cwd: record.cwd,
        originator: "codex-tui",
      },
    });
    const nativeTurn = (turnId: string, text: string) => JSON.stringify({
      type: "event_msg",
      timestamp: new Date(Date.parse(record.createdAt) + 1_000).toISOString(),
      payload: { type: "task_complete", turn_id: turnId, last_agent_message: text },
    });
    await writeFile(rolloutPath, [
      sessionMeta,
      nativeTurn("019f0000-0000-7000-8000-000000000102", "old native answer"),
      "",
    ].join("\n"));

    const oldInstruction = "44444444-dddd-4ddd-8ddd-dddddddddddd";
    await expect(registry.submitInstruction(
      record.id,
      "old native task",
      "orchestrator",
      {},
      oldInstruction,
    )).resolves.toMatchObject({ state: "rendered", expectedTurn: 1 });
    ptys[0]!.emitOutput(
      "\u001b]0;\u2839 real-store-resume\u0007\u001b[2JWorking\r\nesc to interrupt",
    );
    ptys[0]!.emitOutput(
      "\u001b[2Jold native answer\r\n\u001b]0;real-store-resume\u0007",
    );
    const oldResult = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000, 300);
    expect(oldResult).toMatchObject({
      timedOut: false,
      results: [{ status: "completed", text: "old native answer", retrieval: "fresh" }],
    });

    await registry.stop(record.id);
    const resumed = await registry.resume(record.id);
    expect(resumed).toMatchObject({ executionState: "active", generation: 2, pid: 1001 });

    const newInstruction = "55555555-eeee-4eee-8eee-eeeeeeeeeeee";
    await expect(registry.submitInstruction(
      record.id,
      "new native task",
      "orchestrator",
      {},
      newInstruction,
    )).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });
    await appendFile(
      rolloutPath,
      `${nativeTurn("019f0000-0000-7000-8000-000000000103", "new native answer")}\n`,
      "utf8",
    );
    ptys[1]!.emitOutput(
      "\u001b]0;\u2839 real-store-resume\u0007\u001b[2JWorking\r\nesc to interrupt",
    );
    ptys[1]!.emitOutput(
      "\u001b[2Jnew native answer\r\n\u001b]0;real-store-resume\u0007",
    );
    const newResult = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 2 },
    ], 5_000, 300);
    expect(newResult).toMatchObject({
      timedOut: false,
      results: [{
        status: "completed",
        text: "new native answer",
        provenance: "provider-transcript",
      }],
    });

    const semanticTurns = (await store.read(record.id)).events.filter(({ kind }) => kind === "turn");
    expect(semanticTurns).toMatchObject([
      {
        text: "old native answer",
        data: {
          semanticTurnId: "codex:019f0000-0000-7000-8000-000000000102",
          turnNumber: 1,
        },
      },
      {
        text: "new native answer",
        data: {
          semanticTurnId: "codex:019f0000-0000-7000-8000-000000000103",
          turnNumber: 2,
        },
      },
    ]);
    const replayedOld = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000, 300);
    expect(replayedOld.results[0]).toMatchObject({
      status: "completed",
      retrieval: "replay",
      text: "old native answer",
    });
    expect(registry.workerTruth(record.id)).toMatchObject({
      completedTurns: 2,
      canonicalTurns: 2,
      pendingInstructions: 0,
    });
  });

  it("keeps real-store Cursor fallback ordinals aligned across resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-resume-cursor-store-"));
    temporaryDirectories.push(root);
    const store = new ThreadTranscriptStore(root, {
      now: () => "2026-08-20T11:00:00.000Z",
    });
    const cursor: ProviderAdapter = {
      id: "cursor",
      buildLaunchSpec: (session) => ({
        executable: "fake",
        args: ["cursor"],
        cwd: session.cwd,
        env: {},
      }),
      buildResumeSpec: (session) => ({
        executable: "fake",
        args: ["resume", session.id],
        cwd: session.cwd,
        env: {},
      }),
    };
    const { registry, ptys } = harness({
      adapters: { ...adapters, cursor },
      transcriptStore: store,
    });
    const record = await registry.start(request({
      provider: "cursor",
      model: "composer",
      approvalMode: "auto",
      name: "cursor-store-resume",
    }));

    await expect(registry.submitInstruction(
      record.id,
      "old Cursor task",
      "orchestrator",
      {},
      "66666666-ffff-4fff-8fff-ffffffffffff",
    )).resolves.toMatchObject({ state: "rendered", expectedTurn: 1 });
    ptys[0]!.emitOutput("\u001b]0;Cursor Agent\u0007 Composing ctrl+c to stop");
    ptys[0]!.emitOutput(
      "\nold Cursor answer\n\u001b]777;notify;Cursor;Cursor is waiting for you\u0007",
    );
    const oldResult = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000, 300);
    expect(oldResult.results[0]).toMatchObject({
      status: "completed",
      provenance: "terminal-replay",
    });
    expect(oldResult.results[0]?.text).toContain("old Cursor answer");

    await registry.stop(record.id);
    await expect(registry.resume(record.id)).resolves.toMatchObject({
      executionState: "active",
      generation: 2,
      pid: 1001,
    });
    await expect(registry.submitInstruction(
      record.id,
      "new Cursor task",
      "orchestrator",
      {},
      "77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    )).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });
    ptys[1]!.emitOutput("\u001b]0;Cursor Agent\u0007 Composing ctrl+c to stop");
    ptys[1]!.emitOutput(
      "\nnew Cursor answer\n\u001b]777;notify;Cursor;Cursor is waiting for you\u0007",
    );
    const newResult = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 2 },
    ], 5_000, 300);
    expect(newResult.results[0]).toMatchObject({
      status: "completed",
      provenance: "terminal-replay",
    });
    expect(newResult.results[0]?.text).toContain("new Cursor answer");

    const semanticTurns = (await store.read(record.id)).events.filter(({ kind }) => kind === "turn");
    expect(semanticTurns).toMatchObject([
      { data: { semanticTurnId: "cursor:fallback:1", turnNumber: 1 } },
      { data: { semanticTurnId: "cursor:fallback:2", turnNumber: 2 } },
    ]);
    expect(semanticTurns[0]?.text).toContain("old Cursor answer");
    expect(semanticTurns[1]?.text).toContain("new Cursor answer");
    expect(registry.workerTruth(record.id)).toMatchObject({
      completedTurns: 2,
      canonicalTurns: 0,
      pendingInstructions: 0,
    });
  });

  it("publishes fatal truth before attached callbacks observe the failure", async () => {
    const { registry, ptys, events, transcripts } = harness();
    const record = await registry.start(request());
    const observations: Array<{
      callback: "output" | "failed";
      attention: SessionRecord["attentionState"];
      eventStarted: boolean;
      transcriptStarted: boolean;
    }> = [];
    const observe = (callback: "output" | "failed") => {
      observations.push({
        callback,
        attention: registry.get(record.id).attentionState,
        eventStarted: events.some((event) =>
          event.type === "session.errored" && event.sessionId === record.id),
        transcriptStarted: transcripts.some((event) =>
          event.kind === "lifecycle"
          && event.sessionId === record.id
          && event.text === "session errored"),
      });
    };
    await registry.attach(
      record.id,
      "human",
      "control",
      () => observe("output"),
      undefined,
      () => observe("failed"),
    );

    ptys[0]!.emitOutput("API Error: 401 authentication_error\n");

    expect(observations).toEqual([
      {
        callback: "output",
        attention: "failed",
        eventStarted: true,
        transcriptStarted: true,
      },
      {
        callback: "failed",
        attention: "failed",
        eventStarted: true,
        transcriptStarted: true,
      },
    ]);
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
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters,
      sessionRuntimeFactory: ptyFactory,
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
    // `rendered`, never `delivered`: the bytes are at the terminal and nothing has been observed
    // about the provider consuming them.
    await expect(registry.submitInstruction(record.id, "queued instruction"))
      .resolves.toMatchObject({ state: "rendered", expectedTurn: 1 });
    expect(ptys[0]!.writes.at(-1)?.toString()).toBe("queued instruction\n");
    expect(transcripts).toContainEqual(expect.objectContaining({
      kind: "instruction",
      source: "orchestrator",
      text: "queued instruction",
    }));
  });

  it("never settles a wait from a turn that completed before its own instruction", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request({ name: "stale-turn-worker" }), "First task");

    ptys[0]!.emitOutput("\u001b]0;\u2839 stale-turn-worker\u0007\u001b[2JWorking");
    ptys[0]!.emitOutput("\u001b[2Janswer to the first task\r\n\u001b]0;stale-turn-worker\u0007");
    const first = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000, 300);
    expect(first.results[0]).toMatchObject({ status: "completed", completedTurns: 1 });

    await registry.submitInstruction(record.id, "Second task");

    // Target 2 is what the second task will answer. It must not settle from turn 1, which finished
    // before the instruction existed, so this wait runs out its own deadline instead.
    const stale = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 2 },
    ], 50, 300);
    expect(stale).toMatchObject({
      timedOut: true,
      results: [{ status: "waiting", completedTurns: 1 }],
    });

    // Re-asking for a target already handed back is a replay, not a stale settle, and stays legal:
    // it is how an orchestrator proves work already ran without starting a duplicate worker.
    const replay = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 50, 300);
    expect(replay.results[0]).toMatchObject({ status: "completed", retrieval: "replay" });

    ptys[0]!.emitOutput("\u001b]0;\u2839 stale-turn-worker\u0007\u001b[2JWorking");
    ptys[0]!.emitOutput("\u001b[2Janswer to the second task\r\n\u001b]0;stale-turn-worker\u0007");
    const second = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 2 },
    ], 5_000, 300);
    expect(second.results[0]).toMatchObject({ status: "completed", completedTurns: 2 });
    expect(second.results[0]!.text).toContain("second task");
  });

  it("holds an instruction at a permission modal and submits it at the next safe boundary", async () => {
    // The MIK-64 sequence end to end: modal up, follow-up instruction arrives, the instruction is
    // never written into the composer, the modal clears, the instruction goes in, the provider takes
    // it, and exactly one canonical completion answers it.
    const instructionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { registry, ptys } = harness();
    const record = await registry.start(
      request({ provider: "claude", model: "opus", name: "modal-worker" }),
      "Run the checks",
    );
    const states: InstructionStateUpdate[] = [];
    const boundaries: string[] = [];
    registry.onInstructionState((update) => states.push(update));
    registry.onDeliveryBoundary((sessionId) => boundaries.push(sessionId));

    ptys[0]!.emitOutput([
      "Claude needs your permission to use Bash",
      "  pnpm test",
      "Do you want to proceed?",
      "\u276f 1. Yes",
      "  3. No",
    ].join("\r\n"));
    await vi.waitFor(() => expect(registry.get(record.id).attentionState).toBe("needs-input"));

    const held = await registry.submitInstruction(
      record.id, "Then run the linter", "orchestrator", {}, instructionId,
    );
    expect(held).toMatchObject({ state: "queued", hold: "provider-modal" });
    expect(ptys[0]!.writes).toEqual([]);
    expect(registry.workerTruth(record.id)).toMatchObject({ state: "blocked-modal", terminal: false });

    // The operator answers the prompt and the worker resumes the tool call it was asking about.
    // That turn is still the *first task's*, so the instruction stays held rather than borrowing it.
    ptys[0]!.emitOutput("\u001b]0;\u2839 modal-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    await vi.waitFor(() => expect(registry.workerTruth(record.id).state).toBe("working"));
    await expect(registry.submitInstruction(
      record.id, "Then run the linter", "orchestrator", {}, instructionId,
    )).resolves.toMatchObject({ state: "queued", hold: "provider-busy" });
    expect(ptys[0]!.writes).toEqual([]);

    // The first task's turn lands in the ledger. Now the composer is free and the next ordinal is
    // one nothing else has a claim on.
    ptys[0]!.emitOutput("\u001b[2Jchecks passed\r\n\u001b]0;modal-worker\u0007");
    await vi.waitFor(() => expect(boundaries).toContain(record.id));

    const rendered = await registry.submitInstruction(
      record.id, "Then run the linter", "orchestrator", {}, instructionId,
    );
    expect(rendered).toMatchObject({ state: "rendered", expectedTurn: 2 });
    expect(ptys[0]!.writes.at(-1)?.toString()).toBe("Then run the linter\n");

    // The provider consumes the composer and starts a turn. Only this is submission.
    ptys[0]!.emitOutput("\u001b]0;\u2839 modal-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    await vi.waitFor(() =>
      expect(states.map(({ state }) => state)).toEqual(["submitted", "acknowledged"]));

    ptys[0]!.emitOutput("\u001b[2Jlinter clean\r\n\u001b]0;modal-worker\u0007");
    const settled = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 2 },
    ], 5_000, 300);
    expect(settled.results[0]).toMatchObject({
      status: "completed",
      completedTurns: 2,
      retrieval: "fresh",
    });
    expect(settled.results[0]!.text).toContain("linter clean");
    expect(states.filter(({ state }) => state === "completed")).toEqual([
      { sessionId: record.id, instructionId, state: "completed", at: expect.any(String), turn: 2 },
    ]);
  });

  it("records a finished turn from the provider transcript while a dialog is parked on top", async () => {
    // MIK-89. The worker finished, pushed its work, and then Claude painted its session-limit dialog
    // over the result. The screen never walks back to `awaiting-input` from there, so the only path
    // that banked a turn never ran: `completedTurns` stayed 0, `workers_wait` on target 1 could not
    // settle, and the row said "Working" about a worker that was done.
    const { registry, ptys, events } = harness({
      providerTurns: [{ id: "turn-1", text: "opened pull request #38" }],
    });
    const record = await registry.start(
      request({ provider: "claude", name: "reconcile-worker" }),
      "Land the fix",
    );

    ptys[0]!.emitOutput("\u001b]0;⠹ reconcile-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    await vi.waitFor(() => expect(registry.workerTruth(record.id).state).toBe("working"));

    ptys[0]!.emitOutput([
      "\u001b[2J╭────────────────╮",
      "│ You've hit your session limit · resets 10:10pm │",
      "│ ❯ Upgrade your plan                          │",
      "│ Enter to confirm · Esc to cancel              │",
      "╰────────────────╯",
    ].join("\r\n"));
    await vi.waitFor(() => expect(registry.workerTruth(record.id).state).toBe("blocked-modal"));

    // Once the screen goes quiet, the ledger is corrected against the transcript the provider wrote
    // when the turn ended — the record the screen path never got to see.
    await vi.waitFor(
      () => expect(events.filter(({ type }) => type === "session.turn_reconciled")).toHaveLength(1),
      { timeout: 8_000, interval: 50 },
    );

    // The wait is the point: a finished worker has to settle one as completed, dialog or no dialog.
    const settled = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 2_000, 100);
    expect(settled.timedOut).toBe(false);
    expect(settled.results[0]).toMatchObject({
      status: "completed",
      completedTurns: 1,
      provenance: "provider-transcript",
      text: "opened pull request #38",
    });
    // Completed and still blocked are both true. The turn is banked; the dialog still wants a key.
    expect(settled.results[0]!.truth).toMatchObject({ state: "blocked-modal", terminal: false });
    expect(registry.get(record.id).attentionState).toBe("needs-input");
    expect(events.filter(({ type }) => type === "session.turn_reconciled")).toHaveLength(1);
  });

  it("banks one turn when a prompt redraw interleaves with an in-flight reconcile", async () => {
    // The two banking paths read the same source, and that read *consumes*: `captureProviderTurns`
    // appends and deduplicates the provider's turn ids. So a provider that redraws its prompt while
    // a reconcile's read is in flight used to arm the 200 ms screen path against turns the reconcile
    // had already spent — the reconcile would discard its result on finding the ledger moved, and
    // the screen path would find an empty transcript and settle for a scrape. One turn, banked
    // twice or banked as a guess. Ownership is claimed before anything is read instead.
    const gate: { redraw?: () => Promise<void> } = {};
    const { registry, ptys, events, captureCalls } = harness({
      providerTurns: [{ id: "turn-1", text: "pushed the branch" }],
      onProviderTurnsRead: async () => {
        const redraw = gate.redraw;
        delete gate.redraw;
        await redraw?.();
      },
    });
    const record = await registry.start(
      request({ provider: "claude", name: "interleave-worker" }),
      "Land the fix",
    );

    ptys[0]!.emitOutput("\u001b]0;⠹ interleave-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    await vi.waitFor(() => expect(registry.workerTruth(record.id).state).toBe("working"));

    // The last spinner frame is never redrawn, so the screen keeps reading `working` and never arms
    // its own banking path. The reconcile is what notices, and it reaches the transcript first.
    gate.redraw = async () => {
      // The dialog is dismissed and the prompt comes back while the read is still in flight. That is
      // exactly the transition the screen path banks on, and its timer is shorter than this wait.
      ptys[0]!.emitOutput("\u001b[2Jpushed the branch\r\n\u001b]0;interleave-worker\u0007");
      await new Promise((resolve) => setTimeout(resolve, 600));
    };

    await vi.waitFor(
      () => expect(events.filter(({ type }) => type === "session.turn_reconciled")).toHaveLength(1),
      { timeout: 8_000, interval: 50 },
    );

    const settled = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 2_000, 100);
    expect(settled.timedOut).toBe(false);
    // One turn, and the provider's own record behind it — not a scrape recorded because the native
    // turns had already been consumed by the path that then threw them away.
    expect(settled.results[0]).toMatchObject({
      status: "completed",
      completedTurns: 1,
      provenance: "provider-transcript",
      text: "pushed the branch",
    });

    // And it stays one. A second bank would hand a waiter an ordinal no work stands behind.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(registry.workerTruth(record.id).completedTurns).toBe(1);
    expect(events.filter(({ type }) => type === "session.turn_reconciled")).toHaveLength(1);
    // The screen path stood down rather than starting a competing read of the same turn.
    expect(captureCalls).toEqual(["native-only"]);
  });

  it("does not bank a turn the provider transcript has nothing to say about", async () => {
    // The other half of the same rule. A worker sitting at a dialog that has *not* finished its turn
    // must stay uncompleted: `allowFallback: false` means a screen scrape can never stand in for the
    // turn, so there is nothing to count and the wait keeps waiting.
    const { registry, ptys, events } = harness({ providerTurns: [] });
    const record = await registry.start(
      request({ provider: "claude", name: "unfinished-worker" }),
      "Land the fix",
    );

    ptys[0]!.emitOutput("\u001b]0;⠹ unfinished-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    await vi.waitFor(() => expect(registry.workerTruth(record.id).state).toBe("working"));
    ptys[0]!.emitOutput("\u001b[2JAlso scan your other repos [ ]\r\n←/→ to change · Enter to confirm");
    await vi.waitFor(() => expect(registry.workerTruth(record.id).state).toBe("blocked-modal"));

    // Well past the quiet window the reconcile fires in, so its silence here is a decision and not
    // a race that had not run yet.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(events.filter(({ type }) => type === "session.turn_reconciled")).toEqual([]);

    // The dialog still settles the wait — it wants a keypress, and the caller has to hear that — but
    // it settles as the thing it is, with an empty ledger behind it.
    const settled = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 1_000, 100);
    expect(settled.results[0]).toMatchObject({ status: "needs-input", completedTurns: 0 });
  });

  it("holds an instruction at an onboarding dialog rather than writing into it", async () => {
    // MIK-88's delivery half. The onboarding wizard shares no wording with a permission prompt, so
    // nothing saw it: the enqueue came back `rendered` and the payload went into a surface that was
    // never going to submit it.
    const { registry, ptys } = harness();
    const record = await registry.start(
      request({ provider: "claude", name: "onboarding-worker" }),
      "Land the fix",
    );

    ptys[0]!.emitOutput([
      "\u001b[2JClaude Code can scan this repository for you",
      "❯ 1. Yes",
      "  2. Not now",
      "  3. Don't show again",
      "Enter to confirm",
    ].join("\r\n"));
    await vi.waitFor(() => expect(registry.get(record.id).attentionState).toBe("needs-input"));

    const held = await registry.submitInstruction(record.id, "Then run the linter");
    expect(held).toMatchObject({ state: "queued", hold: "provider-modal" });
    expect(ptys[0]!.writes).toEqual([]);
    expect(registry.workerTruth(record.id)).toMatchObject({ state: "blocked-modal", terminal: false });
  });

  it("never gives an instruction the ordinal of a turn that was already in flight", async () => {
    // The P1 the review caught: an instruction rendered mid-turn took `completedTurns + 1`, which is
    // the ordinal of the turn that started before it existed. That turn then completed it, and the
    // wait asking whether the instruction had run settled with the previous task's answer.
    const instructionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { registry, ptys } = harness();
    const record = await registry.start(
      request({ provider: "claude", name: "busy-worker" }),
      "First task",
    );
    const states: InstructionStateUpdate[] = [];
    registry.onInstructionState((update) => states.push(update));

    ptys[0]!.emitOutput("\u001b]0;\u2839 busy-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    await vi.waitFor(() => expect(registry.workerTruth(record.id).state).toBe("working"));

    await expect(registry.submitInstruction(
      record.id, "Then run the linter", "orchestrator", {}, instructionId,
    )).resolves.toMatchObject({ state: "queued", hold: "provider-busy" });
    expect(ptys[0]!.writes).toEqual([]);

    // The in-flight turn ends. It answered the first task, so it settles target 1 and nothing else.
    ptys[0]!.emitOutput("\u001b[2Jfirst task done\r\n\u001b]0;busy-worker\u0007");
    const first = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000, 300);
    expect(first.results[0]).toMatchObject({ status: "completed", completedTurns: 1 });
    expect(first.results[0]!.text).toContain("first task done");
    expect(states).toEqual([]);

    const rendered = await registry.submitInstruction(
      record.id, "Then run the linter", "orchestrator", {}, instructionId,
    );
    expect(rendered).toMatchObject({ state: "rendered", expectedTurn: 2 });

    ptys[0]!.emitOutput("\u001b]0;\u2839 busy-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    ptys[0]!.emitOutput("\u001b[2Jlinter clean\r\n\u001b]0;busy-worker\u0007");
    const second = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 2 },
    ], 5_000, 300);
    expect(second.results[0]).toMatchObject({ status: "completed", completedTurns: 2 });
    expect(second.results[0]!.text).toContain("linter clean");
    // One completion, and it is the instruction's own turn — not the one it was queued behind.
    expect(states.filter(({ state }) => state === "completed")).toEqual([
      { sessionId: record.id, instructionId, state: "completed", at: expect.any(String), turn: 2 },
    ]);
  });

  it("does not count an unsent composer buffer as a completed turn", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request({ provider: "claude", name: "composer-worker" }));

    ptys[0]!.emitOutput("\u001b]0;\u2839 composer-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    ptys[0]!.emitOutput([
      "\u001b[2Jpartial output",
      "\u2502 > queued follow-up \u2502",
      "tab to queue message",
      "\u001b]0;composer-worker\u0007",
    ].join("\r\n"));

    // Returning to the input surface with text still in it is not a finished turn. Counting it is
    // how an unsent instruction came to satisfy the very wait that was asking whether it had run.
    const waiting = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 400, 300);
    expect(waiting).toMatchObject({
      timedOut: true,
      results: [{
        status: "waiting",
        completedTurns: 0,
        truth: expect.objectContaining({ state: "blocked-composer", composerOccupied: true }),
      }],
    });

    ptys[0]!.emitOutput("\u001b]0;\u2839 composer-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    ptys[0]!.emitOutput("\u001b[2Jfollow-up answered\r\n\u001b]0;composer-worker\u0007");
    const settled = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000, 300);
    expect(settled.results[0]).toMatchObject({ status: "completed", completedTurns: 1 });
    expect(settled.results[0]!.text).toContain("follow-up answered");
  });

  it("keeps a provider limit terminal across a restart and drops it on resume", async () => {
    // The limit belongs to the account, not to the process that hit it, so it has to survive a
    // broker restart: recovery folds `errored` into `failed`, and reporting a capped worker as a
    // crashed one sends the operator to retry something that cannot run until the cap resets.
    const persisted: SessionRecord = {
      id: "33333333-3333-4333-8333-333333333333",
      provider: "claude",
      cwd: "/tmp/repo",
      detached: true,
      sandbox: "read-only",
      kind: "worker",
      name: "capped-worker",
      createdAt: "2026-08-14T10:00:00.000Z",
      updatedAt: "2026-08-14T10:01:00.000Z",
      executionState: "errored",
      attachmentState: "detached",
      pid: 4321,
      exitCode: null,
      childIds: [],
      attentionState: "failed",
      termination: {
        kind: "session-limit",
        reason: "provider usage limit reached",
        detail: "Usage limit reached \u00b7 resets 3:00pm",
        at: "2026-08-14T10:01:00.000Z",
      },
    };
    const registry = new SessionRegistry({
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters,
      recoveredSessions: [persisted],
      store: { put: async () => {}, delete: async () => {} },
      sessionRuntimeFactory: vi.fn(() => new FakePty(9100)),
      journal: { append: async () => {} },
      validateCwd: async () => undefined,
      config: BrokerRuntimeConfigSchema.parse({}),
    });
    await registry.ready();

    expect(registry.get(persisted.id)).toMatchObject({
      executionState: "failed",
      termination: { kind: "session-limit" },
    });
    expect(registry.workerTruth(persisted.id)).toMatchObject({
      state: "provider-limit",
      terminal: true,
      detail: "provider usage limit reached",
    });

    // A resume is a new generation with its own budget. Carrying the old cap forward would report a
    // live worker as terminal for the rest of its life.
    await registry.resume(persisted.id);
    expect(registry.get(persisted.id).termination).toBeUndefined();
    expect(registry.workerTruth(persisted.id)).toMatchObject({ state: "idle", terminal: false });
  });

  it("clears a provider limit observed in this process when the session is resumed", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request({ name: "capped-live" }), "Long task");

    ptys[0]!.emitOutput("Usage limit reached \u00b7 resets 3:00pm' + CRLF + '");
    await vi.waitFor(() =>
      expect(registry.workerTruth(record.id)).toMatchObject({ state: "provider-limit", terminal: true }));

    await registry.resume(record.id);
    expect(registry.workerTruth(record.id)).toMatchObject({ state: "idle", terminal: false });
    expect(registry.get(record.id).executionState).toBe("active");
    expect(registry.get(record.id).termination).toBeUndefined();
  });

  it("answers an instruction aimed at a dead worker as undelivered rather than queued", async () => {
    // `queued` promises a later boundary. A terminal worker has none, so the record would sit
    // accepted forever, deduplicating every retry of an instruction nothing will ever read.
    const { registry, ptys } = harness();
    const record = await registry.start(request({ name: "dead-worker" }), "Task");
    ptys[0]!.emitExit(1);
    await vi.waitFor(() => expect(registry.get(record.id).executionState).toBe("failed"));

    await expect(registry.submitInstruction(
      record.id, "Then run the linter", "orchestrator", {}, "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    )).resolves.toMatchObject({ state: "undelivered", hold: "worker-terminal" });
  });

  it("reports a provider-declared limit as its own terminal state", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request({ name: "capped-worker" }), "Long task");

    ptys[0]!.emitOutput("Usage limit reached \u00b7 resets 3:00pm\r\n");

    const result = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000, 300);
    expect(result).toMatchObject({
      timedOut: false,
      results: [{
        status: "provider-limit",
        providerLimit: { kind: "session-limit", reason: "provider usage limit reached" },
        truth: expect.objectContaining({ state: "provider-limit", terminal: true }),
      }],
    });
    // The process is still alive, which is why this cannot live in `executionState` alone.
    expect(registry.get(record.id)).toMatchObject({
      executionState: "errored",
      exitCode: null,
      termination: { kind: "session-limit", at: expect.any(String) },
    });
  });

  it("paginates an instruction through to its completion with no cursor gap", async () => {
    // A Claude worker whose native transcript never appears used to complete turns that
    // `thread_read` had no record of at all: the wait said completed, the transcript showed nothing
    // between the instruction and silence. The scrape is now written as an explicitly labelled turn.
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-thread-gap-"));
    const transcripts = new ThreadTranscriptStore(join(root, "state"), {
      claudeProjectsDirectory: join(root, "no-such-claude-projects"),
    });
    const ptys: FakePty[] = [];
    const registry = new SessionRegistry({
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters,
      sessionRuntimeFactory: () => {
        const pty = new FakePty(3000 + ptys.length);
        ptys.push(pty);
        return pty;
      },
      journal: { append: async () => {} },
      transcripts,
      validateCwd: async () => undefined,
      config: BrokerRuntimeConfigSchema.parse({}),
    });
    const instructionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const record = await registry.start(
      request({ provider: "claude", name: "gap-worker" }),
      "Initial task",
    );
    await registry.submitInstruction(
      record.id, "Run the suite", "orchestrator", {}, instructionId,
    );

    ptys[0]!.emitOutput("\u001b]0;\u2839 gap-worker\u0007\u001b[2JWorking\r\nesc to interrupt");
    ptys[0]!.emitOutput("\u001b[2Jsuite passed\r\n\u001b]0;gap-worker\u0007");
    const settled = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 5_000, 400);
    expect(settled.results[0]).toMatchObject({
      status: "completed",
      completedTurns: 1,
      // No provider transcript stood behind this turn, and the snapshot says so out loud.
      provenance: "terminal-replay",
      truth: expect.objectContaining({ completedTurns: 1, canonicalTurns: 0 }),
    });

    const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    let cursor = 0;
    for (;;) {
      const page = await transcripts.read(record.id, cursor, 1);
      if (page.events.length === 0) break;
      expect(page.nextCursor).toBeGreaterThan(cursor);
      cursor = page.nextCursor;
      events.push(page.events[0]!);
    }

    const instruction = events.findIndex(({ kind }) => kind === "instruction");
    const turn = events.findIndex(({ kind }) => kind === "turn");
    expect(instruction).toBeGreaterThanOrEqual(0);
    expect(turn).toBeGreaterThan(instruction);
    expect(events[instruction]!.data).toMatchObject({
      instructionId,
      instructionState: "rendered",
      expectedTurn: 1,
    });
    expect(events[turn]!.data).toMatchObject({
      semantic: true,
      transport: "terminal-replay-fallback",
      turnNumber: 1,
    });
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
    workerTurnObservation: new WorkerTurnObservationAdapter(),
    adapters: { claude: adapter },
    sessionRuntimeFactory: ptyFactory,
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
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters: { claude: adapter },
      sessionRuntimeFactory: () => {
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
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters: { claude: adapter },
      sessionRuntimeFactory: (spec: ProviderLaunchSpec) => {
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
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters: { cursor: adapter },
      sessionRuntimeFactory: (spec: ProviderLaunchSpec) => {
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

describe("SessionRegistry ingest cost", () => {
  it("reads no accumulated replay while a provider streams", async () => {
    const { registry, ptys } = harness();
    const record = await registry.start(request());
    const pty = ptys[0]!;
    const before = pty.snapshotCount;

    for (let index = 0; index < 500; index += 1) {
      pty.emitOutput(`\u001b[2K\r⠋ Working (esc to interrupt) · ${index} tokens · line ${index}\n`);
    }

    // Every reading the broadcast path makes is now folded from the chunk it was handed. Asking the
    // PTY for its whole buffer per chunk is what MIK-87 was: a copy and a decode of 128 KiB, then
    // half a dozen regex passes over it, per chunk, per session.
    expect(pty.snapshotCount - before).toBe(0);
    expect(registry.workerTruth(record.id).state).toBe("working");
  });

  it("keeps a wait over many workers from re-reading every worker on one worker's output", async () => {
    const { registry, ptys } = harness();
    const records = await Promise.all(
      Array.from({ length: 6 }, () => registry.start(request())),
    );
    const targets = records.map((record) => ({ sessionId: record.id, completionTarget: 1 }));
    const noisy = ptys[0]!;
    const quiet = ptys.slice(1);
    for (const pty of ptys) pty.emitOutput("\u001b[2J⠋ Working (esc to interrupt)\n");
    const counts = quiet.map((pty) => pty.snapshotCount);

    const waiting = registry.waitForWorkerResults(targets, 50);
    for (let index = 0; index < 200; index += 1) {
      noisy.emitOutput(`\u001b[2K\r⠋ Working (esc to interrupt) · ${index} tokens\n`);
    }
    await waiting;

    // A wait used to rebuild every target's snapshot on every update from any target, so one
    // streaming worker dragged all six replays through a full scan per chunk. Only the worker that
    // produced output is re-read, and the snapshots are built once, when the wait answers.
    quiet.forEach((pty, index) => {
      expect(pty.snapshotCount - counts[index]!).toBeLessThanOrEqual(1);
    });
  });
});
