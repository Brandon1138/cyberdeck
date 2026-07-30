import { describe, expect, it } from "vitest";
import {
  MAX_WORKTREE_CHANGES,
  boundChanges,
  collectWorktreeChanges,
  diffBaseline,
  parseUnifiedDiff,
  parseUntrackedPaths,
  type GitOutput,
} from "../../src/nvim/worktree-changes.js";

describe("parseUnifiedDiff", () => {
  it("turns each zero-context hunk into the first line the agent touched", () => {
    const diff = [
      "diff --git a/src/one.ts b/src/one.ts",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -3,0 +4,2 @@ export function one() {",
      "+  const added = 1;",
      "@@ -20 +21 @@ class Two {",
      "-  old();",
      "+  new();",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "src/one.ts", line: 4, text: "export function one() {" },
      { path: "src/one.ts", line: 21, text: "class Two {" },
    ]);
  });

  it("keeps a file that changed without producing a hunk", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "--- a/logo.png",
      "+++ b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([{ path: "logo.png", line: 1, text: "changed" }]);
  });

  it("takes a deleted file's path from the old side and says so", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,4 +0,0 @@ header",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([{ path: "gone.ts", line: 1, text: "deleted" }]);
  });

  it("keeps a new file's path from the new side", () => {
    const diff = [
      "--- /dev/null",
      "+++ b/added.ts",
      "@@ -0,0 +1,3 @@",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([{ path: "added.ts", line: 1, text: "changed" }]);
  });

  it("handles --no-prefix output, where a/ and b/ are absent", () => {
    const diff = ["--- src/x.ts", "+++ src/x.ts", "@@ -1 +9 @@ ctx", ""].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([{ path: "src/x.ts", line: 9, text: "ctx" }]);
  });
});

describe("parseUntrackedPaths", () => {
  it("reads NUL-terminated output with nothing to unescape", () => {
    expect(parseUntrackedPaths("b.ts\0a with space.ts\0")).toEqual(["a with space.ts", "b.ts"]);
    expect(parseUntrackedPaths("")).toEqual([]);
  });
});

/**
 * A repository described by its refs, not by a fixture on disk.
 *
 * Every rung of the ladder is a question about how `origin/HEAD`, HEAD, and their merge base sit
 * relative to each other, so that is what these fake repositories vary — and nothing else.
 */
function repository(options: {
  defaultBranch?: string | undefined;
  head?: string | undefined;
  forkPoint?: string | undefined;
  untracked?: string | undefined;
  diff?: string | undefined;
}): { git: GitOutput; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitOutput = async (args) => {
    calls.push([...args]);
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true\n";
    if (args[0] === "rev-parse" && args[2] === "refs/remotes/origin/HEAD") {
      if (options.defaultBranch === undefined) throw new Error("unknown revision");
      return `${options.defaultBranch}\n`;
    }
    if (args[0] === "rev-parse") return `${options.head ?? "headsha"}\n`;
    if (args[0] === "merge-base") {
      if (options.forkPoint === undefined) throw new Error("no merge base");
      return `${options.forkPoint}\n`;
    }
    if (args[0] === "ls-files") return options.untracked ?? "";
    return options.diff ?? "";
  };
  return { git, calls };
}

describe("diffBaseline", () => {
  it("diffs the working tree against the fork point with the default branch", async () => {
    const { git } = repository({ defaultBranch: "origin/main", head: "aaa", forkPoint: "base" });

    expect(await diffBaseline(git)).toEqual({
      baseline: { kind: "fork-point", label: "since origin/main" },
      args: ["diff", "--no-ext-diff", "--unified=0", "base", "--"],
    });
  });

  it("ignores that a pushed branch's upstream is its own mirror", async () => {
    // The bug this ladder exists for: `@{upstream}` of `codex/some-branch` is
    // `origin/codex/some-branch`, whose merge base with HEAD is HEAD, so the diff was empty by
    // construction the moment the worker pushed. Nothing here ever asks for the upstream.
    const { git, calls } = repository({
      defaultBranch: "origin/main",
      head: "pushed",
      forkPoint: "base",
    });
    await diffBaseline(git);

    expect(calls.some((args) => args.includes("@{upstream}"))).toBe(false);
  });

  it("reports uncommitted work only when HEAD is already an ancestor of the default branch", async () => {
    // A branch merged with a merge commit, or a worker running directly on the default branch:
    // the fork point is HEAD, so claiming a fork-point baseline would overstate what was measured.
    const { git } = repository({ defaultBranch: "origin/main", head: "same", forkPoint: "same" });

    expect(await diffBaseline(git)).toEqual({
      baseline: { kind: "uncommitted", label: "uncommitted only" },
      args: ["diff", "--no-ext-diff", "--unified=0", "HEAD", "--"],
    });
  });

  it("keeps showing a squash-merged branch in full, because a squash leaves the fork point alone", async () => {
    const { git } = repository({ defaultBranch: "origin/main", head: "squashed", forkPoint: "base" });

    expect((await diffBaseline(git)).baseline.kind).toBe("fork-point");
  });

  it("claims no baseline when there is no origin/HEAD to resolve", async () => {
    const { git } = repository({ head: "aaa" });

    expect(await diffBaseline(git)).toEqual({ baseline: { kind: "none", label: "no baseline" } });
  });

  it("claims no baseline when the default branch shares no history with HEAD", async () => {
    const { git } = repository({ defaultBranch: "origin/main", head: "aaa" });

    expect(await diffBaseline(git)).toEqual({ baseline: { kind: "none", label: "no baseline" } });
  });

  it("never consults the upstream, even when nothing else resolves", async () => {
    const { git, calls } = repository({});
    await diffBaseline(git);

    expect(calls.some((args) => args.includes("@{upstream}"))).toBe(false);
  });
});

describe("collectWorktreeChanges", () => {
  it("reports tracked hunks first, then untracked files", async () => {
    const { git } = repository({
      defaultBranch: "origin/main",
      head: "aaa",
      forkPoint: "base",
      untracked: "new.ts\0",
      diff: ["--- a/old.ts", "+++ b/old.ts", "@@ -1 +2 @@ ctx", ""].join("\n"),
    });

    expect(await collectWorktreeChanges(git)).toEqual({
      changes: [
        { path: "old.ts", line: 2, text: "ctx" },
        { path: "new.ts", line: 1, text: "untracked" },
      ],
      dropped: 0,
      baseline: { kind: "fork-point", label: "since origin/main" },
    });
  });

  it("still lists untracked files on the rung with no baseline", async () => {
    const { git } = repository({ head: "aaa", untracked: "scratch.md\0" });

    expect(await collectWorktreeChanges(git)).toEqual({
      changes: [{ path: "scratch.md", line: 1, text: "untracked" }],
      dropped: 0,
      baseline: { kind: "none", label: "no baseline" },
    });
  });

  it("answers rather than fails when the directory is not a repository", async () => {
    const git: GitOutput = async () => {
      throw new Error("fatal: not a git repository");
    };

    expect(await collectWorktreeChanges(git)).toEqual({
      changes: [],
      dropped: 0,
      baseline: { kind: "not-a-repo", label: "not a git repository" },
    });
  });
});

describe("boundChanges", () => {
  it("truncates and reports how much it dropped rather than doing so silently", () => {
    const changes = Array.from({ length: MAX_WORKTREE_CHANGES + 3 }, (_unused, index) => ({
      path: `f${index}.ts`,
      line: 1,
      text: "changed",
    }));
    const bounded = boundChanges(changes);

    expect(bounded.changes).toHaveLength(MAX_WORKTREE_CHANGES);
    expect(bounded.dropped).toBe(3);
  });
});
