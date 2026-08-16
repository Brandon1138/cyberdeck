import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  GitWorktreeProvisioner,
  PROVENANCE_FILENAME,
  WorktreeProvisionError,
  type WorktreeProvenance,
} from "../../src/orchestration/git-worktree-provisioner.js";
import type { WorkerWorkspace } from "../../src/domain/worker-workspace.js";

const run = promisify(execFile);
const directories: string[] = [];

afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

/** A real repository with one commit on `main`, because worktree creation has no useful fake. */
async function repository(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "cyberdeck-worktree-"));
  directories.push(parent);
  const root = join(parent, "project");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "--initial-branch", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "base\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  // `rev-parse --show-toplevel` answers in real paths, and the system temp directory is a symlink
  // on macOS. Comparing against the realpath keeps the assertions about the machine, not the link.
  return realpath(root);
}

function workspace(branch: string, overrides: Partial<WorkerWorkspace> = {}): WorkerWorkspace {
  return {
    branch,
    baseRef: "main",
    provisioning: "cyberdeck-provisioned",
    writableRoots: [],
    ...overrides,
  };
}

describe("GitWorktreeProvisioner", () => {
  it("cuts a sibling worktree named after the branch leaf", async () => {
    const root = await repository();
    const provisioner = new GitWorktreeProvisioner();

    const result = await provisioner.provision({
      workspace: workspace("cyberdeck/MIK-75-Worktrees"),
      cwd: root,
      sessionId: "session-1",
    });

    expect(result.workspace.worktreePath).toBe(join(dirname(root), "project-mik-75-worktrees"));
    expect(result.workspace.repositoryPath).toBe(root);
    expect((await stat(result.workspace.worktreePath ?? "")).isDirectory()).toBe(true);
    expect(await git(result.workspace.worktreePath ?? "", ["rev-parse", "--abbrev-ref", "HEAD"]))
      .toBe("cyberdeck/MIK-75-Worktrees");
  });

  it("writes provenance into the worktree's git admin directory, not its working tree", async () => {
    const root = await repository();
    const result = await new GitWorktreeProvisioner({ now: () => "2026-08-16T00:00:00.000Z" })
      .provision({ workspace: workspace("feature/probe"), cwd: root, sessionId: "session-2" });
    const worktreePath = result.workspace.worktreePath ?? "";

    expect(await git(worktreePath, ["status", "--porcelain"])).toBe("");
    const adminDirectory = await git(worktreePath, ["rev-parse", "--absolute-git-dir"]);
    const provenance = JSON.parse(
      await readFile(join(adminDirectory, PROVENANCE_FILENAME), "utf8"),
    ) as WorktreeProvenance;
    expect(provenance).toMatchObject({
      version: 1,
      sessionId: "session-2",
      branch: "feature/probe",
      baseRef: "main",
      baseCommit: await git(root, ["rev-parse", "main"]),
      repositoryPath: root,
      createdAt: "2026-08-16T00:00:00.000Z",
    });
  });

  it("pins a symbolic base to the commit it named, so the baseline survives the worktree", async () => {
    const root = await repository();
    const head = await git(root, ["rev-parse", "HEAD"]);

    // `HEAD` is what the composer declares. Read back inside the worktree it would answer with the
    // worktree's own tip, so the recorded baseline has to be the commit, not the name.
    const result = await new GitWorktreeProvisioner()
      .provision({ workspace: workspace("feature/head", { baseRef: "HEAD" }), cwd: root, sessionId: "session-8" });
    const worktreePath = result.workspace.worktreePath ?? "";
    await writeFile(join(worktreePath, "work.txt"), "done\n", "utf8");
    await git(worktreePath, ["add", "."]);
    await git(worktreePath, ["commit", "-m", "work"]);

    expect(result.baseCommit).toBe(head);
    const adminDirectory = await git(worktreePath, ["rev-parse", "--absolute-git-dir"]);
    const provenance = JSON.parse(
      await readFile(join(adminDirectory, PROVENANCE_FILENAME), "utf8"),
    ) as WorktreeProvenance;
    expect(provenance.baseRef).toBe("HEAD");
    expect(provenance.baseCommit).toBe(head);
    expect(await git(worktreePath, ["rev-list", "--count", `${provenance.baseCommit}..HEAD`]))
      .toBe("1");
  });

  it("refuses a base ref that names no commit before creating anything", async () => {
    const root = await repository();

    await expect(new GitWorktreeProvisioner().provision({
      workspace: workspace("feature/no-base", { baseRef: "nonexistent" }),
      cwd: root,
      sessionId: "session-9",
    })).rejects.toMatchObject({ code: "WORKTREE_BASE_REF_UNRESOLVED" });

    expect(await git(root, ["branch", "--list", "feature/no-base"])).toBe("");
    await expect(stat(join(dirname(root), "project-no-base"))).rejects.toThrow();
  });

  it("warns about missing node_modules instead of installing or symlinking one", async () => {
    const root = await repository();
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });

    const result = await new GitWorktreeProvisioner()
      .provision({ workspace: workspace("feature/node"), cwd: root, sessionId: "session-3" });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("no node_modules");
    await expect(stat(join(result.workspace.worktreePath ?? "", "node_modules")))
      .rejects.toThrow();
  });

  it("fails loudly when the branch already exists rather than uniquifying", async () => {
    const root = await repository();
    await git(root, ["branch", "feature/taken"]);

    await expect(new GitWorktreeProvisioner()
      .provision({ workspace: workspace("feature/taken"), cwd: root, sessionId: "session-4" }))
      .rejects.toThrow(WorktreeProvisionError);
  });

  it("refuses a cwd outside any repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "cyberdeck-not-a-repo-"));
    directories.push(outside);

    await expect(new GitWorktreeProvisioner()
      .provision({ workspace: workspace("feature/none"), cwd: outside, sessionId: "session-5" }))
      .rejects.toMatchObject({ code: "WORKTREE_REPOSITORY_UNRESOLVED" });
  });

  it("discards an unused worktree and its branch without forcing", async () => {
    const root = await repository();
    const provisioner = new GitWorktreeProvisioner();
    const result = await provisioner
      .provision({ workspace: workspace("feature/discard"), cwd: root, sessionId: "session-6" });

    await provisioner.discard(result.workspace);

    await expect(stat(result.workspace.worktreePath ?? "")).rejects.toThrow();
    expect(await git(root, ["branch", "--list", "feature/discard"])).toBe("");
  });

  it("leaves a dirty worktree alone when discarding", async () => {
    const root = await repository();
    const provisioner = new GitWorktreeProvisioner();
    const result = await provisioner
      .provision({ workspace: workspace("feature/dirty"), cwd: root, sessionId: "session-7" });
    const worktreePath = result.workspace.worktreePath ?? "";
    await writeFile(join(worktreePath, "README.md"), "changed\n", "utf8");

    await provisioner.discard(result.workspace);

    expect((await stat(worktreePath)).isDirectory()).toBe(true);
  });
});
