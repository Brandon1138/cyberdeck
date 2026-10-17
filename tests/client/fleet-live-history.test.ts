import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runFleet } from "../../src/client/fleet.js";
import type { ServerFrame } from "../../src/protocol/frames.js";
import type { FleetVisitPreferences } from "../../src/domain/fleet-preferences.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { isTerminalWorkerTruth, type WorkerTruthState } from "../../src/domain/worker-truth.js";
import { createFleetState, renderFleet, transitionFleet, type FleetSnapshot, type FleetState, type FleetThread } from "../../src/client/fleet.js";
import { fleetListRows, threadFocusInert } from "../../src/client/fleet/list-rows.js";
import { normalizeState } from "../../src/client/fleet/normalize.js";
import { isLiveThread, isUnreadThread, markThreadRead, restoreVisitPreferences } from "../../src/client/fleet/visit-state.js";
import { focusRow } from "../../src/client/fleet/list-groups.js";
import { printedWidth } from "../../src/client/fleet/render-composer.js";
import { renderSelectedDetail } from "../../src/client/fleet/render-detail.js";
import type { ResolvedFleetRenderOptions } from "../../src/client/fleet/runtime-options.js";
import { composerCursor, FleetKeyDecoder } from "../../src/client/fleet/key-decoder.js";
import { prepareFleetFrame } from "../../src/client/fleet/prepare-frame.js";
import { LEGACY_CREATOR_CONTROLLER_ID } from "../../src/client/lease-custody.js";

const NOW = "2026-10-14T12:00:00.000Z";
const now = Date.parse(NOW);
function worker(id: string, state: WorkerTruthState, turns = 1, preview = "The original assistant reply."): FleetThread {
  const exited = ["exited", "stopped", "failed"].includes(state);
  return {
    record: { id, kind: "worker", provider: "codex", model: "gpt-6.1-sol", effort: "max",
      name: `Task ${id}`, cwd: "/repo", detached: true, sandbox: "workspace-write", createdAt: NOW,
      updatedAt: NOW, meaningfulUpdatedAt: NOW, attachmentState: "detached", childIds: [],
      executionState: exited ? state === "stopped" ? "cancelled" : state : state === "starting" ? "starting" : "active",
      exitCode: exited ? state === "failed" ? 1 : 0 : null, pid: exited ? null : 42,
      latestPreview: preview, latestPreviewKind: "assistant", observedModel: { model: "gpt-6.1-sol", effort: "max", observedAt: NOW },
    } as SessionRecord,
    workerTruth: { state, terminal: isTerminalWorkerTruth(state), canonicalTurns: turns, completedTurns: turns,
      pendingInstructions: 0, modalOpen: state === "blocked-modal", composerOccupied: state === "blocked-composer",
      detail: state === "unknown" ? "No recognized current input surface" : `Observed ${state}` },
  };
}
function visible(snapshot: FleetSnapshot, state: FleetState): string[] {
  return fleetListRows(snapshot, state).flatMap((row) => row.kind === "thread" ? [row.thread.record.id] : []);
}
function options(width = 60, height = 50): ResolvedFleetRenderOptions {
  return { width, height, color: false, now, home: "/Users/brandon", pullRequests: new Map(), background: undefined };
}
function reply(snapshot: FleetSnapshot, text = "A new meaningful assistant reply."): FleetSnapshot {
  return { ...snapshot, threads: snapshot.threads.map((thread) => ({ ...thread,
    record: { ...thread.record, latestPreview: text, meaningfulUpdatedAt: "2026-10-14T12:05:00.000Z" },
    workerTruth: { ...thread.workerTruth!, canonicalTurns: 2, completedTurns: 2 },
  })) };
}

describe("Fleet live/history membership and navigation", () => {
  it.each(["working", "starting", "unknown", "blocked-modal", "blocked-composer", "stalled", "provider-limit", "failed", "errored", "interrupted", "stopping"] as const)("keeps %s actionable ahead of history", (status) => {
    const thread = worker(status, status);
    expect(isLiveThread(thread)).toBe(true);
    expect(visible({ threads: [thread] }, createFleetState({ threads: [thread] }))).toEqual([status]);
  });
  it.each(["idle", "exited", "stopped"] as const)("folds known inactive %s without deleting it", (status) => {
    const thread = worker(status, status), snapshot = { threads: [thread] };
    expect(isLiveThread(thread)).toBe(false);
    expect(visible(snapshot, createFleetState(snapshot))).toEqual([]);
    expect(fleetListRows(snapshot, createFleetState(snapshot))).toContainEqual({ kind: "history", cwd: "/repo", threadCount: 1, expanded: false });
  });
  it("keeps queued idle, inconsistent stopped, and legacy live Unknown sessions visible", () => {
    const queued = worker("queued", "idle"); queued.workerTruth!.pendingInstructions = 1;
    const contradictory = worker("contradictory", "stopped"); contradictory.record.exitCode = null;
    const legacy = worker("legacy", "unknown"); delete legacy.workerTruth;
    expect([queued, contradictory, legacy].map(isLiveThread)).toEqual([true, true, true]);
  });
  it("preserves pins within partitions and never caps actionable workers or Orcs", () => {
    const threads = Array.from({ length: 9 }, (_, index) => worker(String(index), "unknown"));
    threads[7]!.record.pinned = true;
    const old = worker("old", "stopped"); old.record.pinned = true;
    const snapshot = { threads: [old, ...threads] };
    expect(visible(snapshot, createFleetState(snapshot))).toHaveLength(9);
    expect(visible(snapshot, createFleetState(snapshot))[0]).toBe("7");
    for (const thread of threads) thread.record.kind = "orchestrator";
    expect(visible(snapshot, createFleetState(snapshot))).toHaveLength(9);
  });
  it("renders all-history and empty registered projects with accurate counts", () => {
    const snapshot = { threads: [worker("old", "exited")], projects: ["/repo", "/empty"] };
    const state = createFleetState(snapshot);
    const rendered = renderFleet(snapshot, state, options());
    expect(rendered).toContain("History · 1");
    expect(rendered).toContain("/empty · 0 threads");
    expect(rendered).not.toContain("Task old");
  });
  it("toggles history in rendering and navigation together, with a durable fold action", () => {
    const snapshot = { threads: [worker("live", "working"), worker("old", "exited")] };
    const state = { ...createFleetState(snapshot), focusedHistoryCwd: "/repo" };
    const opened = transitionFleet(state, snapshot, "enter", now);
    expect(opened.action).toEqual({ type: "folder-disposition", cwd: "/repo", disposition: { collapsed: false, expanded: false, historyExpanded: true } });
    expect(visible(snapshot, opened.state)).toEqual(["live", "old"]);
    const old = transitionFleet(opened.state, snapshot, "down", now).state;
    expect(old.selectedSessionId).toBe("old");
    expect(transitionFleet(old, snapshot, "enter", now).action).toEqual({ type: "resume", sessionId: "old" });
    const closed = transitionFleet(opened.state, snapshot, "left", now);
    expect(visible(snapshot, closed.state)).toEqual(["live"]);
    expect(renderFleet(snapshot, closed.state, options())).not.toContain("Task old");
  });
  it("caps history alone, with a navigable show-more control", () => {
    const snapshot = { threads: Array.from({ length: 8 }, (_, index) => worker(String(index), "exited")) };
    let state: FleetState = { ...createFleetState(snapshot), expandedHistoryCwds: ["/repo"], focusedShowMoreCwd: "/repo" };
    expect(visible(snapshot, state)).toHaveLength(5);
    state = transitionFleet(state, snapshot, "right", now).state;
    expect(visible(snapshot, state)).toHaveLength(8);
    state = transitionFleet(state, snapshot, "left", now).state;
    expect(visible(snapshot, state)).toHaveLength(5);
  });
  it("keeps a hidden selection inert when it moves to History or disappears", () => {
    const snapshot = { threads: [worker("chosen", "working"), worker("other", "working")] };
    const state = { ...createFleetState(snapshot), selectedSessionId: "chosen" };
    const changed = { threads: [worker("chosen", "idle"), snapshot.threads[1]!] };
    const normalized = transitionFleet(state, changed, "ctrl+x", now);
    expect(normalized.state.selectedSessionId).toBe("chosen");
    expect(normalized.state.focusedHistoryCwd).toBe("/repo");
    expect(normalized.action).toBeUndefined();
    const removed = transitionFleet(state, { threads: [snapshot.threads[1]!] }, "ctrl+x", now);
    expect(removed.state.selectedSessionId).toBeUndefined();
    expect(removed.state.focusedViewControl).toBe("live");
    expect(removed.action).toBeUndefined();
    const folderFocus = { ...state, focusedFolderCwd: "/repo" };
    const refreshed = normalizeState(folderFocus, { threads: [snapshot.threads[1]!] }, now);
    expect(refreshed.focusedFolderCwd).toBe("/repo"); expect(refreshed.focusedViewControl).toBeUndefined();
  });
  it("retains the stop/delete ladder on the same id through a history transition", () => {
    const before = { threads: [worker("chosen", "working"), worker("other", "working")] };
    const stopping = transitionFleet(createFleetState(before), before, "ctrl+x", now);
    const after = { threads: [worker("chosen", "stopped"), before.threads[1]!] };
    const confirm = transitionFleet(stopping.state, after, "ctrl+x", now);
    expect(confirm.state.deleteConfirmation?.sessionId).toBe("chosen");
    expect(transitionFleet(confirm.state, after, "ctrl+x", now).action).toEqual({ type: "delete", sessionId: "chosen" });
    const onHistory = { ...confirm.state, focusedHistoryCwd: "/repo", notice: undefined };
    const collapsed = transitionFleet(onHistory, after, "left", now).state;
    expect(visible(after, normalizeState(collapsed, after, now))).toEqual(["other"]);
  });
  it("makes folder, history, view and update focus inert for thread keys and detail", () => {
    const before = { threads: [worker("orc", "working"), worker("old", "exited")] }; before.threads[0]!.record.kind = "orchestrator";
    let state = normalizeState(createFleetState(before), reply(before), now);
    for (const row of fleetListRows(reply(before), state).filter((row) => ["views", "history", "folder", "update"].includes(row.kind))) {
      const focused = focusRow(state, row);
      expect(threadFocusInert(focused)).toBe(true);
      for (const key of ["ctrl+x", "ctrl+r", "ctrl+t", "ctrl+]", " "]) expect(transitionFleet(focused, reply(before), key, now).action).toBeUndefined();
      expect(renderSelectedDetail(reply(before), focused, options(), 8)).toEqual([]);
    }
  });
  it("supports the keyboard view controls and slash commands without new control bytes", () => {
    const snapshot = { threads: [worker("live", "working"), worker("old", "exited")] };
    let state = transitionFleet(createFleetState(snapshot), snapshot, "home", now).state;
    expect(state.focusedViewControl).toBe("live");
    state = transitionFleet(state, snapshot, "right", now).state;
    state = transitionFleet(state, snapshot, "right", now).state;
    state = transitionFleet(state, snapshot, "enter", now).state;
    expect(state.listView).toBe("history");
    expect(visible(snapshot, state)).toEqual(["old"]);
    state = transitionFleet({ ...state, draft: "/view live" }, snapshot, "enter", now).state;
    expect(state.listView).toBe("live");
    expect(visible(snapshot, state)).toEqual(["live", "old"]);
    const decoder = new FleetKeyDecoder();
    expect(decoder.push(Buffer.from([0x1b]))).toEqual([]);
    expect(decoder.flush()).toEqual(["escape"]);
    expect(decoder.push(Buffer.from([0x09]))).toEqual(["tab"]);
  });
  it("spawns in the displayed composer cwd from structural focus without inheriting a hidden thread's sandbox", () => {
    const thread = worker("one", "working"), snapshot = { threads: [thread] };
    const state: FleetState = { ...createFleetState(snapshot, "/different-fallback"), focusedViewControl: "live", draft: "Run the visible task",
      launchProfiles: { "/repo": { provider: "codex", model: "gpt-6.1-sol", effort: "max" } } };
    const transition = transitionFleet(state, snapshot, "enter", now);
    expect(transition.action).toMatchObject({ type: "start", request: { cwd: "/repo", model: "gpt-6.1-sol", effort: "max", sandbox: "read-only" } });
    expect(state.workingDirectory).toBeUndefined();
  });
  it("restores the History view with useful defaults while preserving explicit history folds", () => {
    const snapshot = { threads: [worker("old", "exited")] }, preferences = { view: "history" as const, replies: {} };
    const restored = restoreVisitPreferences(createFleetState(snapshot), snapshot, preferences, {});
    expect(visible(snapshot, restored)).toEqual(["old"]);
    const folded = restoreVisitPreferences(createFleetState(snapshot), snapshot, preferences,
      { "/repo": { collapsed: false, expanded: false, historyExpanded: false } });
    expect(visible(snapshot, folded)).toEqual([]);
    expect(fleetListRows(snapshot, folded)).toContainEqual({ kind: "history", cwd: "/repo", threadCount: 1, expanded: false });
    expect(restoreVisitPreferences(createFleetState({ threads: [] }), { threads: [] }, preferences, {}).focusedViewControl).toBe("history");
  });
});

describe("Fleet meaningful reply watermarks", () => {
  it("establishes a first-visit baseline even for settled historical assistant replies", () => {
    const snapshot = { threads: [worker("old", "exited")] };
    const state = createFleetState(snapshot);
    expect(isUnreadThread(state, "old")).toBe(false);
    expect(renderFleet(snapshot, state, options())).not.toContain("Since your last visit");
  });
  it("does not advertise unchanged historical content when native capture warms up after first visit", () => {
    const cold = worker("old", "unknown", 0, "Historical assistant prose already in the index.");
    delete cold.record.latestPreviewKind;
    const baseline = createFleetState({ threads: [cold] });
    const warmed = worker("old", "idle", 4, cold.record.latestPreview);
    expect(isUnreadThread(normalizeState(baseline, { threads: [warmed] }, now), "old")).toBe(false);
    const backfilled = worker("old", "idle", 4, "A revised historical native preview.");
    expect(isUnreadThread(normalizeState(baseline, { threads: [backfilled] }, now), "old")).toBe(false);
  });
  it("marks a changed canonical assistant reply unread and preserves it through quiet refreshes", () => {
    const before = { threads: [worker("one", "working")] };
    const after = reply(before);
    const state = normalizeState(createFleetState(before), after, now);
    expect(isUnreadThread(state, "one")).toBe(true);
    const missingTruth = { threads: [{ record: after.threads[0]!.record }] };
    expect(isUnreadThread(normalizeState(state, missingTruth, now), "one")).toBe(true);
    expect(normalizeState(state, after, now).replyWatermarks).toBe(state.replyWatermarks);
    expect(renderFleet(after, state, options())).toContain("* Task one");
  });
  it("tracks a resumed process generation without treating a stale snapshot as another reply", () => {
    const old = worker("one", "working", 5); old.record.generation = 1;
    const baseline = createFleetState({ threads: [old] });
    const resumed = worker("one", "idle", 1, "A response from the resumed generation."); resumed.record.generation = 2;
    const state = normalizeState(baseline, { threads: [resumed] }, now);
    expect(isUnreadThread(state, "one")).toBe(true);
    expect(state.replyWatermarks?.one?.generation).toBe(2);
    expect(normalizeState(state, { threads: [old] }, now).replyWatermarks?.one?.latest).toBe(resumed.record.latestPreview);
  });
  it("selects History through the ordinary slash palette keyboard path", () => {
    const snapshot = { threads: [worker("old", "exited")] };
    let state = createFleetState(snapshot);
    for (const key of ["/", ..."view", "enter", ..."history", "enter"]) state = transitionFleet(state, snapshot, key, now).state;
    expect(state.listView).toBe("history"); expect(state.commandPalette).toBeUndefined();
    expect(visible(snapshot, state)).toEqual(["old"]);
  });
  it("does not manufacture replies from input, activity, lifecycle, model or chrome changes", () => {
    const before = { threads: [worker("one", "working")] };
    const baseline = createFleetState(before);
    for (const after of [
      { threads: [{ ...before.threads[0]!, record: { ...before.threads[0]!.record, updatedAt: "2026-10-14T12:05:00.000Z", meaningfulUpdatedAt: "2026-10-14T12:05:00.000Z" } }] },
      { threads: [{ ...before.threads[0]!, workerTruth: { ...before.threads[0]!.workerTruth!, state: "idle" as const } }] },
      reply(before, before.threads[0]!.record.latestPreview!),
      reply(before, "Tip: Try the Desktop app. Run 'codex app' or visit"),
      { threads: [{ ...reply(before).threads[0]!, workerTruth: { ...before.threads[0]!.workerTruth!, canonicalTurns: 0 } }] },
      { threads: [{ ...before.threads[0]!, record: { ...before.threads[0]!.record, model: "gpt-6-astra" } }] },
    ]) expect(isUnreadThread(normalizeState(baseline, after, now), "one")).toBe(false);
  });
  it("rejects prompt fallbacks even when a cancelled canonical receipt advanced the counter", () => {
    const before = { threads: [worker("one", "working", 0, "")] };
    const cancelled = worker("one", "idle", 1, "The user's new prompt"); cancelled.record.latestPreviewKind = "prompt";
    const state = normalizeState({ ...createFleetState(before), expandedHistoryCwds: ["/repo"] }, { threads: [cancelled] }, now);
    expect(isUnreadThread(state, "one")).toBe(false);
    expect(renderSelectedDetail({ threads: [cancelled] }, state, options(), 10).join("\n")).toContain("No response yet");
    const legacy = worker("one", "idle", 1, "Unattributed prose"); delete legacy.record.latestPreviewKind;
    expect(isUnreadThread(normalizeState(state, { threads: [legacy] }, now), "one")).toBe(false);
  });
  it("defers a turn-only delta until changed assistant content arrives", () => {
    const before = { threads: [worker("one", "working")] };
    const countOnly = reply(before, before.threads[0]!.record.latestPreview!);
    let state = normalizeState(createFleetState(before), countOnly, now);
    expect(isUnreadThread(state, "one")).toBe(false);
    state = normalizeState(state, reply(before), now);
    expect(isUnreadThread(state, "one")).toBe(true);
  });
  it("does not silently consume a later changed reply that returns to an earlier seen preview", () => {
    const first = { threads: [worker("one", "working", 1, "Reply A")] };
    let state = normalizeState(createFleetState(first), { threads: [worker("one", "idle", 2, "Reply B")] }, now);
    state = normalizeState(state, { threads: [worker("one", "idle", 3, "Reply A")] }, now);
    expect(isUnreadThread(state, "one")).toBe(true);
    expect(isUnreadThread(markThreadRead(state, "one"), "one")).toBe(false);
  });
  it("uses an empty baseline for missing/legacy data and waits for native evidence", () => {
    const thread = worker("legacy", "unknown", 0, ""); delete thread.workerTruth;
    let state = createFleetState({ threads: [thread] });
    expect(state.replyWatermarks?.legacy?.seen).toBeNull();
    state = normalizeState(state, { threads: [{ record: { ...thread.record, latestPreview: "A prompt-shaped legacy fallback" } }] }, now);
    expect(isUnreadThread(state, "legacy")).toBe(false);
    state = normalizeState(state, { threads: [worker("legacy", "idle", 1, "A canonical assistant response.")] }, now);
    expect(isUnreadThread(state, "legacy")).toBe(true);
  });
  it("does not consume replies on cursor traversal or footer rendering; explicit inspection does", () => {
    const before = { threads: [worker("one", "working"), worker("two", "working")] }, after = reply(before);
    let state = normalizeState(createFleetState(before), after, now);
    state = transitionFleet(state, after, "down", now).state;
    renderFleet(after, state, options());
    expect(isUnreadThread(state, "one")).toBe(true);
    expect(isUnreadThread(state, "two")).toBe(true);
    state = transitionFleet({ ...state, draft: "/read" }, after, "enter", now).state;
    expect(isUnreadThread(state, "two")).toBe(false);
    expect(isUnreadThread(state, "one")).toBe(true);
    expect(state.notice).toContain("A new meaningful assistant reply");
    state = markThreadRead(state, "one");
    expect(isUnreadThread(state, "one")).toBe(false);
  });
  it("bounds Since your last visit to three navigable threads and reveals a historical target", () => {
    const before = { threads: Array.from({ length: 5 }, (_, index) => worker(String(index), "idle")) }, after = reply(before);
    const state = normalizeState(createFleetState(before), after, now);
    const updates = fleetListRows(after, state).filter((row) => row.kind === "update");
    expect(updates).toHaveLength(3);
    const focused = focusRow(state, updates[0]);
    const navigated = transitionFleet(focused, after, "enter", now).state;
    expect(navigated.selectedSessionId).toBe(updates[0]!.thread.record.id);
    expect(threadFocusInert(navigated)).toBe(false);
    expect(visible(after, navigated)).toContain(navigated.selectedSessionId);
    expect(isUnreadThread(navigated, navigated.selectedSessionId!)).toBe(true);
    const unreadView = transitionFleet({ ...state, draft: "/view unread" }, after, "enter", now).state;
    expect(visible(after, unreadView)).toHaveLength(5);
  });
});

describe("Fleet compact rows, detail and interaction height", () => {
  it.each([32, 50, 60, 65, 100, 160])("keeps literal status, provenance and a useful name within %i columns", (width) => {
    const thread = worker("one", "provider-limit"); thread.record.name = "Investigate checkout race and preserve user inputs";
    thread.coordination = { sessionId: "one", subjectId: "one", origin: { creatorControllerId: "orc", taskId: "task", threadId: "one", createdAt: NOW },
      currentController: { controllerId: "orc", familyId: "family", scope: "fleet" }, leaseHealth: "active", orphaned: false, adoptable: false };
    const snapshot = { threads: [thread] };
    const rendered = renderFleet(snapshot, createFleetState(snapshot), options(width, 30));
    const row = rendered.split("\n").find((line) => line.startsWith("▌ ·"))!;
    expect(row).toContain("Provider limit");
    expect(row).toContain("Investig");
    expect(row.trim().at(-1)).not.toMatch(/[\da-z]/iu);
    for (const line of rendered.split("\n")) expect(printedWidth(line)).toBeLessThanOrEqual(width);
  });
  it("reveals full observed model/effort, worktree, owner, assistant preview and Unknown detail", () => {
    const thread = worker("one", "unknown"); thread.record.cwd = "/private/tmp/工程-é";
    const snapshot = { threads: [thread] }, state = createFleetState(snapshot);
    const detail = renderSelectedDetail(snapshot, state, options(), 10).join("\n");
    for (const value of ["Task one", "gpt-6.1-sol · max", "cwd /private/tmp/工程-é", "owner operator", "No recognized current input surface", "The original assistant reply."]) expect(detail).toContain(value);
    delete thread.record.observedModel;
    expect(renderSelectedDetail(snapshot, state, options(), 10).join("\n")).toContain("~gpt-6.1-sol · max");
  });
  it("uses available detail height for a full long Unicode task title", () => {
    const thread = worker("one", "working"); thread.record.name = "工程".repeat(36);
    const snapshot = { threads: [thread] }, state = createFleetState(snapshot);
    const detail = renderSelectedDetail(snapshot, state, options(), 10);
    expect(detail.slice(1, 4).join("")).toBe(thread.record.name);
    expect(detail.join("\n")).toContain("gpt-6.1-sol · max");
    expect(detail.join("\n")).toContain("owner operator");
  });
  it("explains why a queued idle thread remains actionable", () => {
    const thread = worker("one", "idle"); thread.workerTruth!.pendingInstructions = 2;
    thread.workerTruth!.detail = "Idle with 2 instructions accepted but not yet submitted";
    const snapshot = { threads: [thread] };
    expect(renderSelectedDetail(snapshot, createFleetState(snapshot), options(), 10).join("\n").replace(/\s+/gu, " ")).toContain("accepted but not yet submitted");
  });
  it("does not describe an unattributed legacy worker as dispatched by an orchestrator", () => {
    const thread = worker("one", "working");
    thread.coordination = { sessionId: "one", subjectId: "one", origin: { creatorControllerId: LEGACY_CREATOR_CONTROLLER_ID, taskId: "task", threadId: "one", createdAt: NOW },
      leaseHealth: "orphaned", orphaned: true, adoptable: false };
    const snapshot = { threads: [thread] };
    const detail = renderSelectedDetail(snapshot, createFleetState(snapshot), options(), 10).join("\n");
    expect(detail).toContain("owner unattributed"); expect(detail).not.toContain("dispatched by an orchestrator");
  });
  it("keeps observed model names on healthy compact rows when a sibling has a custody conflict", () => {
    const healthy = worker("healthy", "working"), conflicted = worker("conflict", "failed");
    conflicted.record.name = "Investigate launch";
    conflicted.coordination = { sessionId: "conflict", subjectId: "conflict", origin: { creatorControllerId: "orc", taskId: "task", threadId: "conflict", createdAt: NOW },
      currentController: { controllerId: "orc", familyId: "family", scope: "fleet" }, leaseHealth: "contested", orphaned: false, adoptable: false };
    const snapshot = { threads: [healthy, conflicted] };
    const rows = renderFleet(snapshot, createFleetState(snapshot), options()).split("\n");
    expect(rows.find((row) => row.startsWith("▌ •"))).toContain("Sol 6.1");
    expect(rows.find((row) => row.includes("Investigate launch"))!).toContain("conflict");
  });
  it.each([[60, 50], [100, 45], [160, 55], [32, 18], [20, 7], [2, 2], [1, 1]])("bounds every row and the frame at %ix%i, including draft/help/confirmation", (width, height) => {
    const snapshot = { threads: [worker("one", "unknown"), worker("old", "exited")] }, state = createFleetState(snapshot);
    for (const mode of [state, { ...state, helpOpen: true }, { ...state, draft: "工程 👩‍💻\n".repeat(24) },
      { ...state, notice: "Delete this exact thread? press ctrl+x again", noticeTone: "confirmation" as const }]) {
      for (const color of [false, true]) {
        const body = renderFleet(snapshot, mode, { ...options(width, height), color });
        expect(body.split("\n")).toHaveLength(height);
        for (const row of body.split("\n")) expect(printedWidth(row)).toBeLessThanOrEqual(width);
        const cursor = composerCursor(body, mode, width);
        expect(cursor).toBeDefined();
        expect(cursor!.row).toBeLessThanOrEqual(height); expect(cursor!.column).toBeLessThanOrEqual(width);
      }
    }
  });
  it("yields detail to help, multiline drafts and confirmations, and scrolls narrow help", () => {
    const snapshot = { threads: [worker("one", "unknown")] }, state = createFleetState(snapshot);
    for (const mode of [{ ...state, helpOpen: true }, { ...state, draft: "one\ntwo" }, { ...state, notice: "Confirm exact target" }]) expect(renderSelectedDetail(snapshot, mode, options(), 10)).toEqual([]);
    let help = transitionFleet(state, snapshot, "?", now).state;
    const top = renderFleet(snapshot, help, options(32, 18));
    help = transitionFleet(help, snapshot, "end", now).state;
    const bottom = renderFleet(snapshot, help, options(32, 18));
    expect(top).toContain("pgup/dn page"); expect(bottom).toContain("ctrl+x stop"); expect(bottom).toContain("? close");
    help = prepareFleetFrame(snapshot, help, options(32, 18)).state;
    expect(transitionFleet(help, snapshot, "up", now).state.helpScrollOffset).toBe(help.helpScrollOffset! - 1);
  });
});

describe("Fleet runtime read/view preferences", () => {
  it.each(["attached", "rejected", "ended-before-replay"] as const)("marks content read only after actual attachment presentation (%s)", async (outcome) => {
    class Input extends EventEmitter {
      isTTY = true; isRaw = false;
      setRawMode(raw: boolean) { this.isRaw = raw; }
      pause() {} resume() {}
    }
    const snapshot = { threads: [worker("one", "working", 2, "The new assistant reply.")] };
    let preferences: FleetVisitPreferences = { view: "live", replies: { one: { seen: "An earlier reply.", latest: "The new assistant reply.", canonicalTurns: 2 } } };
    const listeners = new Set<(frame: ServerFrame) => void>();
    const input = new Input();
    let screen = "";
    const output = { isTTY: false, columns: 60, rows: 30, write(chunk: string | Uint8Array) { screen += String(chunk); } };
    const transport = {
      fleetProjection: true,
      request: vi.fn(async (method: string, params: unknown) => {
        if (method === "fleet.snapshot") return { kind: "full", version: "one", snapshot };
        if (method === "fleet.visit") return structuredClone(preferences);
        if (method === "fleet.visit.set") { const change = params as FleetVisitPreferences; preferences = { ...preferences, ...change, replies: { ...preferences.replies, ...change.replies } }; return { saved: true }; }
        if (method === "fleet.folderDispositions" || method === "fleet.preferences") return {};
        if (method === "fleet.nvimLayout") return false;
        if (method === "session.attach") {
          if (outcome === "rejected") throw new Error("Controlled elsewhere");
          if (outcome === "ended-before-replay") for (const listener of [...listeners]) listener({ type: "session-ended", sessionId: "one", exitCode: 0 });
          return { data: Buffer.from("The new assistant reply.").toString("base64"), session: snapshot.threads[0]!.record };
        }
        if (method === "worker.capabilities" || method === "orchestrator.capabilities") return [];
        if (method === "fleet.subscribe" || method === "fleet.unsubscribe") return {};
        throw new Error(`Unexpected ${method}`);
      }),
      onFrame(listener: (frame: ServerFrame) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onClose: () => () => {}, sendFrame: vi.fn(), close: vi.fn(),
    };
    const running = runFleet(transport as never, input, output, new EventEmitter());
    try {
      await vi.waitFor(() => expect(screen).toContain("1 unread"));
      expect(preferences.replies.one?.seen).toBe("An earlier reply.");
      input.emit("data", Buffer.from("\r"));
      await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.attach", expect.objectContaining({ sessionId: "one" })));
      if (outcome === "attached") {
        await vi.waitFor(() => expect(input.isRaw).toBe(true));
        input.emit("data", Buffer.from([0x1d]));
        await vi.waitFor(() => expect(preferences.replies.one?.seen).toBe("The new assistant reply."));
      } else if (outcome === "rejected") {
        await vi.waitFor(() => expect(screen).toContain("Controlled elsewhere"));
        expect(preferences.replies.one?.seen).toBe("An earlier reply.");
      } else {
        await vi.waitFor(() => expect(input.isRaw).toBe(true));
        expect(preferences.replies.one?.seen).toBe("An earlier reply.");
      }
    } finally {
      input.emit("data", Buffer.from([0x03, 0x03]));
      await running;
    }
    expect(listeners.size).toBe(0);
  });
});
