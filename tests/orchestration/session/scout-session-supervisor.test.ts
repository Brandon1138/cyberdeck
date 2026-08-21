import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../../src/domain/session.js";
import type { ScoutDecisionCard } from "../../../src/domain/scout-output.js";
import type { ScoutRuntimeState } from "../../../src/domain/worker-profile.js";
import {
  ScoutSessionSupervisorFactory,
  ScoutSupervisionError,
} from "../../../src/orchestration/session/scout-session-supervisor.js";
import type {
  ScoutReportCapture,
  ScoutReportPort,
  ScoutSupervisionEffects,
} from "../../../src/orchestration/session/scout-supervision-ports.js";
import type { ScoutWorkspaceVerdict } from "../../../src/orchestration/session/session-workspace-ports.js";

const card: ScoutDecisionCard = {
  question: "Where does provisioning happen?",
  verdict: "SUPPORTED",
  basis: "direct-source",
  finding: "SessionWorkspaceCoordinator.provision owns it",
  evidence: ["src/orchestration/session/session-workspace-coordinator.ts:40"],
  coverage: "Read the coordinator and its two callers",
  caveat: undefined,
  nextProbe: undefined,
};

const completeCapture: ScoutReportCapture = {
  state: "complete",
  text: "CARD TEXT",
  card,
};

function scoutState(overrides: Partial<ScoutRuntimeState> = {}): ScoutRuntimeState {
  return {
    dropBoxPath: "/tmp/scout/session",
    reportPath: "/tmp/scout/session/card.md",
    tracePath: "/tmp/scout/session/trace.jsonl",
    transport: "headless-stream-json",
    workspaceStateHash: "a".repeat(64),
    canary: { status: "pending" },
    reportState: "missing",
    ...overrides,
  };
}

function scoutRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: "11111111-2222-4333-8444-555555555555",
    provider: "cursor",
    model: "composer",
    cwd: "/tmp/repo",
    detached: true,
    sandbox: "read-only",
    approvalMode: "auto",
    kind: "worker",
    profile: "scout",
    brief: {
      objective: "Find the seam",
      scope: ["src"],
      questions: ["Where does provisioning happen?"],
      stopCondition: "One card",
      budget: { maxWallClockMs: 50 },
    },
    generation: 1,
    createdAt: now,
    updatedAt: now,
    executionState: "active",
    attachmentState: "detached",
    pid: 4242,
    exitCode: null,
    childIds: [],
    attentionState: "working",
    meaningfulUpdatedAt: now,
    scout: scoutState(),
    ...overrides,
  };
}

/** Records every effect the supervisor asked the registry to perform, in order. */
function fakeEffects(overrides: Partial<ScoutSupervisionEffects> = {}) {
  const order: string[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const transcript: { text: string; data: Record<string, unknown> }[] = [];
  const kills: (string | undefined)[] = [];
  const results: string[] = [];
  const completions: { turns: number; text: string }[] = [];
  let updates = 0;
  const effects: ScoutSupervisionEffects = {
    persist: async () => { order.push("persist"); },
    appendEvent: async (type, data) => {
      order.push(`event:${type}`);
      events.push({ type, data });
    },
    appendTranscript: async (text, data) => {
      order.push("transcript");
      transcript.push({ text, data });
    },
    notifySessionUpdate: () => { updates += 1; },
    setLatestResult: (text) => { results.push(text); },
    setLatestResultIfAbsent: (text) => { results.push(text); },
    recordCompletion: (turns, text) => { completions.push({ turns, text }); },
    kill: (signal) => {
      order.push("kill");
      kills.push(signal);
    },
    stopRequested: () => false,
    ...overrides,
  };
  return {
    effects,
    order,
    events,
    transcript,
    kills,
    results,
    completions,
    updateCount: () => updates,
  };
}

/** A drop box that answers from a script and records what it was asked. */
function fakeReports(overrides: Partial<ScoutReportPort> = {}) {
  const traced: Buffer[] = [];
  const reports: ScoutReportPort = {
    initialize: async () => scoutState(),
    capture: async () => ({ state: "missing" }),
    collect: async () => ({ state: "missing" }),
    appendTrace: async (_runtime, chunk) => { traced.push(chunk); },
    readArtifact: async () => ({
      artifact: "card" as const,
      text: "",
      afterByte: 0,
      nextByte: 0,
      totalBytes: 0,
      complete: true,
    }),
    remove: async () => undefined,
    ...overrides,
  };
  return { reports, traced };
}

function verifyingWorkspace(verdict: ScoutWorkspaceVerdict = {
  ok: true,
  workspaceStateHash: "a".repeat(64),
}) {
  return { verifyScoutWorkspace: async () => verdict };
}

function supervisorFor(
  record: SessionRecord,
  reports: ScoutReportPort,
  effects: ScoutSupervisionEffects,
  workspace = verifyingWorkspace(),
) {
  const supervisor = new ScoutSessionSupervisorFactory({ reports, workspace })
    .create(record, effects);
  expect(supervisor).toBeDefined();
  return supervisor!;
}

/** Lets a queued microtask chain — capture and trace tails — run to completion. */
async function settle(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

describe("ScoutSessionSupervisorFactory", () => {
  it("instantiates no supervisor for an ordinary session", () => {
    const { reports } = fakeReports();
    const { effects } = fakeEffects();
    const supervisor = new ScoutSessionSupervisorFactory({ reports, workspace: verifyingWorkspace() })
      .create(scoutRecord({ profile: undefined, scout: undefined }), effects);
    expect(supervisor).toBeUndefined();
  });

  it("refuses a Scout start when the broker owns no drop box", async () => {
    const factory = new ScoutSessionSupervisorFactory({ workspace: verifyingWorkspace() });
    await expect(factory.initialize("session", "/tmp/repo")).rejects.toBeInstanceOf(
      ScoutSupervisionError,
    );
    await expect(factory.initialize("session", "/tmp/repo")).rejects.toMatchObject({
      code: "SCOUT_REPORT_STORE_UNAVAILABLE",
      message: "Scout profile requires broker-owned drop-box storage",
    });
  });
});

describe("ScoutSessionSupervisor", () => {
  it("requests exactly one SIGTERM when a valid card arrives", async () => {
    const record = scoutRecord();
    const { reports } = fakeReports({ capture: async () => completeCapture });
    const harness = fakeEffects();
    const supervisor = supervisorFor(record, reports, harness.effects);

    supervisor.observeOutput(Buffer.from("chunk one"), () => "replay one");
    await settle();
    supervisor.observeOutput(Buffer.from("chunk two"), () => "replay two");
    await settle();

    expect(harness.kills).toEqual(["SIGTERM"]);
    expect(record.scout?.reportState).toBe("complete");
    expect(supervisor.decisionCard()?.finding).toBe(card.finding);
  });

  it("fails a Scout whose durable trace could not be written", async () => {
    const record = scoutRecord();
    const { reports } = fakeReports({
      appendTrace: async () => { throw new Error("disk full"); },
      collect: async () => completeCapture,
    });
    const harness = fakeEffects();
    const supervisor = supervisorFor(record, reports, harness.effects);

    supervisor.observeOutput(Buffer.from("stream frame"), () => "replay");
    await settle();

    const outcome = await supervisor.finalizeExit(0, () => "replay");
    expect(outcome).toEqual({ status: "settled" });
    expect(record.scout?.terminalState).toBe("failed");
    expect(record.scout?.launchFailure?.message).toBe(
      "Durable Scout trace could not be persisted: disk full",
    );
    expect(record.scout?.canary).toMatchObject({ status: "failed" });
    expect(harness.events.map(({ type }) => type)).toContain("scout.run.failed");
  });

  it("fails a card-bearing Scout when the workspace no longer matches its baseline", async () => {
    const record = scoutRecord();
    const { reports } = fakeReports({ collect: async () => completeCapture });
    const harness = fakeEffects();
    const supervisor = supervisorFor(record, reports, harness.effects, {
      verifyScoutWorkspace: async () => ({
        ok: false,
        reason: "Scout modified its workspace: repository state hash changed",
      }),
    });

    await supervisor.finalizeExit(0, () => "replay");

    expect(record.scout?.terminalState).toBe("failed");
    expect(record.executionState).toBe("failed");
    expect(record.scout?.launchFailure?.message).toBe(
      "Scout modified its workspace: repository state hash changed",
    );
    expect(harness.events.map(({ type }) => type)).toContain("scout.canary.failed");
  });

  it("persists the wall-clock cutoff before it stops the provider", async () => {
    vi.useFakeTimers();
    try {
      const record = scoutRecord();
      const { reports } = fakeReports();
      const harness = fakeEffects();
      const supervisor = supervisorFor(record, reports, harness.effects);

      supervisor.armBudget();
      await vi.advanceTimersByTimeAsync(60);
      await settle();

      expect(record.scout?.terminalState).toBe("budget_exhausted");
      expect(record.executionState).toBe("cancelled");
      expect(record.attentionState).toBe("stopped");
      const persistIndex = harness.order.indexOf("persist");
      const killIndex = harness.order.indexOf("kill");
      expect(persistIndex).toBeGreaterThanOrEqual(0);
      expect(killIndex).toBeGreaterThan(persistIndex);
      expect(harness.events.map(({ type }) => type)).toContain("scout.budget.exhausted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not promote a valid card that arrives after the cutoff is persisted", async () => {
    vi.useFakeTimers();
    try {
      const record = scoutRecord();
      const { reports } = fakeReports();
      const capture = vi.fn(async (): Promise<ScoutReportCapture> => completeCapture);
      reports.capture = capture;
      const harness = fakeEffects();
      const supervisor = supervisorFor(record, reports, harness.effects);

      supervisor.armBudget();
      await vi.advanceTimersByTimeAsync(60);
      await settle();
      expect(record.scout?.terminalState).toBe("budget_exhausted");

      // Everything the provider emits on its way out is refused by the cutoff gate.
      supervisor.observeOutput(Buffer.from("late card"), () => "late replay");
      await settle();

      expect(capture).not.toHaveBeenCalled();
      expect(record.scout?.terminalState).toBe("budget_exhausted");
      expect(record.scout?.reportState).toBe("missing");
      expect(supervisor.decisionCard()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rehydrates a finished Scout from its drop box after a restart", async () => {
    const record = scoutRecord({
      executionState: "failed",
      attentionState: "failed",
      exitCode: null,
      scout: scoutState({ terminalState: "complete", reportState: "partial" }),
    });
    const { reports } = fakeReports({ collect: async () => completeCapture });
    const harness = fakeEffects();
    const supervisor = supervisorFor(record, reports, harness.effects);

    await supervisor.recover();

    expect(record.scout?.reportState).toBe("complete");
    expect(record.executionState).toBe("exited");
    expect(record.attentionState).toBe("done");
    expect(record.exitCode).toBe(0);
    expect(supervisor.decisionCard()?.verdict).toBe("SUPPORTED");
    expect(harness.completions).toEqual([{ turns: 1, text: "CARD TEXT" }]);
    expect(harness.order).toContain("persist");
  });

  it("leaves a cut-off Scout cut off when recovery finds a card in its drop box", async () => {
    const record = scoutRecord({
      scout: scoutState({ terminalState: "budget_exhausted", reportState: "partial" }),
    });
    const { reports } = fakeReports({ collect: async () => completeCapture });
    const harness = fakeEffects();
    const supervisor = supervisorFor(record, reports, harness.effects);

    await supervisor.recover();

    expect(record.scout?.terminalState).toBe("budget_exhausted");
    expect(harness.completions).toEqual([]);
  });

  it("settles finalization once and reports every later close path as duplicate", async () => {
    const record = scoutRecord();
    const collect = vi.fn(async (): Promise<ScoutReportCapture> => completeCapture);
    const { reports } = fakeReports({ collect });
    const harness = fakeEffects();
    const supervisor = supervisorFor(record, reports, harness.effects);

    const first = await supervisor.finalizeExit(0, () => "replay");
    const second = await supervisor.finalizeExit(0, () => "replay");

    expect(first).toEqual({ status: "settled" });
    expect(second).toEqual({ status: "duplicate" });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(record.scout?.terminalState).toBe("complete");
    expect(record.attentionState).toBe("done");
    expect(harness.completions).toEqual([{ turns: 1, text: "CARD TEXT" }]);
    expect(harness.events.map(({ type }) => type)).toEqual([
      "scout.canary.verified",
      "scout.report.captured",
    ]);
  });

  it("preserves a launch failure as a durable record before it is registered", async () => {
    const record = scoutRecord({ executionState: "starting", pid: 0 });
    const { reports } = fakeReports();
    const harness = fakeEffects();
    const supervisor = supervisorFor(record, reports, harness.effects);
    const seenAtRegistration: string[] = [];

    await supervisor.preserveLaunchFailure("spawn", new Error("cursor-agent missing"), async () => {
      seenAtRegistration.push(record.executionState, record.scout?.terminalState ?? "none");
    });

    expect(seenAtRegistration).toEqual(["failed", "failed"]);
    expect(record.exitCode).toBe(1);
    expect(record.attentionState).toBe("failed");
    expect(harness.transcript[0]?.text).toBe("Scout launch failed");
  });

  it("stops a live Scout that failed after launch and keeps its record readable", async () => {
    const record = scoutRecord();
    const { reports } = fakeReports();
    const harness = fakeEffects();
    const supervisor = supervisorFor(record, reports, harness.effects);

    await supervisor.failLive("initialize", new Error("composer never answered"));

    expect(record.scout?.terminalState).toBe("failed");
    expect(record.executionState).toBe("failed");
    expect(harness.kills).toEqual(["SIGTERM"]);
    expect(harness.results.at(-1)).toBe("Scout failed during initialize: composer never answered");
  });
});
