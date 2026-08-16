import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

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
 * `a/` and `b/` are git's own diff prefixes, not part of the path. `--no-prefix` users get paths
 * with neither, which is why the prefix is stripped rather than assumed.
 */
function stripDiffPrefix(target: string): string {
  return /^[ab]\//u.test(target) ? target.slice(2) : target;
}

interface FileAccumulator {
  path: string;
  deleted: boolean;
  hunks: number;
}

/**
 * Turn a `--unified=0` diff into one entry per hunk.
 *
 * Zero context is what makes a hunk a place rather than a neighbourhood: the `+` start line of a
 * `@@` header is the first line the agent actually touched. A pure deletion carries a new-side
 * count of zero and a start line *before* the removal, which is still the line the operator wants
 * to be sitting on, so it is used as-is and only clamped away from zero.
 *
 * A file that changes without producing a hunk — a binary file, a mode-only change — still gets one
 * entry, because "the agent touched this" is the fact being reported and a hunk is only how.
 */
export function parseUnifiedDiff(diff: string): WorktreeChange[] {
  const changes: WorktreeChange[] = [];
  let previousPath: string | undefined;
  let current: FileAccumulator | undefined;
  const closeFile = () => {
    if (current !== undefined && current.hunks === 0) {
      changes.push({ path: current.path, line: 1, text: current.deleted ? "deleted" : "changed" });
    }
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      const target = line.slice(4).trim();
      previousPath = target === "/dev/null" ? undefined : stripDiffPrefix(target);
      continue;
    }
    if (line.startsWith("+++ ")) {
      closeFile();
      const target = line.slice(4).trim();
      const deleted = target === "/dev/null";
      const path = deleted ? previousPath : stripDiffPrefix(target);
      current = path === undefined ? undefined : { path, deleted, hunks: 0 };
      continue;
    }
    if (current === undefined || !line.startsWith("@@")) continue;
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/u.exec(line);
    if (match === null) continue;
    current.hunks += 1;
    const context = (match[2] ?? "").trim();
    changes.push({
      path: current.path,
      line: Math.max(1, Number(match[1])),
      text: current.deleted ? "deleted" : context === "" ? "changed" : context,
    });
  }
  closeFile();
  return changes;
}

/** `-z` output: NUL-terminated, never quoted, so there is nothing to unescape. */
export function parseUntrackedPaths(output: string): string[] {
  return output.split("\0").filter((path) => path !== "").sort();
}

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

const NO_BASELINE: WorktreeBaseline = { kind: "none", label: "no baseline" };
const NOT_A_REPO: WorktreeBaseline = { kind: "not-a-repo", label: "not a git repository" };
const UNCOMMITTED: WorktreeBaseline = { kind: "uncommitted", label: "uncommitted only" };

/** A rung: the baseline that was chosen, and the diff that expresses it — if it has one. */
export interface DiffPlan {
  baseline: WorktreeBaseline;
  /** Absent on the rung that has nothing to diff against, which is an answer rather than a failure. */
  args?: readonly string[];
}

/**
 * Pick the baseline the agent's work is visible against, most informative rung first.
 *
 * **A branch's upstream is its own mirror, not its base.** This is the distinction the whole ladder
 * exists for. Once a worker's branch is pushed, `@{upstream}` resolves to `origin/<that same
 * branch>`, so `merge-base(@{upstream}, HEAD)` is HEAD itself and the diff is empty *by
 * construction* — the worker's entire body of work disappears the moment it is pushed. The fork
 * point is what an upstream was being used as a proxy for, and `refs/remotes/origin/HEAD` names the
 * default branch directly, so it is read rather than approximated.
 *
 * Rung 1, fork point: the working tree against `merge-base(<default branch>, HEAD)`. Diffing the
 * *working tree* rather than HEAD puts committed and uncommitted work in one list, which is what a
 * worker mid-task and a worker that already committed both need. It also keeps covering a
 * squash-merged branch: a squash never makes HEAD an ancestor of the default branch, so the fork
 * point stays where it was and the full diff stays visible.
 *
 * Rung 2, uncommitted only: taken when HEAD *is* an ancestor of the default branch, which is a
 * merged-via-merge-commit branch or a worker running directly on the default branch. The fork point
 * is then HEAD, so rung 1 would produce exactly this list under a label claiming more than it did.
 * The rung is chosen from the refs, not from an empty rung-1 result, because the two are the same
 * diff and only the label distinguishes them.
 *
 * Rung 3, nothing: no `refs/remotes/origin/HEAD` to resolve, or no common ancestor with it. There is
 * no baseline to be honest about, so none is claimed. See CLAUDE.md for why no further rung
 * (`@{upstream}`, `HEAD~1`) is guessed at here.
 */
export async function diffBaseline(git: GitOutput): Promise<DiffPlan> {
  const defaultBranch = await git(["rev-parse", "--abbrev-ref", "refs/remotes/origin/HEAD"])
    .then((value) => value.trim(), () => "");
  if (defaultBranch === "") return { baseline: NO_BASELINE };
  const [forkPoint, head] = await Promise.all([
    git(["merge-base", defaultBranch, "HEAD"]).then((value) => value.trim(), () => ""),
    git(["rev-parse", "HEAD"]).then((value) => value.trim(), () => ""),
  ]);
  if (forkPoint === "" || head === "") return { baseline: NO_BASELINE };
  if (forkPoint === head) {
    return {
      baseline: { ...UNCOMMITTED, rev: head },
      args: ["diff", "--no-ext-diff", "--unified=0", "HEAD", "--"],
    };
  }
  return {
    baseline: { kind: "fork-point", label: `since ${defaultBranch}`, rev: forkPoint },
    args: ["diff", "--no-ext-diff", "--unified=0", forkPoint, "--"],
  };
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
 * A refactor that rewrites a generated tree can produce tens of thousands of hunks, and an nvim
 * list that long is not navigable anyway. Truncation is reported rather than silent.
 */
export const MAX_WORKTREE_CHANGES = 500;

export function boundChanges(changes: readonly WorktreeChange[]): BoundedChanges {
  return {
    changes: changes.slice(0, MAX_WORKTREE_CHANGES),
    dropped: Math.max(0, changes.length - MAX_WORKTREE_CHANGES),
  };
}

/**
 * Tracked hunks first, in diff order, then untracked files — the order git reports them in.
 *
 * A directory that is not a repository is an answer, not an error: the operator keeps scratchpad
 * threads whose cwd was never `git init`-ed, and the right thing there is an empty list that says
 * why, not a failed open. Untracked files are collected on every rung that has a repository at all,
 * including the one with no baseline, because "git has never seen this file" is true independently
 * of what the diff is taken against.
 */
export async function collectWorktreeChanges(git: GitOutput): Promise<WorktreeChangeSet> {
  const inRepository = await git(["rev-parse", "--is-inside-work-tree"])
    .then((value) => value.trim() === "true", () => false);
  if (!inRepository) return { changes: [], dropped: 0, baseline: NOT_A_REPO };
  const plan = await diffBaseline(git);
  const [diff, untracked] = await Promise.all([
    plan.args === undefined ? Promise.resolve("") : git(plan.args),
    git(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return {
    ...boundChanges([
      ...parseUnifiedDiff(diff),
      ...parseUntrackedPaths(untracked).map((path) => ({ path, line: 1, text: "untracked" })),
    ]),
    baseline: plan.baseline,
  };
}

/**
 * `core.quotePath=false` keeps non-ASCII paths readable in the diff headers; `--no-optional-locks`
 * keeps a read from writing to a worktree an agent may still be using.
 */
export function gitOutputIn(cwd: string): GitOutput {
  return async (args) => {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "-c", "core.quotePath=false", "-C", cwd, ...args],
      { encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
    );
    return stdout;
  };
}

export function worktreeChanges(cwd: string): Promise<WorktreeChangeSet> {
  return collectWorktreeChanges(gitOutputIn(cwd));
}
