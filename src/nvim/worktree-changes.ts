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
 * The upstream branch git itself recorded for this worktree, when there is one.
 *
 * This is read rather than guessed: `git worktree add -b <branch> origin/main` records the start
 * point, and comparing against the merge base is the only way an agent that *committed* its work
 * shows up at all. With no upstream configured the honest baseline is HEAD, and work the agent
 * committed and left clean is then invisible — an accepted limit, not something to go searching for.
 */
export async function diffBaseline(git: GitOutput): Promise<readonly string[]> {
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    .then((value) => value.trim(), () => "");
  return upstream === ""
    ? ["diff", "--no-ext-diff", "--unified=0", "HEAD", "--"]
    : ["diff", "--no-ext-diff", "--unified=0", "--merge-base", upstream, "--"];
}

export interface WorktreeChangeSet {
  changes: readonly WorktreeChange[];
  /** How many entries were dropped by {@link MAX_WORKTREE_CHANGES}. */
  dropped: number;
}

/**
 * A refactor that rewrites a generated tree can produce tens of thousands of hunks, and an nvim
 * list that long is not navigable anyway. Truncation is reported rather than silent.
 */
export const MAX_WORKTREE_CHANGES = 500;

export function boundChanges(changes: readonly WorktreeChange[]): WorktreeChangeSet {
  return {
    changes: changes.slice(0, MAX_WORKTREE_CHANGES),
    dropped: Math.max(0, changes.length - MAX_WORKTREE_CHANGES),
  };
}

/** Tracked hunks first, in diff order, then untracked files — the order git reports them in. */
export async function collectWorktreeChanges(git: GitOutput): Promise<WorktreeChangeSet> {
  const [diff, untracked] = await Promise.all([
    diffBaseline(git).then((args) => git(args)),
    git(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return boundChanges([
    ...parseUnifiedDiff(diff),
    ...parseUntrackedPaths(untracked).map((path) => ({ path, line: 1, text: "untracked" })),
  ]);
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
