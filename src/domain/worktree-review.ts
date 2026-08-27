import { resolve } from "node:path";
import type { SessionRecord } from "./session.js";

/** One place the operator can land: a path inside the worktree and a line worth starting at. */
export interface WorktreeChange {
  /** Worktree-relative, exactly as git reported it. */
  path: string;
  line: number;
  text: string;
}

/** The git boundary, injected so every parser above it is testable without a repository. */
export type GitOutput = (args: readonly string[]) => Promise<string>;

/**
 * Which rung of {@link diffBaseline}'s ladder produced a change list.
 *
 * The kind travels with the changes because the operator has to be able to read an empty list
 * correctly: "nothing changed since you branched" and "this directory is not a repository at all"
 * are the same zero entries and completely different facts. The label is what nvim's list title and
 * Fleet's status line render, so it is written to be read, not parsed.
 */
export type WorktreeBaselineKind = "fork-point" | "uncommitted" | "none" | "not-a-repo";

export interface WorktreeBaseline {
  kind: WorktreeBaselineKind;
  /** Short enough to sit in a title beside the worker's name. */
  label: string;
  /**
   * The revision the change list was measured against, when the rung has one.
   *
   * The label says *which* baseline in words; this says which commit, so the nvim side can show a
   * file against it rather than only listing that it moved. It is a resolved object name rather
   * than a ref name — `HEAD` and a branch tip both move while the operator is reading — so a diff
   * taken minutes later is still the diff the list described. Absent on the rungs with nothing to
   * compare against, which is why nvim has to check rather than assume.
   */
  rev?: string;
}

/** What survived {@link MAX_WORKTREE_CHANGES}, before a baseline is attached to it. */
export interface BoundedChanges {
  changes: readonly WorktreeChange[];
  /** How many entries were dropped by {@link MAX_WORKTREE_CHANGES}. */
  dropped: number;
}

export interface WorktreeChangeSet extends BoundedChanges {
  baseline: WorktreeBaseline;
}

/**
 * The two things Cyberdeck ever asks nvim to do. Each names a function in the shipped Lua module
 * `contrib/nvim/lua/cyberdeck/init.lua`; nothing else in that module is part of the contract.
 *
 * There is no separate "release" call: the completion refresh already carries `live: false`, so the
 * new list and the lifting of read-only are one message driven by one state transition, and they
 * cannot land out of order or one without the other.
 */
export type NvimEntryPoint = "open" | "refresh";

/** Exactly the fields nvim's `setqflist`/`setloclist` item dictionaries accept. */
export interface QuickfixEntry {
  filename: string;
  lnum: number;
  col: number;
  text: string;
}

export interface NvimWorktreeRequest {
  /**
   * Which worker this request is about.
   *
   * The worktree cannot stand in for it. Worktrees nest — a worker running under another worker's
   * worktree shares its whole path prefix — so a guard keyed by path alone cannot tell two
   * overlapping workers apart, and releasing the outer one would unlock the inner one's files.
   */
  session: string;
  worktree: string;
  title: string;
  /**
   * True while the worker owning this worktree is still running. It drives read-only enforcement
   * on the nvim side, and it is the same flag the completion refresh flips back.
   */
  live: boolean;
  /**
   * What the entries were measured from, in full rather than as the phrase folded into the title.
   *
   * The title is written to be read; this is written to be acted on. Cyberdeck is the only side
   * that knows which rung of the ladder produced the list and which commit that rung resolved to,
   * so it sends both and leaves how a file is shown against them to the operator's config. See
   * `docs/architecture/nvim-surface.md` for where that line falls and why.
   */
  baseline: WorktreeBaseline;
  entries: readonly QuickfixEntry[];
}

/**
 * Entries carry absolute paths even though the tab is `tcd`-scoped to the worktree.
 *
 * A relative entry resolves against whatever directory the window happens to be in when the
 * operator jumps, and nvim's per-tab cwd is exactly the thing that is not global. Resolving here,
 * once, against the worktree Cyberdeck already knows exactly, removes the question entirely.
 */
export function quickfixEntries(worktree: string, changes: BoundedChanges): QuickfixEntry[] {
  return changes.changes.map((change) => ({
    filename: resolve(worktree, change.path),
    lnum: change.line,
    col: 1,
    text: change.text,
  }));
}

export function worktreeRequest(options: {
  session: string;
  worktree: string;
  subject: string;
  live: boolean;
  changes: WorktreeChangeSet;
}): NvimWorktreeRequest {
  const suffix = options.changes.dropped === 0 ? "" : ` (+${options.changes.dropped} more)`;
  return {
    session: options.session,
    worktree: options.worktree,
    // The baseline is in the title because a list the operator cannot attribute is worse than no
    // list: an empty one has to say whether nothing changed, nothing could be compared against, or
    // there was no repository, and a full one has to say what "changed" was measured from.
    title: `Cyberdeck · ${options.subject} · ${options.changes.baseline.label}${suffix}`,
    live: options.live,
    baseline: options.changes.baseline,
    entries: quickfixEntries(options.worktree, options.changes),
  };
}

/**
 * Live means a provider process can still be writing to the worktree.
 *
 * `starting` counts as live: the process is about to exist, and opening its worktree writable for
 * the seconds before it does is exactly the window in which a co-edit is silently lost.
 */
export function isWorkerLive(record: Pick<SessionRecord, "executionState">): boolean {
  return record.executionState === "active" || record.executionState === "starting";
}

/** What a worker row calls itself in nvim's list title. */
export function worktreeSubject(record: Pick<SessionRecord, "id" | "name">): string {
  const name = record.name?.trim();
  return name === undefined || name === "" ? record.id.slice(0, 8) : name;
}
