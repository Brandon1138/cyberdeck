import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { WorkspaceProbe } from "../domain/worker-workspace.js";

const run = promisify(execFile);

/**
 * Reads a repository to answer the four questions `validateWorkerWorkspace` asks. Every call is a
 * plumbing command with a fixed argument list — nothing here interpolates into a shell, and the ref
 * name has already been through `WorkerWorkspaceSchema`, which refuses option-shaped and
 * glob-shaped values before they reach argv.
 *
 * Read-only by construction. Provisioning a worktree is not this class's job: the broker validates
 * what a dispatch declared, and the 2026-08-14 failure was a missing grant rather than a missing
 * command.
 */
export class GitWorkspaceProbe implements WorkspaceProbe {
  constructor(private readonly timeoutMs = 5_000) {}

  async gitCommonDirectory(path: string): Promise<string | undefined> {
    const output = await this.git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return output === undefined ? undefined : resolve(output);
  }

  async worktreeRoot(path: string): Promise<string | undefined> {
    const output = await this.git(path, ["rev-parse", "--show-toplevel"]);
    return output === undefined ? undefined : resolve(output);
  }

  async checkedOutBranch(path: string): Promise<string | undefined> {
    // `--quiet` makes a detached HEAD a non-zero exit rather than the literal string "HEAD".
    return this.git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  }

  async refResolves(path: string, ref: string): Promise<boolean> {
    return await this.git(path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== undefined;
  }

  async isBareRepository(gitDir: string): Promise<boolean | undefined> {
    const output = await this.git(gitDir, ["rev-parse", "--is-bare-repository"]);
    if (output === "true") return true;
    if (output === "false") return false;
    return undefined;
  }

  async primaryWorktree(gitDir: string): Promise<string | undefined> {
    // `core.worktree` is the config git itself uses to find a relocated main worktree, and it wins
    // when set. Verified against real git (2.54): `git init --separate-git-dir` does NOT write it,
    // so it is commonly absent — this is not a redundant first attempt, it is the only path that
    // works when a `--separate-git-dir` repository was set up the way git's own docs recommend
    // (`git-worktree(1)`: "you need to update the core.worktree setting").
    const configured = await this.git(gitDir, ["config", "--get", "core.worktree"]);
    if (configured !== undefined) return resolve(gitDir, configured);
    // Without `core.worktree`, git has no bookkeeping for the *main* worktree at all — only linked
    // worktrees get an entry under `$GIT_DIR/worktrees`. `worktree list --porcelain`'s first line is
    // supposed to be the main worktree, but when git doesn't know where it is, the line it prints is
    // the git directory itself rather than an actual working tree. That echo is not an answer; the
    // repository is correctly identified as non-bare, but where its worktree lives is unknowable.
    const output = await this.git(gitDir, ["worktree", "list", "--porcelain"]);
    const firstLine = output?.split("\n", 1)[0];
    if (firstLine === undefined || !firstLine.startsWith("worktree ")) return undefined;
    const reported = resolve(firstLine.slice("worktree ".length));
    return reported === resolve(gitDir) ? undefined : reported;
  }

  private async git(cwd: string, args: string[]): Promise<string | undefined> {
    try {
      const { stdout } = await run("git", ["-C", cwd, ...args], { timeout: this.timeoutMs });
      const value = stdout.trim();
      return value === "" ? undefined : value;
    } catch {
      // Every question this probe asks is answerable as "no": not a repository, detached, no such
      // ref. A caller that needs to distinguish them reads the validation code, not an exception.
      return undefined;
    }
  }
}
