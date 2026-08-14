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
