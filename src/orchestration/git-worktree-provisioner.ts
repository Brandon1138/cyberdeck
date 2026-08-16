import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  defaultProvisionedWorktreePath,
  type ProvisionedWorktree,
  type WorkerWorkspace,
  type WorktreeProvisionRequest,
  type WorktreeProvisioner,
} from "../domain/worker-workspace.js";

const run = promisify(execFile);

/** Enough of git's stderr to act on, and never enough to flood a journal. */
const MAX_GIT_STDERR = 2_000;

/**
 * Provenance for a worktree Cyberdeck created, written where the operator's `git status` will never
 * see it: the per-worktree administrative directory git itself owns. A marker inside the working
 * tree would show up as an untracked file in the worker's own diff and in Fleet's change list, so
 * the one artifact that says "Cyberdeck made this" would also be the one artifact that pollutes
 * every review of the work done in it. `git worktree remove` deletes this directory with the
 * worktree, so the marker cannot outlive what it describes.
 */
export const PROVENANCE_FILENAME = "cyberdeck-provenance.json";

export interface WorktreeProvenance {
  /** Schema tag, so a future reader can refuse a file it does not understand rather than guess. */
  version: 1;
  sessionId: string;
  branch: string;
  /** The base as the caller declared it, kept because it is the name the operator will recognise. */
  baseRef: string;
  /**
   * The commit `baseRef` named in the source repository at the moment the worktree was cut, and the
   * only thing retention is allowed to diff against.
   *
   * A symbolic name is not a baseline. The composer declares `HEAD`, which inside the worktree
   * resolves to the worktree's own tip, so `HEAD..HEAD` is empty however many commits a worker
   * makes — a worktree full of unpublished work would read as holding nothing and be reclaimed by
   * `worktree prune --yes`. Resolving here, once, is what makes the baseline mean the commit the
   * branch was actually cut from.
   */
  baseCommit: string;
  repositoryPath: string;
  worktreePath: string;
  createdAt: string;
}

export class WorktreeProvisionError extends Error {
  constructor(
    readonly code:
      | "WORKTREE_REPOSITORY_UNRESOLVED"
      | "WORKTREE_BASE_REF_UNRESOLVED"
      | "WORKTREE_CREATE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "WorktreeProvisionError";
  }
}

export interface GitWorktreeProvisionerOptions {
  timeoutMs?: number;
  now?: () => string;
}

/**
 * The one place Cyberdeck runs `git worktree add` for a worker.
 *
 * Every argument is a fixed argv element; nothing reaches a shell, and the branch and base have
 * already been through `WorkerWorkspaceSchema`, which refuses option-shaped and glob-shaped names.
 * No `--force` is ever emitted, in either direction: creation refuses to reuse an existing path or
 * branch, and `discard` refuses to remove a worktree that has changes in it.
 *
 * Node repositories: this deliberately does **not** run a package manager and does **not** symlink
 * the source repository's `node_modules` into the new worktree. A symlinked shared `node_modules`
 * is exactly the shape a package manager run from the worktree tries to delete, and provisioning
 * that hazard by default would put it in every worktree Cyberdeck creates rather than in the ones
 * an operator chose. The worktree is created empty of dependencies and the fact is reported as a
 * warning, so a worker that needs them installs them into its own worktree, where an install is
 * only slow.
 */
export class GitWorktreeProvisioner implements WorktreeProvisioner {
  private readonly timeoutMs: number;
  private readonly now: () => string;

  constructor(options: GitWorktreeProvisionerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async provision(request: WorktreeProvisionRequest): Promise<ProvisionedWorktree> {
    const repositoryPath = request.workspace.repositoryPath
      ?? await this.repositoryRoot(request.cwd);
    const worktreePath = resolve(
      request.workspace.worktreePath
        ?? defaultProvisionedWorktreePath(repositoryPath, request.workspace.branch),
    );
    const workspace: WorkerWorkspace = {
      ...request.workspace,
      worktreePath,
      repositoryPath,
    };

    // The base is resolved to a commit before anything is created, and that commit — not the name —
    // is what the worktree is cut from and what provenance records. Resolving first also means a
    // base that does not exist fails before a directory or a branch does.
    const baseCommit = await this.resolveBase(repositoryPath, workspace.baseRef);

    // `git worktree add` creates the leaf, not an absent chain above it. Creating the parent first
    // keeps a worktree root under a directory the operator has not made yet from failing as though
    // the branch were the problem.
    await mkdir(dirname(worktreePath), { recursive: true });
    try {
      await this.git(repositoryPath, [
        "worktree",
        "add",
        "-b",
        workspace.branch,
        worktreePath,
        baseCommit,
      ]);
    } catch (error) {
      throw new WorktreeProvisionError(
        "WORKTREE_CREATE_FAILED",
        `Could not create worktree ${worktreePath} for branch ${workspace.branch} from `
        + `${workspace.baseRef} (${baseCommit}): ${gitFailure(error)}`,
      );
    }

    await this.writeProvenance(workspace, baseCommit, request.sessionId);
    return { workspace, baseCommit, warnings: await this.warnings(workspace) };
  }

  async discard(workspace: WorkerWorkspace): Promise<void> {
    const { repositoryPath, worktreePath } = workspace;
    if (repositoryPath === undefined || worktreePath === undefined) return;
    // No `--force` on either call. `worktree remove` refuses a dirty worktree and `branch -d`
    // refuses an unmerged branch, which is the whole guarantee: the only thing this can delete is a
    // worktree that never got used and a branch that is still exactly its base.
    await this.git(repositoryPath, ["worktree", "remove", worktreePath]).catch(() => undefined);
    await this.git(repositoryPath, ["branch", "-d", workspace.branch]).catch(() => undefined);
  }

  private async repositoryRoot(cwd: string): Promise<string> {
    const root = await this.git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
    if (root === undefined) {
      throw new WorktreeProvisionError(
        "WORKTREE_REPOSITORY_UNRESOLVED",
        `${cwd} is not inside a git repository, so no worktree can be cut from it`,
      );
    }
    return resolve(root);
  }

  /**
   * The commit `baseRef` names in the source repository, right now.
   *
   * `^{commit}` is appended rather than trusted from the caller: `RefNameSchema` refuses `^` in a
   * declared ref, so the peel is unambiguously ours, and it makes an annotated tag answer with the
   * commit it points at rather than the tag object.
   */
  private async resolveBase(repositoryPath: string, baseRef: string): Promise<string> {
    const commit = await this
      .git(repositoryPath, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`])
      .catch(() => undefined);
    if (commit === undefined) {
      throw new WorktreeProvisionError(
        "WORKTREE_BASE_REF_UNRESOLVED",
        `Base ref ${baseRef} does not name a commit in ${repositoryPath}, so there is nothing to `
        + "cut a worktree from",
      );
    }
    return commit;
  }

  /** Provenance failure is not a launch failure: the worktree exists and the worker can use it. */
  private async writeProvenance(
    workspace: WorkerWorkspace,
    baseCommit: string,
    sessionId: string,
  ): Promise<void> {
    const worktreePath = workspace.worktreePath;
    const repositoryPath = workspace.repositoryPath;
    if (worktreePath === undefined || repositoryPath === undefined) return;
    try {
      const adminDirectory = await this.git(worktreePath, ["rev-parse", "--absolute-git-dir"]);
      if (adminDirectory === undefined) return;
      const provenance: WorktreeProvenance = {
        version: 1,
        sessionId,
        branch: workspace.branch,
        baseRef: workspace.baseRef,
        baseCommit,
        repositoryPath,
        worktreePath,
        createdAt: this.now(),
      };
      await writeFile(
        join(adminDirectory, PROVENANCE_FILENAME),
        `${JSON.stringify(provenance, undefined, 2)}\n`,
        "utf8",
      );
    } catch {
      // A worktree with no provenance is invisible to `cyberdeck worktree list`, which is a hygiene
      // cost the operator can pay later with `git worktree list`. Failing the start over it would
      // cost them the work itself.
    }
  }

  private async warnings(workspace: WorkerWorkspace): Promise<string[]> {
    const { repositoryPath, worktreePath } = workspace;
    if (repositoryPath === undefined || worktreePath === undefined) return [];
    if (!await isDirectory(join(repositoryPath, "node_modules"))) return [];
    if (await isDirectory(join(worktreePath, "node_modules"))) return [];
    return [
      `${worktreePath} has no node_modules: Cyberdeck provisions git state only and never runs a `
      + "package manager. Install inside the worktree if the task needs dependencies; do not link "
      + `${join(repositoryPath, "node_modules")} into it, because a package manager run from the `
      + "worktree will try to delete what the link points at.",
    ];
  }

  private async git(cwd: string, args: string[]): Promise<string | undefined> {
    const { stdout } = await run("git", ["-C", cwd, ...args], { timeout: this.timeoutMs });
    const value = stdout.trim();
    return value === "" ? undefined : value;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function gitFailure(error: unknown): string {
  const stderr = typeof error === "object" && error !== null && "stderr" in error
    ? String((error as { stderr: unknown }).stderr)
    : error instanceof Error ? error.message : String(error);
  return stderr.trim().slice(0, MAX_GIT_STDERR);
}
