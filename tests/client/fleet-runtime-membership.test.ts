import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import type { WorkerTruthState } from "../../src/domain/worker-truth.js";
import type { SessionRuntimePresence } from "../../src/domain/session-runtime-presence.js";
import { createFleetState, renderFleet, transitionFleet, type FleetSnapshot, type FleetState, type FleetThread } from "../../src/client/fleet.js";
import { fleetListRows, threadFocusInert } from "../../src/client/fleet/list-rows.js";
import { focusRow } from "../../src/client/fleet/list-groups.js";
import { normalizeState } from "../../src/client/fleet/normalize.js";
import { acknowledgeLifecycleNotices } from "../../src/client/fleet/lifecycle-state.js";
import { isLiveThread, isHistoricalThread } from "../../src/client/fleet/runtime-presence.js";
import { isUnreadThread, restoreFolderDispositions, restoreVisitPreferences } from "../../src/client/fleet/visit-state.js";
import { printedWidth } from "../../src/client/fleet/render-composer.js";

const NOW = "2026-10-17T18:00:00.000Z", now = Date.parse(NOW);
function thread(id: string, presence: SessionRuntimePresence, state: WorkerTruthState = "idle", generation = 1): FleetThread {
  return {
    runtimePresence: presence,
    record: { id, name: id, kind: "worker", provider: "codex", model: "gpt-6.1-sol", cwd: "/repo",
      sandbox: "workspace-write", detached: true, createdAt: NOW, updatedAt: NOW, meaningfulUpdatedAt: NOW,
      generation, executionState: presence === "absent" ? state === "interrupted" || state === "stopped" ? "cancelled" : "exited" : "active",
      pid: presence === "present" ? 42 : 0, exitCode: presence === "absent" ? state === "interrupted" ? -1 : state === "failed" ? 1 : 0 : null,
      attachmentState: "detached", childIds: [], latestPreview: "Existing assistant reply", latestPreviewKind: "assistant",
    } as SessionRecord,
    workerTruth: { state, terminal: presence === "absent", canonicalTurns: 1, completedTurns: 1,
      pendingInstructions: 0, modalOpen: false, composerOccupied: false, detail: `Observed ${state}` },
  };
}
function ids(snapshot: FleetSnapshot, state: FleetState): string[] {
  return fleetListRows(snapshot, state).flatMap((row) => row.kind === "thread" ? [row.thread.record.id] : []);
}
function command(state: FleetState, snapshot: FleetSnapshot, draft: string) {
  return transitionFleet({ ...state, draft }, snapshot, "enter", now).state;
}

describe("literal Fleet runtime membership", () => {
  it.each(["idle", "working", "starting", "blocked-modal", "stalled", "provider-limit", "failed", "stopping", "unknown"] as const)(
    "keeps a present runtime visible with %s status, including unhealthy and quiet processes", (status) => {
      const live = thread("current", "present", status), snapshot = { threads: [live] };
      expect(isLiveThread(live)).toBe(true);
      expect(ids(snapshot, createFleetState(snapshot))).toEqual(["current"]);
    });

  it.each(["interrupted", "failed", "stopped", "exited", "provider-limit", "unknown"] as const)(
    "puts an absent runtime in History while preserving %s", (status) => {
      const old = thread("old", "absent", status), snapshot = { threads: [old] };
      old.workerTruth!.pendingInstructions = 2;
      expect(isLiveThread(old)).toBe(false);
      const state = createFleetState(snapshot);
      expect(ids(snapshot, state)).toEqual([]);
      expect(ids(snapshot, command(state, snapshot, "/view history"))).toEqual(["old"]);
      expect(old.workerTruth!.state).toBe(status);
      expect(state.lifecycleWatermarks?.old?.notice).toBeUndefined();
    });

  it.each([[60, 24], [100, 45], [32, 18]])("keeps one live session findable beside 100 old sessions at %ix%i", (width, height) => {
    const old = Array.from({ length: 100 }, (_, index) => {
      const entry = thread(`historical-${index}`, "absent", index < 40 ? "interrupted" : "exited");
      entry.record.cwd = "/parking"; entry.record.meaningfulUpdatedAt = "2026-10-15T12:00:00.000Z";
      if (index === 0) entry.record.pinned = true;
      return entry;
    });
    const snapshot = { threads: [...old, thread("current-work", "present", "working")], projects: ["/parking", "/repo"] };
    const state = createFleetState(snapshot);
    expect(ids(snapshot, state)).toEqual(["current-work"]);
    expect(fleetListRows(snapshot, state).length).toBeLessThan(9);
    const body = renderFleet(snapshot, state, { width, height, now, color: false });
    expect(body).toContain("current-work");
    expect(body).not.toContain("historical-");
    expect(body).toContain("1 live");
    expect(body.split("\n").length).toBeLessThanOrEqual(height);
    expect(body.split("\n").every((row) => printedWidth(row) <= width)).toBe(true);
  });

  it("keeps unknown runtime ownership in a compact disclosure, independent of unknown activity", () => {
    const entry = thread("unconfirmed", "unknown"), snapshot = { threads: [entry] };
    let state = createFleetState(snapshot);
    expect(isLiveThread(entry)).toBe(false); expect(isHistoricalThread(entry)).toBe(false);
    expect(ids(snapshot, state)).toEqual([]);
    const row = fleetListRows(snapshot, state).find((row) => row.kind === "unconfirmed")!;
    state = focusRow(state, row);
    expect(transitionFleet(state, snapshot, "ctrl+x", now).action).toBeUndefined();
    state = transitionFleet(state, snapshot, "enter", now).state;
    expect(ids(snapshot, state)).toEqual(["unconfirmed"]);
    expect(renderFleet(snapshot, state, { width: 60, height: 24, color: false })).toContain("0 live");
  });

  it("does not leak History tab expansion or legacy disclosures into Live", () => {
    const snapshot = { threads: [thread("current", "present"), thread("old", "absent", "interrupted")] };
    let state = restoreFolderDispositions(createFleetState(snapshot), snapshot,
      { "/repo": { collapsed: false, expanded: false, historyExpanded: true } });
    expect(ids(snapshot, state)).toEqual(["current"]);
    state = command(state, snapshot, "/view history");
    expect(ids(snapshot, state)).toEqual(["old"]);
    state = command(state, snapshot, "/view live");
    expect(ids(snapshot, state)).toEqual(["current"]);
  });

  it.each([32, 60])("labels cached membership without clipping a count or inventing a loss at %i columns", (width) => {
    const snapshot = { threads: [thread("current", "present", "working")] };
    const state = normalizeState({ ...createFleetState(snapshot), connectionStale: true }, snapshot, now);
    const body = renderFleet(snapshot, state, { width, height: 30, now, color: false });
    expect(body).toContain("cached view");
    for (const count of ["1 live", "1 working", "0 needs input", "0 unread"]) expect(body).toContain(count);
    expect(body).toContain("Last confirmed:");
    expect(ids(snapshot, state)).toEqual(["current"]);
    expect(state.lifecycleWatermarks?.current?.notice).toBeUndefined();
  });

  it("uses explicit folder expansion without opening a history-only project on cursor traversal", () => {
    const snapshot = { threads: [thread("old", "absent", "interrupted")] };
    const row = fleetListRows(snapshot, createFleetState(snapshot)).find((row) => row.kind === "folder")!;
    const focused = focusRow(createFleetState(snapshot), row);
    expect(fleetListRows(snapshot, focused).find((row) => row.kind === "folder")).toMatchObject({ collapsed: true });
    const opened = transitionFleet(focused, snapshot, "enter", now);
    expect(opened.action).toMatchObject({ type: "folder-disposition", disposition: { collapsed: false } });
    expect(fleetListRows(snapshot, opened.state).some((row) => row.kind === "history")).toBe(true);
  });
});

describe("Fleet session loss notices", () => {
  it("compacts a fresh interruption and moves focus off the vanished row without arming its neighbour", () => {
    const before = { threads: [thread("chosen", "present", "working"), thread("neighbour", "present")] };
    const after = { threads: [thread("chosen", "absent", "interrupted"), before.threads[1]!] };
    const result = transitionFleet(createFleetState(before), after, "ctrl+x", now);
    expect(result.action).toBeUndefined(); expect(threadFocusInert(result.state)).toBe(true);
    expect(result.state.focusedLifecycleCwd).toBe("/repo");
    expect(ids(after, result.state)).toEqual(["neighbour"]);
    expect(fleetListRows(after, result.state).filter((row) => row.kind === "lifecycle")).toHaveLength(1);
    expect(isUnreadThread(result.state, "chosen")).toBe(false);
  });

  it("inspects a notice without resuming, consuming unread content or expanding historical siblings", () => {
    const old = Array.from({ length: 20 }, (_, index) => thread(`old-${index}`, "absent", "exited"));
    const before = { threads: [thread("chosen", "present"), ...old] };
    const after = { threads: [thread("chosen", "absent", "interrupted"), ...old] };
    let state = normalizeState(createFleetState(before), after, now);
    state = transitionFleet(state, after, "enter", now).state;
    state = transitionFleet(state, after, "down", now).state;
    expect(state.focusedLifecycleSessionId).toBe("chosen");
    const inspected = transitionFleet(state, after, "enter", now);
    expect(inspected.action).toBeUndefined();
    expect(ids(after, inspected.state)).toEqual(["chosen"]);
    expect(inspected.state.lifecycleWatermarks?.chosen?.notice?.generation).toBe(1);
    const read = command(inspected.state, after, "/read");
    expect(read.lifecycleWatermarks?.chosen?.notice?.generation).toBe(1);
    expect(command(read, after, "/ack").lifecycleWatermarks?.chosen?.notice).toBeUndefined();
  });

  it("leaves newer occurrences and new group members pending when acknowledging an older focused group", () => {
    const before = { threads: [thread("one", "present"), thread("two", "present")] };
    const firstLoss = { threads: [thread("one", "absent", "interrupted"), before.threads[1]!] };
    let state = normalizeState(createFleetState(before), firstLoss, now);
    state = focusRow(state, fleetListRows(firstLoss, state).find((row) => row.kind === "lifecycle"));
    const newer = { threads: [thread("one", "absent", "failed", 2), thread("two", "absent", "failed")] };
    state = command(state, newer, "/ack");
    expect(state.lifecycleWatermarks?.one?.acknowledgedGeneration).toBe(1);
    expect(state.lifecycleWatermarks?.one?.notice?.generation).toBe(2);
    expect(state.lifecycleWatermarks?.two?.notice?.generation).toBe(1);
  });

  it("keeps acknowledged losses quiet across snapshots but surfaces another loss after resume", () => {
    const before = { threads: [thread("one", "present")] };
    const lost = { threads: [thread("one", "absent", "interrupted")] };
    let state = normalizeState(createFleetState(before), lost, now);
    state = acknowledgeLifecycleNotices(state, { one: 1 });
    expect(normalizeState(state, lost, now).lifecycleWatermarks?.one?.notice).toBeUndefined();
    const resumed = { threads: [thread("one", "present", "idle", 2)] };
    state = normalizeState(state, resumed, now);
    expect(ids(resumed, command(state, resumed, "/view live"))).toEqual(["one"]);
    state = normalizeState(state, { threads: [thread("one", "absent", "interrupted", 2)] }, now);
    expect(state.lifecycleWatermarks?.one?.notice?.generation).toBe(2);
  });

  it.each(["stopped", "exited"] as const)("moves an ordinary %s into History without an interruption notice", (status) => {
    const state = normalizeState(createFleetState({ threads: [thread("one", "present")] }),
      { threads: [thread("one", "absent", status)] }, now);
    expect(state.lifecycleWatermarks?.one?.notice).toBeUndefined();
  });

  it("restores persisted live observations before noticing broker-recovery losses", () => {
    const recovered = { threads: [thread("one", "absent", "interrupted")] };
    const state = restoreVisitPreferences(createFleetState(recovered), recovered,
      { replies: {}, lifecycleInitialized: true, lifecycle: { one: { generation: 1, acknowledgedGeneration: 0, presence: "present" } } }, {});
    expect(state.lifecycleWatermarks?.one?.notice?.generation).toBe(1);
  });

  it("reveals only the explicitly stopped target through the stop/delete ladder", () => {
    const history = Array.from({ length: 20 }, (_, index) => thread(`old-${index}`, "absent", "exited"));
    const before = { threads: [thread("chosen", "present"), ...history] };
    const stopping = transitionFleet(createFleetState(before), before, "ctrl+x", now);
    const after = { threads: [thread("chosen", "absent", "stopped"), ...history] };
    const confirmation = transitionFleet(stopping.state, after, "ctrl+x", now);
    expect(ids(after, confirmation.state)).toEqual(["chosen"]);
    expect(transitionFleet(confirmation.state, after, "ctrl+x", now).action).toEqual({ type: "delete", sessionId: "chosen" });
  });
});
