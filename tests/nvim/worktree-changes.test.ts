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

describe("diffBaseline", () => {
  it("compares against the merge base with the recorded upstream", async () => {
    const git: GitOutput = async (args) =>
      args[0] === "rev-parse" ? "origin/main\n" : "";
    expect(await diffBaseline(git)).toEqual([
      "diff", "--no-ext-diff", "--unified=0", "--merge-base", "origin/main", "--",
    ]);
  });

  it("falls back to HEAD when git recorded no upstream", async () => {
    const git: GitOutput = async () => {
      throw new Error("no upstream configured");
    };
    expect(await diffBaseline(git)).toEqual(["diff", "--no-ext-diff", "--unified=0", "HEAD", "--"]);
  });
});

describe("collectWorktreeChanges", () => {
  it("reports tracked hunks first, then untracked files", async () => {
    const git: GitOutput = async (args) => {
      if (args[0] === "rev-parse") return "origin/main\n";
      if (args[0] === "ls-files") return "new.ts\0";
      return ["--- a/old.ts", "+++ b/old.ts", "@@ -1 +2 @@ ctx", ""].join("\n");
    };

    expect(await collectWorktreeChanges(git)).toEqual({
      changes: [
        { path: "old.ts", line: 2, text: "ctx" },
        { path: "new.ts", line: 1, text: "untracked" },
      ],
      dropped: 0,
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
