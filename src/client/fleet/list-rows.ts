import { prepared } from "./frame-cache.js";
import type { FleetWorkerCoordinationView } from "../../broker/worker-coordination-view.js";
import type { SessionRecord } from "../../domain/session.js";
import { leaseCustody, leaseCustodyBadge, leaseCustodySummary, uniformLeaseCustody, type LeaseCustody, type LeaseCustodyBadge, } from "../lease-custody.js";
import { fleetOwnerSigils, workerOwner, workerOwnerSigil, type OwnerSigils, } from "../owner-sigil.js";
import { FOLDER_THREAD_CAP, ORCS_SECTION_KEY, ORCS_SECTION_LABEL, WORKERS_SECTION_LABEL } from "./constants.js";
import { groupThreads, orchestratorThreads, worktreeTag } from "./list-groups.js";
import { FleetSnapshot, FleetState, FleetThread } from "./state.js";
import { isLiveThread, isUnreadThread, unreadThreads } from "./visit-state.js";
import { isHistoricalThread, threadRuntimePresence } from "./runtime-presence.js";
import { pendingLifecycleThreads } from "./lifecycle-state.js";
import { currentSessionRows } from "./current-sessions.js";

export function isTerminalSession(record: SessionRecord): boolean {
  if (record.executionState === "active" || record.executionState === "starting") return false;
  return record.exitCode !== null;
}

export function orderedThreads(snapshot: FleetSnapshot): FleetThread[] {
  return prepared([snapshot, "orderedThreads"], () => {
    return [
      ...orchestratorThreads(snapshot.threads),
      ...groupThreads(snapshot).flatMap(({ threads }) => threads),
    ];
  });
}

/**
 * One navigable line of the fleet list. Folder headers and show-more rows are rows in
 * their own right: focus lands on them, and Enter there collapses or expands the folder.
 */
export type FleetRow =
  | { kind: "views"; }
  | { kind: "history"; cwd: string; threadCount: number; expanded: boolean; }
  | { kind: "update"; thread: FleetThread; }
  | { kind: "lifecycle"; cwd: string; threads: FleetThread[]; expanded: boolean; }
  | { kind: "lifecycle-item"; cwd: string; thread: FleetThread; }
  | { kind: "unconfirmed"; cwd: string; threads: FleetThread[]; expanded: boolean; }
  | {
    kind: "folder";
    cwd: string;
    threadCount: number;
    collapsed?: boolean;
    liveCount?: number;
    historyCount?: number;
    unconfirmedCount?: number;
    noticeCount?: number;
    /** Set on the Orcs header, which names a section rather than a path on disk. */
    label?: string;
  }
  | {
    kind: "thread";
    cwd: string;
    thread: FleetThread;
    /** Absent when custody is healthy, unknown, or already stated by the group rollup. */
    leaseBadge?: LeaseCustodyBadge;
    /** Where under its project the worker lives, when that is not the project root itself. */
    worktree?: string;
    /** The owner's sigil. Absent on a worker nobody dispatched — the operator's own. */
    ownerSigil?: string;
    /** True while an Orc row is selected and this worker is not one of that Orc's. */
    outsideLens?: boolean;
  }
  | {
    kind: "show-more";
    cwd: string;
    /** Zero once the folder is expanded, when the row reads as the way back. */
    hiddenCount: number;
  };

/**
 * Role headings and blank separators occupy a line each, so the viewport has to count them, but
 * neither is a focus target. Keeping them in the same list is what stops the scroll offset and the
 * rendered lines from disagreeing about how tall the list is.
 */
export type FleetListRow =
  | FleetRow
  | { kind: "spacer"; }
  | { kind: "section"; label: string; }
  | { kind: "ownership"; coordination: FleetWorkerCoordinationView; };

export function isCollapsed(state: FleetState, cwd: string): boolean {
  return state.collapsedCwds?.includes(cwd) === true;
}

export function groupIsCollapsed(state: FleetState, cwd: string, threads: readonly FleetThread[]): boolean {
  if (isCollapsed(state, cwd)) return true;
  if (state.openFolderCwds?.includes(cwd) || state.expandedHistoryCwds?.includes(cwd)) return false;
  if (state.focusedHistoryCwd === cwd || state.focusedLifecycleCwd === cwd
    || state.focusedUnconfirmedCwd === cwd || threads.some(({ record }) => record.id === state.revealedHistorySessionId)) return false;
  return (state.listView ?? "live") === "live" && threads.length > 0
    && threads.every(isHistoricalThread) && pendingLifecycleThreads(threads, state).length === 0;
}

function folderRow(cwd: string, threads: FleetThread[], state: FleetState, label?: string): Extract<FleetRow, { kind: "folder" }> {
  return { kind: "folder", cwd, threadCount: threads.length, collapsed: groupIsCollapsed(state, cwd, threads),
    liveCount: threads.filter(isLiveThread).length, historyCount: threads.filter(isHistoricalThread).length,
    unconfirmedCount: threads.filter((thread) => threadRuntimePresence(thread) === "unknown").length,
    noticeCount: pendingLifecycleThreads(threads, state).length, ...(label === undefined ? {} : { label }) };
}

export function isExpanded(state: FleetState, cwd: string): boolean {
  return state.expandedCwds?.includes(cwd) === true;
}

export function historyExpanded(state: FleetState, cwd: string): boolean {
  return state.listView === "history" ? !state.historyViewCollapsedCwds?.includes(cwd)
    : state.expandedHistoryCwds?.includes(cwd) === true;
}

/**
 * The fleet reads top-down as one Orcs roster over the folders its workers live in.
 * Orchestrators are fleet-wide, so they are listed once, flat, ahead of every folder;
 * folders below hold workers only.
 */
export function fleetListRows(snapshot: FleetSnapshot, state: FleetState): FleetListRow[] {
  if (snapshot.currentLayout === "sessions" && (state.listView ?? "live") === "live") return currentSessionRows(snapshot, state);
  return prepared([snapshot, state, "fleetListRows"], () => {
    const orcs = orchestratorThreads(snapshot.threads);
    // One assignment for the whole frame, so an Orc's row and its workers' rows cannot disagree.
    const provenance: FleetProvenance = {
      sigils: snapshotOwnerSigils(snapshot),
      lens: ownershipLensControllerId(snapshot, state),
    };
    const orcRows: FleetListRow[] = orcs.length === 0
      ? []
      : orcSectionRows(orcs, state, provenance);
    const folderRows = groupThreads(snapshot).flatMap(({ cwd, label, threads }, groupIndex): FleetListRow[] => {
      const header = folderRow(cwd, threads, state, label);
      const spacer: FleetListRow[] = groupIndex === 0 && orcRows.length === 0
        ? []
        : [{ kind: "spacer" }];
      if (header.collapsed) return [...spacer, header];
      return [
        ...spacer,
        header,
        ...groupContentRows(threads, state, provenance, cwd, WORKERS_SECTION_LABEL),
      ];
  });
  const updates = unreadThreads(snapshot, state).slice(0, 3);
  return [
    { kind: "views" },
    ...(snapshot.threads.length === 0 ? [{ kind: "section" as const, label: "No durable agent threads yet." }]
      : state.listView === "unread" && unreadThreads(snapshot, state).length === 0
        ? [{ kind: "section" as const, label: "No unread assistant replies." }] : []),
    ...orcRows, ...folderRows,
    ...(updates.length === 0 || state.listView === "unread" ? [] : [
      { kind: "spacer" as const },
      { kind: "section" as const, label: "Since your last visit" },
      ...updates.map((thread) => ({ kind: "update" as const, thread })),
    ]),
  ];
  });
}

/**
 * The global Orcs roster, headed by a row that folds it exactly as a folder header folds a
 * project. A fleet accumulates orchestrators without bound, so the roster is capped the same
 * way too: an unbounded section would shove every folder below it down the screen.
 */
export function orcSectionRows(
  orcs: readonly FleetThread[],
  state: FleetState,
  provenance: FleetProvenance,
): FleetListRow[] {
  const header = folderRow(ORCS_SECTION_KEY, [...orcs], state, ORCS_SECTION_LABEL);
  if (header.collapsed) return [header];
  return [
    header,
    ...groupContentRows(orcs, state, provenance, ORCS_SECTION_KEY),
  ];
}

/** All actionable rows remain visible. Only durable history pays the old show-more cap. */
function groupContentRows(
  threads: readonly FleetThread[], state: FleetState, provenance: FleetProvenance,
  cwd: string, label?: string,
): FleetListRow[] {
  const view = state.listView ?? "live";
  const live = threads.filter(isLiveThread);
  const history = threads.filter(isHistoricalThread);
  const unconfirmed = threads.filter((thread) => threadRuntimePresence(thread) === "unknown");
  const notices = pendingLifecycleThreads(threads, state);
  const visibleLive = view === "unread"
    ? threads.filter(({ record }) => isUnreadThread(state, record.id))
    : view === "history" ? [] : live;
  const rollup = uniformLeaseCustody(threads.map(threadLeaseCustody));
  const revealed = history.find(({ record }) => record.id === state.revealedHistorySessionId);
  const visibleHistory = !historyExpanded(state, cwd) || view === "unread"
    ? [] : isExpanded(state, cwd) ? history : history.slice(0, FOLDER_THREAD_CAP);
  if (revealed !== undefined && view !== "unread" && !visibleHistory.includes(revealed)) visibleHistory.push(revealed);
  return [
    ...(label === undefined || rollup === undefined || rollup.kind === "attached" || threads.length === 0
      ? [] : [{ kind: "section" as const, label: sectionLabel(label, threads.length, rollup) }]),
    ...threadRows(visibleLive, state, rollup, provenance, cwd),
    ...(view === "unread" || unconfirmed.length === 0 ? [] : [
      { kind: "unconfirmed" as const, cwd, threads: unconfirmed, expanded: state.expandedUnconfirmedCwds?.includes(cwd) === true },
      ...(state.expandedUnconfirmedCwds?.includes(cwd) ? threadRows(unconfirmed, state, rollup, provenance, cwd) : []),
    ]),
    ...(view === "unread" || notices.length === 0 ? [] : [
      { kind: "lifecycle" as const, cwd, threads: notices, expanded: state.expandedLifecycleCwds?.includes(cwd) === true },
      ...(state.expandedLifecycleCwds?.includes(cwd) ? notices.map((thread) => ({ kind: "lifecycle-item" as const, cwd, thread })) : []),
    ]),
    ...(history.length === 0 || view === "unread" ? [] : [
      { kind: "history" as const, cwd, threadCount: history.length, expanded: historyExpanded(state, cwd) || revealed !== undefined },
      ...threadRows(visibleHistory, state, rollup, provenance, cwd),
      ...(historyExpanded(state, cwd) && history.length > FOLDER_THREAD_CAP
        ? [{ kind: "show-more" as const, cwd, hiddenCount: history.length - visibleHistory.length }] : []),
    ]),
  ];
}

/**
 * A role heading and the thread rows under it. `all` carries the whole group even when the
 * cap trims what is shown, so the heading keeps describing the folder rather than the slice.
 */
export function sectionRows(
  label: string,
  visible: readonly FleetThread[],
  all: readonly FleetThread[],
  state: FleetState,
  provenance: FleetProvenance,
  root?: string | undefined,
): FleetListRow[] {
  // A section whose workers all share one custody says it once on the heading, and
  // its rows go bare: a badge repeated down the whole group is a column of noise.
  const rollup = uniformLeaseCustody(all.map(threadLeaseCustody));
  return [
    { kind: "section", label: sectionLabel(label, all.length, rollup) },
    ...threadRows(visible, state, rollup, provenance, root),
  ];
}

/** The thread rows of one section, each with the ownership line it owns when detail is on. */
export function threadRows(
  visible: readonly FleetThread[],
  state: FleetState,
  rollup: LeaseCustody | undefined,
  provenance: FleetProvenance,
  root?: string | undefined,
): FleetListRow[] {
  return visible.flatMap((thread): FleetListRow[] => {
    const custody = threadLeaseCustody(thread);
    const badge = rollup !== undefined || custody === undefined
      ? undefined
      : leaseCustodyBadge(custody);
    // A worktree folded into its project says so on its own row; that is what the row costs the
    // section it no longer gets to head.
    const worktree = root === undefined || root.startsWith("/@")
      ? undefined
      : worktreeTag(thread, root);
    const sigil = threadOwnerSigil(thread, provenance.sigils);
    return [
      {
        kind: "thread",
        cwd: thread.record.cwd,
        thread,
        ...(badge === undefined ? {} : { leaseBadge: badge }),
        ...(worktree === undefined ? {} : { worktree }),
        ...(sigil === undefined ? {} : { ownerSigil: sigil }),
        ...(outsideOwnershipLens(thread, provenance.lens) ? { outsideLens: true } : {}),
      },
      ...(state.leaseDetail === true && thread.coordination !== undefined
        && thread.record.kind !== "orchestrator"
        ? [{ kind: "ownership" as const, coordination: thread.coordination }]
        : []),
    ];
  });
}

export function threadLeaseCustody(thread: FleetThread): LeaseCustody | undefined {
  return thread.record.kind === "orchestrator" || thread.coordination === undefined
    ? undefined
    : leaseCustody(thread.coordination);
}

/** One frame's provenance: who wears which sigil, and which Orc the lens is resting on. */
export interface FleetProvenance {
  sigils: OwnerSigils;
  /** The selected Orc's controller identity, or `undefined` when the lens is off. */
  lens?: string | undefined;
}

/**
 * The sigil assignment for one snapshot.
 *
 * Bound orchestrators are seeded from their own session's `createdAt`, which is the only
 * seniority Fleet has locally and is enough for the property that matters: an Orc already on
 * screen does not lose its glyph when another one spawns.
 */
export function snapshotOwnerSigils(snapshot: FleetSnapshot): OwnerSigils {
  return fleetOwnerSigils({
    orchestrators: snapshot.threads.flatMap((thread) =>
      thread.record.kind === "orchestrator" && thread.controllerId !== undefined
        ? [{ controllerId: thread.controllerId, since: thread.record.createdAt }]
        : []),
    workers: snapshot.threads.flatMap((thread) =>
      thread.record.kind === "orchestrator" || thread.coordination === undefined
        ? []
        : [thread.coordination]),
  });
}

/**
 * The sigil one row wears.
 *
 * An Orc wears the sigil of the family it is bound to; a worker wears whatever its lease says,
 * which is the only authority on the question. A worker with no coordination record at all was
 * never registered with a controller — the operator started it themselves — and wears nothing.
 */
export function threadOwnerSigil(thread: FleetThread, sigils: OwnerSigils): string | undefined {
  if (thread.record.kind === "orchestrator") {
    return thread.controllerId === undefined ? undefined : sigils.get(thread.controllerId);
  }
  return thread.coordination === undefined
    ? undefined
    : workerOwnerSigil(thread.coordination, sigils);
}

/**
 * The Orc the ownership lens is resting on, if any.
 *
 * Selection is the whole gesture: moving onto an Orc row filters, moving off restores. There is no
 * mode to be in and no key to remember, so the feature costs nothing when it is not being used —
 * which is the only reason a filter this broad is affordable in a list this dense.
 */
export function ownershipLensControllerId(
  snapshot: FleetSnapshot,
  state: FleetState,
): string | undefined {
  if (threadFocusInert(state) || state.selectedSessionId === undefined) return undefined;
  const selected = snapshot.threads.find(({ record }) => record.id === state.selectedSessionId);
  return selected?.record.kind === "orchestrator" ? selected.controllerId : undefined;
}

/**
 * True for a worker the lens is filtering out.
 *
 * Orc rows never dim: the roster is what the operator is reading the sigil against, and dimming
 * the rest of it would hide the comparison the lens exists to make. An orphaned worker dims like
 * any other row the selected Orc does not own, because it does not own it.
 */
export function outsideOwnershipLens(thread: FleetThread, lens: string | undefined): boolean {
  if (lens === undefined || thread.record.kind === "orchestrator") return false;
  const owner = thread.coordination === undefined
    ? undefined
    : workerOwner(thread.coordination);
  return owner?.kind !== "controlled" || owner.controllerId !== lens;
}

/**
 * A role heading, plus the group's shared lease custody when it has one. Attached is the
 * healthy state and stays unsaid, so the heading only grows when there is something to say.
 */
export function sectionLabel(
  label: string,
  threadCount: number,
  rollup: LeaseCustody | undefined,
): string {
  if (rollup === undefined || rollup.kind === "attached") return label;
  return `${label} (${threadCount} · all ${leaseCustodySummary(rollup)})`;
}

export function focusedListRowIndex(rows: readonly FleetListRow[], state: FleetState): number {
  const index = state.focusedViewControl !== undefined
    ? rows.findIndex((row) => row.kind === "views")
    : state.focusedLifecycleCwd !== undefined
      ? rows.findIndex((row) => row.kind === "lifecycle" && row.cwd === state.focusedLifecycleCwd)
    : state.focusedLifecycleSessionId !== undefined
      ? rows.findIndex((row) => row.kind === "lifecycle-item" && row.thread.record.id === state.focusedLifecycleSessionId)
    : state.focusedUnconfirmedCwd !== undefined
      ? rows.findIndex((row) => row.kind === "unconfirmed" && row.cwd === state.focusedUnconfirmedCwd)
    : state.focusedHistoryCwd !== undefined
      ? rows.findIndex((row) => row.kind === "history" && row.cwd === state.focusedHistoryCwd)
    : state.focusedUpdateSessionId !== undefined
      ? rows.findIndex((row) => row.kind === "update" && row.thread.record.id === state.focusedUpdateSessionId)
    : state.focusedFolderCwd !== undefined
    ? rows.findIndex((row) => row.kind === "folder" && row.cwd === state.focusedFolderCwd)
    : state.focusedShowMoreCwd !== undefined
      ? rows.findIndex((row) => row.kind === "show-more" && row.cwd === state.focusedShowMoreCwd)
      : rows.findIndex((row) => row.kind === "thread" && row.thread.record.id === state.selectedSessionId);
  return Math.max(0, index);
}

/** True while a folder header or show-more row owns the row, leaving thread keys inert. */
export function threadFocusInert(state: FleetState): boolean {
  return state.focusedFolderCwd !== undefined || state.focusedShowMoreCwd !== undefined
    || state.focusedHistoryCwd !== undefined || state.focusedViewControl !== undefined
    || state.focusedUpdateSessionId !== undefined || state.focusedLifecycleCwd !== undefined
    || state.focusedLifecycleSessionId !== undefined || state.focusedUnconfirmedCwd !== undefined;
}

