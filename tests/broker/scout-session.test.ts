import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { SessionRecord, StartSessionRequest } from "../../src/domain/session.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import { MIN_SCOUT_REPLAY_BYTES } from "../../src/domain/worker-profile.js";
import type { WorktreeProvisioner } from "../../src/domain/worker-workspace.js";
import { ScoutReportStore } from "../../src/persistence/scout-report-store.js";
import type {
  ProviderAdapter,
  ProviderLaunchSpec,
} from "../../src/providers/provider.js";
import {
  SCOUT_CARD_BEGIN,
  SCOUT_CARD_END,
} from "../../src/domain/scout-output.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakePty implements SessionRuntime {
  readonly pid = 9001;
  readonly writes: Buffer[] = [];
  readonly kills: Array<string | undefined> = [];
  private replay = Buffer.alloc(0);
  private exited = false;
  private exitCode = 0;
  private readonly outputs = new Set<(chunk: Buffer) => void>();
  private readonly exits = new Set<(code: number, signal?: number) => void>();
  constructor(private readonly killExitCode = 0) {}

  write(data: Buffer): void { this.writes.push(Buffer.from(data)); }
  resize(): void {}
  snapshot(): Buffer { return Buffer.from(this.replay); }
  kill(signal?: string): void {
    this.kills.push(signal);
    this.exit(this.killExitCode);
  }
  onOutput(listener: (chunk: Buffer) => void): () => void {
    this.outputs.add(listener);
    if (this.replay.length > 0) listener(Buffer.from(this.replay));
    return () => this.outputs.delete(listener);
  }
  onExit(listener: (code: number, signal?: number) => void): () => void {
    if (this.exited) {
      queueMicrotask(() => listener(this.exitCode));
      return () => {};
    }
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }
  emit(text: string): void {
    const chunk = Buffer.from(text);
    this.replay = Buffer.concat([this.replay, chunk]);
    for (const listener of this.outputs) listener(chunk);
  }
  exit(code = 0): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    for (const listener of this.exits) listener(this.exitCode);
  }
}

const card = [
  SCOUT_CARD_BEGIN,
  "QUESTION",
  "Where is plan mode selected?",
  "",
  "VERDICT",
  "SUPPORTED",
  "",
  "BASIS",
  "direct-source",
  "",
  "FINDING",
  "Read-only launch uses plan mode.",
  "",
  "EVIDENCE",
  "- src/providers/cursor/commands.ts:cursorSafetyArgs selects plan.",
  "",
  "COVERAGE",
  "Inspected the Cursor command builder.",
  "",
  "CAVEAT",
  "None",
  "",
  "NEXT PROBE",
  "None",
  SCOUT_CARD_END,
].join("\n");

function streamText(text: string, usage?: { input_tokens: number; output_tokens: number }): string {
  return `${JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    ...(usage === undefined ? {} : { usage }),
  })}\n`;
}

/** Steps are recorded for one start only: the whole-chain test runs a second one to be refused. */
function recorded(
  steps: { underRoot: string } | undefined,
  cwd: string,
): boolean {
  return steps !== undefined && cwd.startsWith(steps.underRoot);
}

async function harness(options: {
  spawnError?: Error;
  workspaceStates?: string[];
  captureDelayMs?: number;
  killExitCode?: number;
  interactiveScout?: boolean;
  worktreeProvisioner?: WorktreeProvisioner;
  maxConcurrentWorkers?: number;
  /** Start steps recorded in the order the registry reached them, for the whole-chain test. */
  steps?: { push: (step: string) => void; underRoot: string };
} = {}) {
  const repo = await mkdtemp(join(tmpdir(), "cyberdeck-scout-repo-"));
  const state = await mkdtemp(join(tmpdir(), "cyberdeck-scout-state-"));
  directories.push(repo, state);
  const pty = new FakePty(options.killExitCode);
  const ptyFactory = vi.fn((spec: ProviderLaunchSpec) => {
    if (recorded(options.steps, spec.cwd)) options.steps?.push("spawn");
    if (options.spawnError !== undefined) throw options.spawnError;
    return pty;
  });
  const cursor: ProviderAdapter = {
    id: "cursor",
    buildLaunchSpec: (session, prompt) => ({
      executable: "fake",
      args: ["--print", "--output-format", "stream-json", prompt ?? ""],
      cwd: session.cwd,
      env: {},
      transport: "pipe",
      sensitiveArgIndexes: [3],
    }),
    initializeSession: async () => undefined,
    buildResumeSpec: () => { throw new Error("not used"); },
  };
  const states = [...(options.workspaceStates ?? ["a".repeat(64), "a".repeat(64)])];
  const reportStore = new ScoutReportStore(state);
  const scoutReports = {
    initialize: async (...args: Parameters<ScoutReportStore["initialize"]>) => {
      if (recorded(options.steps, args[1])) options.steps?.push("scout-init");
      return {
        ...await reportStore.initialize(...args),
        ...(options.interactiveScout === true ? { transport: "interactive-pty" as const } : {}),
      };
    },
    capture: options.captureDelayMs === undefined
      ? reportStore.capture.bind(reportStore)
      : async (...args: Parameters<ScoutReportStore["capture"]>) => {
          await new Promise((resolve) => setTimeout(resolve, options.captureDelayMs));
          return reportStore.capture(...args);
        },
    collect: reportStore.collect.bind(reportStore),
    appendTrace: reportStore.appendTrace.bind(reportStore),
    readArtifact: reportStore.readArtifact.bind(reportStore),
    remove: reportStore.remove.bind(reportStore),
  };
  const registry = new SessionRegistry({
    workerTurnObservation: new WorkerTurnObservationAdapter(),
    adapters: { cursor },
    sessionRuntimeFactory: ptyFactory,
    journal: { append: async () => {} },
    validateCwd: async (cwd) => {
      if (recorded(options.steps, cwd)) options.steps?.push("validate");
    },
    config: BrokerRuntimeConfigSchema.parse(
      options.maxConcurrentWorkers === undefined
        ? {}
        : { maxConcurrentWorkers: options.maxConcurrentWorkers },
    ),
    scoutReports,
    scoutWorkspaceState: async (cwd) => {
      if (recorded(options.steps, cwd)) options.steps?.push("baseline");
      return states.shift() ?? states.at(-1) ?? "a".repeat(64);
    },
    ...(options.worktreeProvisioner === undefined
      ? {}
      : { worktreeProvisioner: options.worktreeProvisioner }),
  });
  return { registry, pty, ptyFactory, repo, state, cursor };
}

function request(
  cwd: string,
  budget: { maxWallClockMs: number; maxTokens: number },
): StartSessionRequest {
  return {
    provider: "cursor",
    model: "composer",
    cwd,
    detached: true,
    sandbox: "read-only",
    approvalMode: "auto",
    kind: "worker",
    profile: "scout",
    brief: {
      objective: "Locate read-only launch",
      scope: ["src/providers/cursor/**"],
      questions: ["Where is plan mode selected?"],
      stopCondition: "Return evidence-backed answer",
      budget,
    },
  };
}

describe("Scout session lifecycle", () => {
  it("cancels the wall-clock cutoff when a legacy interactive Scout exits", async () => {
    vi.useFakeTimers();
    const { registry, pty, repo } = await harness({ interactiveScout: true });
    const record = await registry.start(
      request(repo, { maxWallClockMs: 50, maxTokens: 10_000 }),
      "Scout prompt",
    );
    expect(record.scout?.transport).toBe("interactive-pty");

    pty.exit(0);
    expect(registry.get(record.id)).toMatchObject({
      executionState: "exited",
      attentionState: "done",
      exitCode: 0,
      scout: { reportState: "missing" },
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(registry.get(record.id)).toMatchObject({
      executionState: "exited",
      attentionState: "done",
      exitCode: 0,
      scout: { reportState: "missing" },
    });
    expect(registry.get(record.id).scout?.terminalState).toBeUndefined();
    expect(pty.kills).toEqual([]);
  });

  it("preserves a failed headless launch as a durable Fleet record", async () => {
    const { registry, repo } = await harness({ spawnError: new Error("spawn refused") });

    const failure = await registry.start(
      request(repo, { maxWallClockMs: 10_000, maxTokens: 10_000 }),
      "Scout prompt",
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "SCOUT_LAUNCH_FAILED",
      sessionId: expect.any(String),
    });
    const failed = registry.list()[0]!;
    expect(failed).toMatchObject({
      id: (failure as { sessionId: string }).sessionId,
      pid: 0,
      executionState: "failed",
      attentionState: "failed",
      scout: {
        terminalState: "failed",
        launchFailure: { phase: "spawn", message: "spawn refused" },
      },
      launchRecord: {
        transport: "pipe",
        args: ["--print", "--output-format", "stream-json", "[REDACTED_PROVIDER_PROMPT]"],
      },
    });
    await expect(lstat(failed.scout!.dropBoxPath)).resolves.toBeDefined();
  });

  it("rejects escaping scope at broker dispatch boundary", async () => {
    const { registry, repo } = await harness();
    const invalid = request(repo, { maxWallClockMs: 10_000, maxTokens: 10_000 });
    invalid.brief!.scope = ["../outside/**"];

    await expect(registry.start(invalid, "Scout prompt")).rejects.toMatchObject({
      code: "INVALID_WORKER_PROFILE",
      message: "Scout scope escapes worker cwd: ../outside/**",
    });
  });

  it("completes only after headless exit, durable card capture, and workspace verification", async () => {
    const { registry, pty, ptyFactory, repo } = await harness();
    const record = await registry.start(
      request(repo, { maxWallClockMs: 10_000, maxTokens: 10_000 }),
      "Scout prompt",
    );
    expect(record).toMatchObject({
      effectiveState: {
        lifecycle: "worker",
        profile: "scout",
        tier: 1,
        provider: "cursor",
        model: "composer",
        permissions: "read-only",
        approvalMode: "auto",
        providerMode: "ask",
        transport: "headless-stream-json",
        leasePolicy: "expire-and-discard",
      },
      scout: {
        canary: { status: "pending" },
        reportState: "missing",
        transport: "headless-stream-json",
      },
    });
    expect(ptyFactory).toHaveBeenCalledWith(expect.any(Object), MIN_SCOUT_REPLAY_BYTES);

    pty.emit(streamText(card));
    const result = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 2_000, 4_000);

    expect(result).toMatchObject({
      timedOut: false,
      results: [{
        status: "completed",
        completedTurns: 1,
        terminalState: "complete",
        reportState: "complete",
        reportPath: record.scout?.reportPath,
      }],
    });
    expect(result.results[0]!.text).toContain("VERDICT\nSUPPORTED");
    expect(result.results[0]).not.toHaveProperty("report");
    expect(registry.get(record.id).scout?.canary.status).toBe("verified");
    expect(await readFile(record.scout!.tracePath!, "utf8")).toContain(SCOUT_CARD_BEGIN);
    expect(pty.writes).toEqual([]);
    expect(pty.kills).toEqual(["SIGTERM"]);
    await registry.delete(record.id);
    await expect(lstat(record.scout!.dropBoxPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves partial report when wall-clock cutoff stops the Scout", async () => {
    const { registry, pty, repo } = await harness();
    const record = await registry.start(
      request(repo, { maxWallClockMs: 20, maxTokens: 4_000 }),
      "Scout prompt",
    );
    pty.emit(streamText(
      `${SCOUT_CARD_BEGIN}\nQUESTION\nWhere?\n`,
      { input_tokens: 3_000, output_tokens: 1_100 },
    ));
    const result = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 2_000, 4_000);

    expect(result).toMatchObject({
      timedOut: false,
      results: [{
        status: "budget_exhausted",
        terminalState: "budget_exhausted",
        reportState: "partial",
      }],
    });
    expect(await readFile(record.scout!.reportPath, "utf8")).toContain("QUESTION");
  });

  it("accepts deprecated maxTokens without using it as terminal authority", async () => {
    const { registry, pty, repo } = await harness();
    const record = await registry.start(
      request(repo, { maxWallClockMs: 10_000, maxTokens: 1_000 }),
      "Scout prompt",
    );

    pty.emit(streamText("working", { input_tokens: 400, output_tokens: 500 }));
    expect(registry.get(record.id).scout?.terminalState).toBeUndefined();
    expect(pty.kills).toEqual([]);

    pty.emit(streamText(card, { input_tokens: 500, output_tokens: 600 }));
    await expect(registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 2_000, 4_000)).resolves.toMatchObject({
      results: [{
        status: "completed",
        terminalState: "complete",
      }],
    });
  });

  it("settles pre-cutoff async capture before deciding wall-clock exhaustion", async () => {
    const { registry, pty, repo } = await harness({ captureDelayMs: 40 });
    const record = await registry.start(
      request(repo, { maxWallClockMs: 10, maxTokens: 1 }),
      "Scout prompt",
    );

    pty.emit(streamText(card, { input_tokens: 100_000, output_tokens: 100_000 }));
    await expect(registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 2_000, 4_000)).resolves.toMatchObject({
      timedOut: false,
      results: [{
        status: "completed",
        completedTurns: 1,
        terminalState: "complete",
        reportState: "complete",
      }],
    });
  });

  it("treats expected early SIGTERM close as successful completion", async () => {
    const { registry, pty, repo } = await harness({ killExitCode: 143 });
    const record = await registry.start(
      request(repo, { maxWallClockMs: 10_000, maxTokens: 1 }),
      "Scout prompt",
    );

    pty.emit(streamText(card));
    await expect(registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 2_000, 4_000)).resolves.toMatchObject({
      results: [{ status: "completed", terminalState: "complete" }],
    });
  });

  it("enforces wall-clock budget as budget_exhausted", async () => {
    const { registry, repo } = await harness();
    const record = await registry.start(
      request(repo, { maxWallClockMs: 20, maxTokens: 10_000 }),
      "Scout prompt",
    );
    const result = await registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 2_000, 4_000);

    expect(result.results[0]).toMatchObject({
      status: "budget_exhausted",
      terminalState: "budget_exhausted",
      reportState: "missing",
    });
  });

  it("does not promote a valid card received after persisted cutoff", async () => {
    const { registry, pty, repo } = await harness();
    const record = await registry.start(
      request(repo, { maxWallClockMs: 20, maxTokens: 1 }),
      "Scout prompt",
    );
    await expect(registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 2_000, 4_000)).resolves.toMatchObject({
      results: [{ status: "budget_exhausted", reportState: "missing" }],
    });

    pty.emit(streamText(card));
    expect(registry.get(record.id).scout).toMatchObject({
      terminalState: "budget_exhausted",
      reportState: "missing",
    });
  });

  it("rehydrates canonical report from drop box after broker restart", async () => {
    const { registry, pty, repo, state, cursor } = await harness();
    const started = await registry.start(
      request(repo, { maxWallClockMs: 10_000, maxTokens: 10_000 }),
      "Scout prompt",
    );
    pty.emit(streamText(card));
    pty.exit(0);
    await registry.waitForWorkerResults([
      { sessionId: started.id, completionTarget: 1 },
    ], 2_000, 4_000);
    const storedBeforeCapture = registry.get(started.id);

    const recovered = new SessionRegistry({
      workerTurnObservation: new WorkerTurnObservationAdapter(),
      adapters: { cursor },
      sessionRuntimeFactory: () => { throw new Error("recovery must not spawn"); },
      journal: { append: async () => {} },
      recoveredSessions: [storedBeforeCapture],
      validateCwd: async () => undefined,
      config: BrokerRuntimeConfigSchema.parse({}),
      scoutReports: new ScoutReportStore(state),
      scoutWorkspaceState: async () => "a".repeat(64),
    });
    await recovered.ready();
    expect(recovered.get(started.id)).toMatchObject({
      executionState: "exited",
      attentionState: "done",
      scout: { terminalState: "complete", reportState: "complete" },
    });

    await expect(recovered.waitForWorkerResults([
      { sessionId: started.id, completionTarget: 1 },
    ], 0, 4_000)).resolves.toMatchObject({
      timedOut: false,
      results: [{
        status: "completed",
        retrieval: "fresh",
        terminalState: "complete",
        reportState: "complete",
      }],
    });
    const recoveredResult = await recovered.waitForWorkerResults([
      { sessionId: started.id, completionTarget: 1 },
    ], 0, 4_000);
    expect(recoveredResult.results[0]).not.toHaveProperty("report");
    expect(recoveredResult.results[0]!.text).toContain("VERDICT\nSUPPORTED");
  });

  it("fails a card-bearing Scout when observable repository state changes", async () => {
    const { registry, pty, repo } = await harness({
      workspaceStates: ["a".repeat(64), "b".repeat(64)],
    });
    const record = await registry.start(
      request(repo, { maxWallClockMs: 10_000, maxTokens: 10_000 }),
      "Scout prompt",
    );
    pty.emit(streamText(card));
    pty.exit(0);

    await expect(registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 2_000, 4_000)).resolves.toMatchObject({
      timedOut: false,
      results: [{
        status: "failed",
        terminalState: "failed",
        text: expect.stringContaining("changed observable repository state"),
      }],
    });
    expect(registry.get(record.id).scout?.canary.status).toBe("failed");
  });
});

describe("Scout start ordering", () => {
  it("validates, admits, reserves, initializes, provisions, baselines, then spawns", async () => {
    const steps: string[] = [];
    const recorder = { push: (step: string) => { steps.push(step); }, underRoot: "/nowhere" };
    const elsewhere = await mkdtemp(join(tmpdir(), "cyberdeck-scout-other-"));
    directories.push(elsewhere);
    let registry!: SessionRegistry;
    let worktreePath = "";
    let concurrent: unknown;
    const provisioner: WorktreeProvisioner = {
      provision: async ({ workspace }) => {
        steps.push("provision");
        // The worker slot is already held here: a start arriving while the worktree is being cut is
        // refused by the budget rather than admitted into a second provisioning.
        concurrent = await registry
          .start(request(elsewhere, { maxWallClockMs: 10_000, maxTokens: 10_000 }), "Second")
          .then(() => undefined, (error: unknown) => error);
        return {
          workspace: { ...workspace, worktreePath, repositoryPath: recorder.underRoot },
          baseCommit: "0".repeat(40),
          warnings: [],
        };
      },
      discard: async () => {},
    };

    const started = await harness({
      worktreeProvisioner: provisioner,
      maxConcurrentWorkers: 1,
      steps: recorder,
    });
    registry = started.registry;
    recorder.underRoot = started.repo;
    worktreePath = join(started.repo, "worktree");

    const record = await registry.start(
      {
        ...request(started.repo, { maxWallClockMs: 10_000, maxTokens: 10_000 }),
        workspace: {
          branch: "cyberdeck/mik-141",
          baseRef: "HEAD",
          provisioning: "cyberdeck-provisioned",
          writableRoots: [],
        },
      },
      "Scout prompt",
    );

    expect(steps).toEqual(["validate", "scout-init", "provision", "baseline", "spawn"]);
    expect(concurrent).toMatchObject({ code: "MAX_CONCURRENT_WORKERS" });
    // The Scout was initialized against the requested cwd and then moved into the worktree that
    // provisioning cut for it, which is also where its pre-launch baseline was read.
    expect(record.cwd).toBe(worktreePath);
    started.pty.exit(0);
  });
});
