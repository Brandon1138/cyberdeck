import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry, type PtyHandle } from "../../src/broker/session-registry.js";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import type { SessionRecord, StartSessionRequest } from "../../src/domain/session.js";
import { MIN_SCOUT_REPLAY_BYTES } from "../../src/domain/worker-profile.js";
import { ScoutReportStore } from "../../src/persistence/scout-report-store.js";
import type {
  ProviderAdapter,
  ProviderLaunchSpec,
} from "../../src/providers/provider.js";
import {
  SCOUT_REPORT_BEGIN,
  SCOUT_REPORT_END,
} from "../../src/orchestration/worker-profiles.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakePty implements PtyHandle {
  readonly pid = 9001;
  readonly writes: Buffer[] = [];
  readonly kills: Array<string | undefined> = [];
  private replay = "";
  private readonly outputs = new Set<(chunk: Buffer) => void>();
  private readonly exits = new Set<(code: number, signal?: number) => void>();

  write(data: Buffer): void { this.writes.push(Buffer.from(data)); }
  resize(): void {}
  snapshot(): Buffer { return Buffer.from(this.replay); }
  kill(signal?: string): void {
    this.kills.push(signal);
    for (const listener of this.exits) listener(0);
  }
  onOutput(listener: (chunk: Buffer) => void): () => void {
    this.outputs.add(listener);
    return () => this.outputs.delete(listener);
  }
  onExit(listener: (code: number, signal?: number) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }
  emit(text: string): void {
    this.replay += text;
    for (const listener of this.outputs) listener(Buffer.from(text));
  }
}

const report = {
  findings: [{
    finding: "Read-only launch uses plan mode",
    evidence: [{
      path: "src/providers/cursor/commands.ts",
      symbol: "cursorSafetyArgs",
    }],
  }],
  coverage: {
    searched: ["src/providers/cursor/**"],
    methods: ["rg and file reads"],
  },
  uncertainties: [],
  suggestedFollowUpProbes: [],
};

async function harness(options: {
  initializationReplay?: string;
  verifiedCanary?: boolean;
} = {}) {
  const repo = await mkdtemp(join(tmpdir(), "cyberdeck-scout-repo-"));
  const state = await mkdtemp(join(tmpdir(), "cyberdeck-scout-state-"));
  directories.push(repo, state);
  const pty = new FakePty();
  const ptyFactory = vi.fn((_spec: ProviderLaunchSpec) => pty);
  const cursor: ProviderAdapter = {
    id: "cursor",
    buildLaunchSpec: (session) => ({
      executable: "fake",
      args: ["--mode", "plan", "--sandbox", "enabled"],
      cwd: session.cwd,
      env: {},
    }),
    deferInitialPrompt: () => true,
    initializeSession: async () => {
      if (options.initializationReplay !== undefined) pty.emit(options.initializationReplay);
      if (options.verifiedCanary === false) return;
      return {
        scoutReadOnlyCanary: { verifiedAt: "2026-07-27T01:00:00.000Z" },
      };
    },
    buildResumeSpec: () => { throw new Error("not used"); },
    submitInput: (message) => Buffer.from(`${message}\r`),
  };
  const registry = new SessionRegistry({
    adapters: { cursor },
    ptyFactory,
    journal: { append: async () => {} },
    validateCwd: async () => undefined,
    config: BrokerRuntimeConfigSchema.parse({}),
    scoutReports: new ScoutReportStore(state),
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
  it("fails launch closed when provider does not return behavioral canary proof", async () => {
    const { registry, pty, repo } = await harness({ verifiedCanary: false });

    await expect(registry.start(
      request(repo, { maxWallClockMs: 10_000, maxTokens: 10_000 }),
      "Scout prompt",
    )).rejects.toMatchObject({
      code: "INVALID_WORKER_PROFILE",
      message: "Scout launch did not verify read-only enforcement",
    });
    expect(pty.kills).toHaveLength(1);
    expect(pty.writes).toEqual([]);
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

  it("collects canonical drop-box report even when completion capture stalls", async () => {
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
        leasePolicy: "expire-and-discard",
      },
      scout: { canary: { status: "verified" }, reportState: "missing" },
    });
    expect(ptyFactory).toHaveBeenCalledWith(expect.any(Object), MIN_SCOUT_REPLAY_BYTES);

    // No Cursor idle/completion frame. Framed report alone is canonical and settles the wait.
    pty.emit(`${SCOUT_REPORT_BEGIN}\n${JSON.stringify(report)}\n${SCOUT_REPORT_END}\n`);
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
    expect(JSON.parse(result.results[0]!.text)).toEqual(report);
    expect(result.results[0]).not.toHaveProperty("report");
    expect(ptysKilledWithTerm(pty)).toBe(true);
    await registry.delete(record.id);
    await expect(lstat(record.scout!.dropBoxPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("terminates on token budget and preserves partial report after kill mid-write", async () => {
    const { registry, pty, repo } = await harness();
    const record = await registry.start(
      request(repo, { maxWallClockMs: 10_000, maxTokens: 4_000 }),
      "Scout prompt",
    );
    pty.emit(`${SCOUT_REPORT_BEGIN}\n{"findings":[\nComposing 4.1k tokens\n`);
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
    expect(await readFile(record.scout!.reportPath, "utf8")).toContain('{"findings":[');
  });

  it("starts token accounting after launch verification and enforces dispatch consumption", async () => {
    const { registry, pty, repo } = await harness({
      initializationReplay: "Composing 4.1k tokens\nAdd a follow-up\n",
    });
    const record = await registry.start(
      request(repo, { maxWallClockMs: 10_000, maxTokens: 1_000 }),
      "Scout prompt",
    );

    pty.emit(`${SCOUT_REPORT_BEGIN}\n{"findings":[\nComposing 4.5k tokens\n`);
    expect(registry.get(record.id).scout?.terminalState).toBeUndefined();
    expect(pty.kills).toEqual([]);

    pty.emit("Composing 5.2k tokens\n");
    await expect(registry.waitForWorkerResults([
      { sessionId: record.id, completionTarget: 1 },
    ], 2_000, 4_000)).resolves.toMatchObject({
      results: [{
        status: "budget_exhausted",
        terminalState: "budget_exhausted",
      }],
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

  it("rehydrates canonical report from drop box after broker restart", async () => {
    const { registry, repo, state, cursor } = await harness();
    const started = await registry.start(
      request(repo, { maxWallClockMs: 10_000, maxTokens: 10_000 }),
      "Scout prompt",
    );
    const storedBeforeCapture = registry.get(started.id);
    await new ScoutReportStore(state).capture(
      storedBeforeCapture.scout!,
      `${SCOUT_REPORT_BEGIN}\n${JSON.stringify(report)}\n${SCOUT_REPORT_END}\n`,
    );
    await registry.stop(started.id);

    const recovered = new SessionRegistry({
      adapters: { cursor },
      ptyFactory: () => { throw new Error("recovery must not spawn"); },
      journal: { append: async () => {} },
      recoveredSessions: [storedBeforeCapture],
      validateCwd: async () => undefined,
      config: BrokerRuntimeConfigSchema.parse({}),
      scoutReports: new ScoutReportStore(state),
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
    expect(JSON.parse(recoveredResult.results[0]!.text)).toEqual(report);
  });
});

function ptysKilledWithTerm(pty: FakePty): boolean {
  return pty.kills.includes("SIGTERM");
}
