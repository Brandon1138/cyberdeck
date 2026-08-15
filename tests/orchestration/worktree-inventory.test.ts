import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { GitWorktreeProvisioner } from "../../src/orchestration/git-worktree-provisioner.js";
import {
  GitWorktreeInventory,
  parseWorktreeList,
  retentionVerdict,
  type ProvisionedWorktree,
} from "../../src/orchestration/worktree-inventory.js";

const run = promisify(execFile);
const directories: string[] = [];

afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

async function repository(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "cyberdeck-inventory-"));
  directories.push(parent);
  const root = join(parent, "project");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "--initial-branch", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "base\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  return realpath(root);
}

async function provision(root: string, branch: string): Promise<string> {
  const result = await new GitWorktreeProvisioner().provision({
    workspace: { branch, baseRef: "main", provisioning: "cyberdeck-provisioned", writableRoots: [] },
    cwd: root,
    sessionId: `session-${branch}`,
  });
  return result.workspace.worktreePath ?? "";
}

function candidate(overrides: Partial<ProvisionedWorktree> = {}): ProvisionedWorktree {
  return {
    path: "/repo-feature",
    branch: "feature",
    provenance: {
      version: 1,
      sessionId: "session",
      branch: "feature",
      baseRef: "main",
      repositoryPath: "/repo",
      worktreePath: "/repo-feature",
      createdAt: "2026-08-16T00:00:00.000Z",
    },
    dirty: false,
    commitsAheadOfBase: 0,
    pushed: false,
    ...overrides,
  };
}

describe("retentionVerdict", () => {
  it("reclaims a worktree that holds nothing beyond its base, branch and all", () => {
    expect(retentionVerdict(candidate())).toMatchObject({ keep: false, removeBranch: true });
  });

  it("keeps a worktree a worker is still running in", () => {
    const verdict = retentionVerdict(candidate({ liveSessionId: "abc" }));
    expect(verdict.keep).toBe(true);
    expect(verdict.reason).toContain("abc");
  });

  it("keeps a dirty worktree even when its commits are all merged", () => {
    expect(retentionVerdict(candidate({ dirty: true })).keep).toBe(true);
  });

  it("keeps unlanded commits that exist nowhere else", () => {
    expect(retentionVerdict(candidate({ commitsAheadOfBase: 3 })).keep).toBe(true);
  });

  it("reclaims the directory but keeps the branch when the commits are pushed", () => {
    expect(retentionVerdict(candidate({ commitsAheadOfBase: 3, pushed: true })))
      .toMatchObject({ keep: false, removeBranch: false });
  });

  it("keeps a worktree whose base ref no longer resolves", () => {
    expect(retentionVerdict(candidate({ commitsAheadOfBase: Number.MAX_SAFE_INTEGER })).keep)
      .toBe(true);
  });
});

describe("parseWorktreeList", () => {
  it("reads the porcelain stanzas including detached heads", () => {
    expect(parseWorktreeList([
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /repo-detached",
      "HEAD def",
      "detached",
      "",
    ].join("\n"))).toEqual([
      { path: "/repo", branch: "main", detached: false },
      { path: "/repo-detached", detached: true },
    ]);
  });
});

describe("GitWorktreeInventory", () => {
  it("sees only the worktrees Cyberdeck provisioned", async () => {
    const root = await repository();
    const provisioned = await provision(root, "cyberdeck/owned");
    const foreign = join(root, "..", "hand-made");
    await git(root, ["worktree", "add", "-b", "hand-made", foreign, "main"]);

    const listed = await new GitWorktreeInventory().list(root);

    expect(listed.map((worktree) => worktree.path)).toEqual([provisioned]);
    expect(listed[0]?.provenance.branch).toBe("cyberdeck/owned");
    expect(listed[0]?.dirty).toBe(false);
    expect(listed[0]?.commitsAheadOfBase).toBe(0);
  });

  it("reports a worktree with uncommitted work as dirty", async () => {
    const root = await repository();
    const provisioned = await provision(root, "cyberdeck/dirty");
    await writeFile(join(provisioned, "scratch.txt"), "wip\n", "utf8");

    const [worktree] = await new GitWorktreeInventory().list(root);

    expect(worktree?.dirty).toBe(true);
    expect(retentionVerdict(worktree ?? candidate()).keep).toBe(true);
  });

  it("counts commits the base ref does not contain", async () => {
    const root = await repository();
    const provisioned = await provision(root, "cyberdeck/ahead");
    await writeFile(join(provisioned, "work.txt"), "done\n", "utf8");
    await git(provisioned, ["add", "."]);
    await git(provisioned, ["commit", "-m", "work"]);

    const [worktree] = await new GitWorktreeInventory().list(root);

    expect(worktree?.commitsAheadOfBase).toBe(1);
    expect(worktree?.pushed).toBe(false);
  });

  it("attributes a live session to the worktree it is running in", async () => {
    const root = await repository();
    const provisioned = await provision(root, "cyberdeck/live");
    const inventory = new GitWorktreeInventory({
      liveSessions: new Map([[provisioned, "session-live"]]),
    });

    const [worktree] = await inventory.list(root);

    expect(worktree?.liveSessionId).toBe("session-live");
  });

  it("removes a cleared worktree and its merged branch", async () => {
    const root = await repository();
    const provisioned = await provision(root, "cyberdeck/spent");
    const inventory = new GitWorktreeInventory();
    const [worktree] = await inventory.list(root);
    if (worktree === undefined) throw new Error("expected one provisioned worktree");

    await inventory.remove(worktree, true);

    await expect(stat(provisioned)).rejects.toThrow();
    expect(await git(root, ["branch", "--list", "cyberdeck/spent"])).toBe("");
  });
});
