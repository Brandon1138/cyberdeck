import type { FleetWorkerCoordinationView } from "../../broker/worker-coordination-view.js";
import type { SessionRecord } from "../../domain/session.js";
import { leaseCustody, leaseCustodyBadge, leaseCustodySummary, uniformLeaseCustody, type LeaseCustody, type LeaseCustodyBadge, } from "../lease-custody.js";
import { fleetOwnerSigils, workerOwner, workerOwnerSigil, type OwnerSigils, } from "../owner-sigil.js";
import { FOLDER_THREAD_CAP, ORCS_SECTION_KEY, ORCS_SECTION_LABEL, WORKERS_SECTION_LABEL } from "./constants.js";
import { groupThreads, orchestratorThreads, worktreeTag } from "./list-groups.js";
import { FleetSnapshot, FleetState, FleetThread } from "./state.js";

export function isTerminalSession(record: SessionRecord): boolean {
  if (record.executionState === "active" || record.executionState === "starting") return false;
  return record.exitCode !== null;
}

export function orderedThreads(snapshot: FleetSnapshot): FleetThread[] {
  return [
    ...orchestratorThreads(snapshot.threads),
    ...groupThreads(snapshot).flatMap(({ threads }) => threads),
  ];
}

/**
 * One navigable line of the fleet list. Folder headers and show-more rows are rows in
 * their own right: focus lands on them, and Enter there collapses or expands the folder.
 */
export type FleetRow =
  | {
    kind: "folder";
    cwd: string;
    threadCount: number;
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

export function isExpanded(state: FleetState, cwd: string): boolean {
  return state.expandedCwds?.includes(cwd) === true;
}

/**
 * The fleet reads top-down as one Orcs roster over the folders its workers live in.
 * Orchestrators are fleet-wide, so they are listed once, flat, ahead of every folder;
 * folders below hold workers only.
 */
export function fleetListRows(snapshot: FleetSnapshot, state: FleetState): FleetListRow[] {
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
    const header: FleetRow = {
      kind: "folder",
      cwd,
      threadCount: threads.length,
      ...(label === undefined ? {} : { label }),
    };
    const spacer: FleetListRow[] = groupIndex === 0 && orcRows.length === 0
      ? []
      : [{ kind: "spacer" }];
    if (isCollapsed(state, cwd)) return [...spacer, header];
    const visible = isExpanded(state, cwd) ? threads : threads.slice(0, FOLDER_THREAD_CAP);
    return [
      ...spacer,
      header,
      ...sectionRows(WORKERS_SECTION_LABEL, visible, threads, state, provenance, cwd),
      // The row survives expansion so the folder can be rolled back up from the same place.
      ...(threads.length > FOLDER_THREAD_CAP
        ? [{ kind: "show-more" as const, cwd, hiddenCount: threads.length - visible.length }]
        : []),
    ];
  });
  return [...orcRows, ...folderRows];
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
  const header: FleetRow = {
    kind: "folder",
    cwd: ORCS_SECTION_KEY,
    threadCount: orcs.length,
    label: ORCS_SECTION_LABEL,
  };
  if (isCollapsed(state, ORCS_SECTION_KEY)) return [header];
  const visible = isExpanded(state, ORCS_SECTION_KEY) ? orcs : orcs.slice(0, FOLDER_THREAD_CAP);
  return [
    header,
    ...threadRows(visible, state, undefined, provenance),
    ...(orcs.length > FOLDER_THREAD_CAP
      ? [{ kind: "show-more" as const, cwd: ORCS_SECTION_KEY, hiddenCount: orcs.length - visible.length }]
      : []),
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
  const index = state.focusedFolderCwd !== undefined
    ? rows.findIndex((row) => row.kind === "folder" && row.cwd === state.focusedFolderCwd)
    : state.focusedShowMoreCwd !== undefined
      ? rows.findIndex((row) => row.kind === "show-more" && row.cwd === state.focusedShowMoreCwd)
      : rows.findIndex((row) => row.kind === "thread" && row.thread.record.id === state.selectedSessionId);
  return Math.max(0, index);
}

/** True while a folder header or show-more row owns the row, leaving thread keys inert. */
export function threadFocusInert(state: FleetState): boolean {
  return state.focusedFolderCwd !== undefined || state.focusedShowMoreCwd !== undefined;
}

