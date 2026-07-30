import { resolve } from "node:path";
import type { BoundedChanges, WorktreeChangeSet } from "./worktree-changes.js";

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
    entries: quickfixEntries(options.worktree, options.changes),
  };
}

/**
 * Base64 so the payload can be one `--remote-expr` argument with no escaping question at all.
 *
 * A worktree path or a hunk's context line can contain quotes, backslashes, or newlines, every one
 * of which would otherwise have to survive both Vim expression parsing and argv. Base64's alphabet
 * contains none of them, so there is nothing left to get wrong.
 */
export function encodeNvimPayload(request: NvimWorktreeRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64");
}

export function decodeNvimPayload(encoded: string): NvimWorktreeRequest {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as NvimWorktreeRequest;
}
