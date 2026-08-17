import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { GitWorkspaceProbe } from "../../src/orchestration/git-workspace-probe.js";
import { validateWorkerWorkspace, type WorkerWorkspace } from "../../src/domain/worker-workspace.js";

const run = promisify(execFile);
const directories: string[] = [];

afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

async function scratchParent(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "cyberdeck-workspace-probe-"));
  directories.push(parent);
  return parent;
}

/**
 * A non-bare repository whose git directory was relocated with `git init --separate-git-dir`, the
 * shape the P2 finding on MIK-90 named: `<workDir>/.git` is a gitlink file, not a directory, and the
 * real git directory sits at `<parent>/metadata/repo.git` — a common directory that is neither named
 * `.git` nor bare.
 *
 * Verified against real git (2.54): `git init --separate-git-dir` does not set `core.worktree`, so by
 * default git itself has no bookkeeping for where the main worktree lives; `configureCoreWorktree`
 * sets it by hand. Both states are exercised below because both are real: git's own docs say
 * `core.worktree` needs to be set by hand for a relocated repository, but `git init --separate-git-dir`
 * doesn't do it, so plenty of repositories exist in the unconfigured state too.
 */
async function separateGitDirRepository(
  { configureCoreWorktree = false }: { configureCoreWorktree?: boolean } = {},
): Promise<{ workDir: string; gitDir: string }> {
  const parent = await scratchParent();
  const workDir = join(parent, "repo");
  const gitDir = join(parent, "metadata", "repo.git");
  await mkdir(workDir, { recursive: true });
  await mkdir(join(parent, "metadata"), { recursive: true });
  await run("git", ["init", `--separate-git-dir=${gitDir}`, "--initial-branch", "main", workDir]);
  await git(workDir, ["config", "user.email", "test@example.com"]);
  await git(workDir, ["config", "user.name", "Test"]);
  await writeFile(join(workDir, "README.md"), "base\n", "utf8");
  await git(workDir, ["add", "."]);
  await git(workDir, ["commit", "-m", "base"]);
  // realpath, because the system temp directory is a symlink on macOS and git answers in real paths.
  const realWorkDir = await realpath(workDir);
  if (configureCoreWorktree) await git(workDir, ["config", "core.worktree", realWorkDir]);
  return { workDir: realWorkDir, gitDir: await realpath(gitDir) };
}

/** A bare repository, cloned from a real one so it carries a commit `worktree add` can start from. */
async function bareRepository(): Promise<string> {
  const parent = await scratchParent();
  const source = join(parent, "source");
  await mkdir(source, { recursive: true });
  await run("git", ["init", "--initial-branch", "main", source]);
  await git(source, ["config", "user.email", "test@example.com"]);
  await git(source, ["config", "user.name", "Test"]);
  await writeFile(join(source, "README.md"), "base\n", "utf8");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "base"]);
  const bareDir = join(parent, "repo.git");
  await run("git", ["clone", "--bare", source, bareDir]);
  return realpath(bareDir);
}

function workspace(branch: string, worktreePath: string): WorkerWorkspace {
  return {
    worktreePath,
    branch,
    baseRef: "main",
    provisioning: "pre-provisioned",
    writableRoots: [],
  };
}

describe("GitWorkspaceProbe against a separate-git-dir repository", () => {
  it("reports the relocated common dir, not a directory literally named .git", async () => {
    const { workDir, gitDir } = await separateGitDirRepository();
    const probe = new GitWorkspaceProbe();

    expect(await probe.gitCommonDirectory(workDir)).toBe(gitDir);
  });

  it("says the repository is not bare", async () => {
    const { gitDir } = await separateGitDirRepository();
    const probe = new GitWorkspaceProbe();

    expect(await probe.isBareRepository(gitDir)).toBe(false);
  });

  it("recovers the primary worktree via core.worktree when it is configured", async () => {
    const { workDir, gitDir } = await separateGitDirRepository({ configureCoreWorktree: true });
    const probe = new GitWorkspaceProbe();

    expect(await probe.primaryWorktree(gitDir)).toBe(workDir);
  });

  it("cannot recover the primary worktree from git worktree list alone, because git tracks none for the main worktree", async () => {
    // `git worktree list --porcelain`'s first line is documented as the main worktree, but without
    // `core.worktree` git has nothing to report there and echoes the git directory itself instead —
    // confirmed by running it directly: `git -C <gitDir> worktree list --porcelain` prints `worktree
    // <gitDir>`, not the real working tree. That echo must not be trusted as an answer.
    const { gitDir } = await separateGitDirRepository();
    const probe = new GitWorkspaceProbe();

    expect(await probe.primaryWorktree(gitDir)).toBeUndefined();
  });

  it("resolves a linked worktree's repositoryPath to the primary checkout when core.worktree is configured (MIK-90 P2)", async () => {
    const { workDir } = await separateGitDirRepository({ configureCoreWorktree: true });
    const linkedPath = join(workDir, "..", "repo-mik-70");
    await git(workDir, ["worktree", "add", "-b", "brandon/mik-70", linkedPath, "main"]);
    const linked = await realpath(linkedPath);

    const check = await validateWorkerWorkspace({
      workspace: workspace("brandon/mik-70", linked),
      cwd: linked,
      sandbox: "workspace-write",
      probe: new GitWorkspaceProbe(),
    });

    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.value.repositoryPath).toBe(workDir);
  });

  it("leaves repositoryPath undefined for a linked worktree of an unconfigured separate-git-dir repo, rather than misattributing to itself", async () => {
    // This is the regression the P2 finding named: without the fix, a common dir not named `.git`
    // was assumed bare, and the linked worktree's own path was recorded as its repository. Here git
    // genuinely cannot say where the main worktree is (no core.worktree), so the correct answer is
    // "unknown" — never a confident guess of the worktree itself.
    const { workDir } = await separateGitDirRepository();
    const linkedPath = join(workDir, "..", "repo-mik-71");
    await git(workDir, ["worktree", "add", "-b", "brandon/mik-71", linkedPath, "main"]);
    const linked = await realpath(linkedPath);

    const check = await validateWorkerWorkspace({
      workspace: workspace("brandon/mik-71", linked),
      cwd: linked,
      sandbox: "workspace-write",
      probe: new GitWorkspaceProbe(),
    });

    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.value.repositoryPath).toBeUndefined();
  });
});

describe("GitWorkspaceProbe against a bare repository", () => {
  it("says the repository is bare", async () => {
    const bareDir = await bareRepository();
    const probe = new GitWorkspaceProbe();

    expect(await probe.isBareRepository(bareDir)).toBe(true);
  });

  it("keeps resolving a bare-backed worktree's repositoryPath to itself, unchanged by this fix", async () => {
    const bareDir = await bareRepository();
    const linkedPath = join(bareDir, "..", "repo-mik-70");
    await git(bareDir, ["worktree", "add", "-b", "brandon/mik-70", linkedPath, "main"]);
    const linked = await realpath(linkedPath);

    const check = await validateWorkerWorkspace({
      workspace: workspace("brandon/mik-70", linked),
      cwd: linked,
      sandbox: "workspace-write",
      probe: new GitWorkspaceProbe(),
    });

    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.value.repositoryPath).toBe(linked);
  });
});
