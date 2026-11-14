import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { projectWorkerTruth, type WorkerTruthInput } from "../../src/domain/worker-truth.js";
import { collectFleetSnapshot, createFleetState, threadStatus } from "../../src/client/fleet/transport.js";
import { renderFleet } from "../../src/client/fleet.js";
import type { FleetThread, ThreadStatus } from "../../src/client/fleet/state.js";
import { statusMarker, threadPreview } from "../../src/client/fleet/render-rows.js";
import { statusText } from "../../src/client/fleet/slash-commands.js";

const NOW = "2026-10-13T00:00:00.000Z";
const record = { id: "11111111-1111-4111-8111-111111111111", provider: "claude", kind: "worker",
  cwd: "/repo", detached: true, sandbox: "read-only", createdAt: NOW, updatedAt: NOW,
  executionState: "active", attentionState: "done", attachmentState: "detached", pid: 42,
  exitCode: null, childIds: [] } as SessionRecord;

function observed(overrides: Partial<WorkerTruthInput> = {}): FleetThread {
  return { record, workerTruth: projectWorkerTruth({ executionState: "active", exitCode: null,
    activity: "unknown", composer: { occupied: false, modalOpen: false }, completedTurns: 0,
    canonicalTurns: 0, pendingInstructions: 0, ...overrides }) };
}

describe.each(["worker", "orchestrator"] as const)("Fleet %s truth parity", (kind) => {
  it.each([
    ["prompt-free startup", { awaitingInputReady: true }, "Starting"],
    ["startup modal", { awaitingInputReady: true, composer: { occupied: false, modalOpen: true } }, "Needs you"],
    ["dismissed modal", { composer: { occupied: false, modalOpen: false, inputReady: true }, activity: "awaiting-input" }, "Idle"],
    ["rendered but unsent composer", { pendingInstructions: 1, composer: { occupied: true, modalOpen: false } }, "Idle"],
    ["unrecognized screen despite old completed turns", { completedTurns: 2, canonicalTurns: 2 }, "Unavailable"],
    ["clean exit", { executionState: "exited", exitCode: 0, completedTurns: 1 }, "Exited"],
    ["recovered interrupted", { executionState: "cancelled", attentionState: "interrupted" }, "Interrupted"],
    ["observed work", { activity: "working" }, "Working"],
    ["stop still awaiting process exit", { executionState: "cancelled", stopRequested: true }, "Stopping"],
  ] satisfies Array<[string, Partial<WorkerTruthInput>, ThreadStatus]>)("renders %s from the shared projection", (_scenario, input, label) => {
    const thread = observed(input);
    thread.record = { ...record, kind };
    const snapshot = { threads: [thread] };
    expect(threadStatus(thread)).toBe(label);
    const rendered = renderFleet(snapshot, { ...createFleetState(snapshot), expandedHistoryCwds: ["/repo", "/@orcs"] }, { color: false, width: 150, height: 30, now: Date.parse(NOW) });
    expect(rendered).toContain(label);
    expect(rendered).not.toContain("Done");
  });
});

it("preserves the distinct broker modal and composer explanations", () => {
  const modal = observed({ composer: { occupied: false, modalOpen: true } });
  const composer = observed({ composer: { occupied: true, modalOpen: false } });
  expect(threadStatus(modal)).toBe("Needs you");
  expect(threadStatus(composer)).toBe("Idle");
  expect(modal.workerTruth?.detail).not.toEqual(composer.workerTruth?.detail);
  expect(threadPreview(modal, 200)).toBe(modal.workerTruth?.detail);
  expect(threadPreview(composer, 200)).toBe(composer.workerTruth?.detail);
});

it("reserves green Done for a broker-verified Scout decision-card outcome", () => {
  const scout: SessionRecord = { ...record, scout: { terminalState: "complete", reportState: "complete",
    canary: { status: "verified", verifiedAt: NOW }, dropBoxPath: "/repo/report", reportPath: "/repo/report/card.json" } };
  const thread = observed({ executionState: "exited", exitCode: 0,
    scoutTerminalState: "complete", scoutTaskSucceeded: true });
  thread.record = scout;
  expect(threadStatus(thread)).toBe("Done");
  const snapshot = { threads: [thread] };
  const rendered = renderFleet(snapshot, { ...createFleetState(snapshot), expandedHistoryCwds: ["/repo"] }, { color: true, width: 150, height: 30, now: Date.parse(NOW) });
  expect(rendered).toContain("\u001b[38;2;120;198;121mDone          \u001b[0m");
  expect(rendered).toContain("1 done");
  for (const state of ["unknown", "working", "stopping", "stopped", "failed", "errored", "provider-limit"] as const) {
    expect(threadStatus({ record: scout, workerTruth: { ...thread.workerTruth!, state } })).not.toBe("Done");
  }
  const unverified = { ...thread.workerTruth!, taskOutcome: "unknown" as const };
  expect(threadStatus({ record: { ...scout, scout: { ...scout.scout!, reportState: "invalid" } }, workerTruth: unverified })).toBe("Exited");
  expect(threadStatus({ record: { ...scout, scout: { ...scout.scout!, canary: { status: "pending" } } }, workerTruth: unverified })).toBe("Exited");
  expect(threadStatus({ record: { ...record, executionState: "exited", exitCode: 0, scout: scout.scout! } })).toBe("Done");
});

it("counts new statuses separately from process liveness and completion", () => {
  const states = ["starting", "working", "blocked-modal", "blocked-composer", "idle", "stalled", "provider-limit", "unknown", "stopping", "stopped", "interrupted", "exited", "failed"] as const;
  const threads = states.map((state, index) => ({ record: { ...record, id: `session-${index}` },
    workerTruth: { ...observed().workerTruth!, state } }));
  const snapshot = { threads };
  const rendered = renderFleet(snapshot, createFleetState(snapshot), { color: false, width: 300, height: 40, now: Date.parse(NOW) });
  for (const label of ["1 starting", "1 working", "1 needs you", "2 idle", "1 stalled", "1 provider limit", "1 unavailable", "1 stopping", "1 stopped", "1 interrupted", "1 exited", "1 failed"]) {
    expect(rendered).toContain(label);
  }
  expect(rendered).not.toContain("done");
});

it("keeps legacy polling bounded and reports absent activity evidence as Unknown", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "session.list") return [record, { ...record, id: "other", attentionState: "working" }];
    if (method === "fleet.projects") return ["/repo"];
    if (method === "strigoi.inspect") throw Object.assign(new Error("Unknown method"), { code: "METHOD_NOT_FOUND" });
    return [];
  });
  const snapshot = await collectFleetSnapshot({ request } as never);
  expect(snapshot.threads.map(threadStatus)).toEqual(["Unavailable", "Unavailable"]);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "session.list", "fleet.workerCoordination", "fleet.orchestratorOwnership", "fleet.projects", "strigoi.inspect",
  ]);
  expect(threadStatus({ record: { ...record, executionState: "exited", exitCode: 0 } })).toBe("Exited");
  expect(threadStatus({ record: { ...record, executionState: "failed", exitCode: 1 } })).toBe("Failed");
  expect(threadStatus({ record: { ...record, executionState: "cancelled", attentionState: "interrupted" } })).toBe("Interrupted");
  expect(threadStatus({ record: { ...record, executionState: "exited", termination: {
    kind: "provider-fault", reason: "Fault before exit", detail: "Fatal provider error", at: NOW,
  } } })).toBe("Failed");
});

it.each([
  { label: "undefined", value: undefined }, { label: "null", value: null }, { label: "empty array", value: [] },
  { label: "empty object", value: {} }, { label: "empty state", value: { state: {} } },
  { label: "incomplete identity", value: { state: { activeBinding: { sessionId: record.id } } } },
])("keeps ordinary rows and Unknown truth when optional resident inspection is $label", async ({ value }) => {
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return [record];
      if (method === "strigoi.inspect") return value;
      return [];
    });
    const snapshot = await collectFleetSnapshot({ request } as never);
    expect(snapshot.threads).toEqual([{ record }]);
    expect(threadStatus(snapshot.threads[0]!)).toBe("Unavailable");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "session.list", "fleet.workerCoordination", "fleet.orchestratorOwnership", "fleet.projects", "strigoi.inspect",
    ]);
  },
);

it("retains valid resident identity and holds without claiming activity for legacy rows", async () => {
  const resident = { ...record, kind: "orchestrator", provider: "codex" };
  const hold = { code: "retirement-unconfirmed", detail: "Exit unknown", sourceIds: [record.id] };
  const inspection = {
    state: { schemaVersion: 1, revision: 1, desired: "enabled", incarnation: 1, activeGeneration: 1,
      selection: { provider: "codex", model: "fixture", cwd: "/repo" }, retainedSessionIds: [record.id], updatedAt: NOW, hold,
      activeBinding: { key: "resident:strigoi", kind: "resident", resident: { name: "strigoi", incarnation: 1 }, sessionId: record.id,
        provider: "codex", cwd: "/repo", sandbox: "read-only", scope: { kind: "fleet" },
        grant: { subjectSessionId: record.id, capabilities: ["thread.read"], scope: { kind: "fleet" } }, createdAt: NOW, updatedAt: NOW } },
    readiness: "held", adoption: "pending", ownership: "unknown", usage: "unknown",
  };
  const request = vi.fn(async (method: string) => {
    if (method === "session.list") return [resident, { ...record, id: "ordinary" }];
    if (method === "strigoi.inspect") return inspection;
    return [];
  });
  const snapshot = await collectFleetSnapshot({ request } as never);
  expect(snapshot.threads[0]).toEqual({ record: { ...resident, name: "Strigoi #1" }, strigoi: {
    canonical: true, incarnation: 1, desired: "enabled", readiness: "held", adoption: "pending", hold, continuationHolds: [],
  } });
  expect(snapshot.threads[1]).toEqual({ record: { ...record, id: "ordinary" } });
  expect(snapshot.threads.map(threadStatus)).toEqual(["Unavailable", "Unavailable"]);
});

it.each(["Starting", "Idle", "Unavailable", "Stopping", "Stopped", "Interrupted", "Exited"] as const)("keeps %s neutral", (status) => {
  expect(statusMarker(status, false, true)).toContain("\u001b[38;2;154;163;175m");
  expect(statusText(status, false, true)).toContain("\u001b[38;2;154;163;175m");
});

it.each(["Needs you", "Stalled", "Provider limit"] as const)("keeps %s in attention amber", (status) => {
  expect(statusMarker(status, false, true)).toContain("\u001b[38;2;212;168;91m");
  expect(statusText(status, false, true)).toContain("\u001b[38;2;212;168;91m");
});
