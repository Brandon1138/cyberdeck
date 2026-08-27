import { basename } from "node:path";
import type { SessionRecord } from "../../domain/session.js";
import { UNREGISTERED_SECTION_KEY, UNREGISTERED_SECTION_LABEL } from "./constants.js";
import { FleetListRow, FleetRow, focusedListRowIndex, isCollapsed, isExpanded } from "./list-rows.js";
import { FleetSnapshot, FleetState, FleetThread, FleetTransition } from "./state.js";

export function navigableListRowIndex(
  rows: readonly FleetListRow[],
  targetIndex: number,
  direction: -1 | 1,
): number {
  if (rows.length === 0) return -1;
  const target = Math.max(0, Math.min(rows.length - 1, targetIndex));
  for (
    let index = target;
    index >= 0 && index < rows.length;
    index += direction
  ) {
    if (isFocusableListRow(rows[index])) return index;
  }
  for (
    let index = target - direction;
    index >= 0 && index < rows.length;
    index -= direction
  ) {
    if (isFocusableListRow(rows[index])) return index;
  }
  return -1;
}

export function isFocusableListRow(row: FleetListRow | undefined): row is FleetRow {
  return row?.kind === "folder" || row?.kind === "thread" || row?.kind === "show-more";
}

export function focusRow(state: FleetState, row: FleetListRow | undefined): FleetState {
  if (!isFocusableListRow(row)) return state;
  if (row.kind === "folder") {
    return { ...state, focusedFolderCwd: row.cwd, focusedShowMoreCwd: undefined };
  }
  if (row.kind === "show-more") {
    return { ...state, focusedFolderCwd: undefined, focusedShowMoreCwd: row.cwd };
  }
  return {
    ...state,
    focusedFolderCwd: undefined,
    focusedShowMoreCwd: undefined,
    selectedSessionId: row.thread.record.id,
  };
}

export function clampThreadListScrollOffset(
  offset: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  if (viewportHeight <= 0 || contentHeight <= viewportHeight) return 0;
  return Math.max(0, Math.min(contentHeight - viewportHeight, offset));
}

export function scrollFocusedRowIntoView(
  state: FleetState,
  rows: readonly FleetListRow[],
  viewportHeight: number,
): FleetState {
  const focusedIndex = focusedListRowIndex(rows, state);
  let offset = clampThreadListScrollOffset(
    state.threadListScrollOffset,
    rows.length,
    viewportHeight,
  );
  if (focusedIndex < offset) {
    offset = focusedIndex;
  } else if (focusedIndex >= offset + viewportHeight) {
    offset = focusedIndex - viewportHeight + 1;
  }
  offset = clampThreadListScrollOffset(offset, rows.length, viewportHeight);
  return { ...state, threadListScrollOffset: offset };
}

export function setCollapsed(state: FleetState, cwd: string, collapsed: boolean): FleetState {
  const current = state.collapsedCwds ?? [];
  if (current.includes(cwd) === collapsed) return state;
  return {
    ...state,
    collapsedCwds: collapsed
      ? [...current, cwd]
      : current.filter((candidate) => candidate !== cwd),
  };
}

export function setExpanded(state: FleetState, cwd: string, expanded: boolean): FleetState {
  const current = state.expandedCwds ?? [];
  if (current.includes(cwd) === expanded) return state;
  return {
    ...state,
    expandedCwds: expanded
      ? [...current, cwd]
      : current.filter((candidate) => candidate !== cwd),
  };
}

/**
 * A fold is a standing operator decision, not view state, so each toggle writes through to the
 * preference store. Arrow keys repeat against a folder that is already folded, and an append-only
 * store would take a line for every one of those, so a toggle that changed nothing stays silent.
 */
export function foldTransition(state: FleetState, next: FleetState, cwd: string): FleetTransition {
  const settled: FleetState = { ...next, deleteConfirmation: undefined, notice: undefined };
  if (next === state) return { state: settled };
  return {
    state: settled,
    action: {
      type: "folder-disposition",
      cwd,
      disposition: { collapsed: isCollapsed(next, cwd), expanded: isExpanded(next, cwd) },
    },
  };
}

export function threadSubject(record: SessionRecord): string {
  return record.kind === "orchestrator" ? "orchestrator" : "thread";
}

/** Last activity, the fleet's ordering key. Falls back for records that never reported one. */
export function lastActivity(record: SessionRecord): string {
  return record.meaningfulUpdatedAt ?? record.updatedAt;
}

/**
 * Pinned threads first, then most recent first within each group.
 *
 * A pin is a standing operator decision that a thread stays where it can be seen; recency is the
 * fleet's own guess at what matters now. A pin that only broke ties lost to the first sibling that
 * reported newer activity, which is the same as not having pinned at all — so the pin outranks
 * recency outright. Below both, ties fall back to explicit reorder and then age, so threads that
 * share a timestamp still hold a stable position.
 */
export function byRecency(left: FleetThread, right: FleetThread): number {
  // `pinned` is optional, so an unpinned thread is `false` on one record and absent on another.
  // Comparing the raw fields would rank those two against each other.
  const leftPinned = left.record.pinned === true;
  const rightPinned = right.record.pinned === true;
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  const recency = lastActivity(right.record).localeCompare(lastActivity(left.record));
  if (recency !== 0) return recency;
  const leftOrder = left.record.displayOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.record.displayOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return left.record.createdAt.localeCompare(right.record.createdAt);
}

/** Every orchestrator in the fleet as one flat roster, whatever folder each was launched in. */
export function orchestratorThreads(threads: readonly FleetThread[]): FleetThread[] {
  return threads
    .filter(({ record }) => record.kind === "orchestrator")
    .sort(byRecency);
}

/** One section of the worker list: a registered project, the unregistered bucket, or a folder. */
export interface FleetFolder {
  cwd: string;
  threads: FleetThread[];
  /** Set on the unregistered bucket, which names a condition rather than a path on disk. */
  label?: string;
}

/**
 * The registered root a directory belongs to, longest first.
 *
 * Longest wins so a project nested inside another still claims its own threads, and the match is
 * taken at a path separator so `/repo-two` is never swallowed by `/repo`.
 */
export function projectRootFor(cwd: string, projects: readonly string[]): string | undefined {
  let match: string | undefined;
  for (const root of projects) {
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    if (match === undefined || root.length > match.length) match = root;
  }
  return match;
}

/**
 * Which project a worker belongs to, which is not always where it is running.
 *
 * A worktree Cyberdeck provisioned is a *sibling* of the repository it was cut from, so nothing
 * about its path puts it under a registered project root. The workspace the broker recorded says
 * which repository it belongs to, and that is the section the operator looks for it in — a worker
 * on a Cyberdeck branch reads as Cyberdeck work, not as a stray root named after a branch.
 */
export function sectionPath(thread: FleetThread): string {
  return thread.record.workspace?.repositoryPath ?? thread.record.cwd;
}

/**
 * What a worker's row says about where under its project it actually lives.
 *
 * A worktree under the project root names itself relatively, which is both short and true. A
 * provisioned sibling worktree has no such relative name, so it says its own directory name — the
 * one Cyberdeck's naming policy derived from the branch, and the one `cd` takes.
 */
export function worktreeTag(thread: FleetThread, root: string): string | undefined {
  const cwd = thread.record.cwd;
  if (cwd === root) return undefined;
  if (cwd.startsWith(`${root}/`)) return cwd.slice(root.length + 1);
  const worktreePath = thread.record.workspace?.worktreePath;
  return worktreePath === undefined ? undefined : basename(worktreePath);
}

/**
 * Workers by section.
 *
 * With a registry, a section is a project the operator named: every per-task worktree under it
 * folds into it and says which worktree on its own row, and a registered project holds its
 * section open even with nothing in it. Threads under no registered root land in one bucket
 * rather than disappearing — the operator has to be able to find work to finish it.
 *
 * Without a registry the fleet falls back to one folder per working directory, alphabetical by
 * absolute path so the list reads in the same order as `ls`.
 */
export function groupThreads(snapshot: FleetSnapshot): FleetFolder[] {
  const workers = snapshot.threads.filter(({ record }) => record.kind !== "orchestrator");
  const projects = snapshot.projects;
  if (projects === undefined) {
    const groups = new Map<string, FleetThread[]>();
    for (const thread of workers) {
      const group = groups.get(thread.record.cwd) ?? [];
      group.push(thread);
      groups.set(thread.record.cwd, group);
    }
    return [...groups.entries()]
      .map(([cwd, entries]) => ({ cwd, threads: entries.sort(byRecency) }))
      .sort((left, right) => left.cwd.localeCompare(right.cwd));
  }
  const roots = [...new Set(projects)].sort((left, right) => left.localeCompare(right));
  const groups = new Map<string, FleetThread[]>(roots.map((root) => [root, []]));
  const unregistered: FleetThread[] = [];
  for (const thread of workers) {
    const root = projectRootFor(sectionPath(thread), roots) ?? projectRootFor(thread.record.cwd, roots);
    if (root === undefined) unregistered.push(thread);
    else groups.get(root)!.push(thread);
  }
  return [
    ...[...groups.entries()].map(([cwd, entries]) => ({ cwd, threads: entries.sort(byRecency) })),
    ...(unregistered.length === 0
      ? []
      : [{
        cwd: UNREGISTERED_SECTION_KEY,
        label: UNREGISTERED_SECTION_LABEL,
        threads: unregistered.sort(byRecency),
      }]),
  ];
}

/**
 * The workspace a composer start declares when the folder is set to `worktree`.
 *
 * The branch is named after the task because that is the only thing the operator has said, and it
 * goes under `cyberdeck/` so a repository's branch list keeps saying which branches a fleet made.
 * `HEAD` is the base because the composer starts work from the checkout the operator is looking at,
 * and no guess about a default branch is better than the branch they actually left it on. It stays
 * a declaration of intent: the provisioner resolves it to the commit it named and records *that*,
 * because `HEAD` re-read inside the worktree later is the worktree's own tip. The path is
 * deliberately absent: naming the worktree is Cyberdeck's job, and the broker refuses loudly rather
 * than reusing a directory or a branch that already exists.
 */
