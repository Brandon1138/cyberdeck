import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PROVENANCE_FILENAME, type WorktreeProvenance } from "./git-worktree-provisioner.js";

const run = promisify(execFile);

/** One line of `git worktree list --porcelain`, reduced to what retention needs. */
export interface WorktreeListEntry {
  path: string;
  branch?: string;
  detached: boolean;
}

/**
 * Everything the retention rules read about one worktree Cyberdeck created. Gathered by
 * `GitWorktreeInventory`, and kept separate from the rules so the rules can be tested as rules.
 */
export interface ProvisionedWorktree {
  path: string;
  branch?: string;
  provenance: WorktreeProvenance;
  /** Uncommitted changes, tracked or untracked. */
  dirty: boolean;
  /** Commits on this worktree's branch that the recorded base ref does not already contain. */
  commitsAheadOfBase: number;
  /** Whether those commits also exist on a remote-tracking ref. */
  pushed: boolean;
  /** A worker session that is still running here, if the caller knew of one. */
  liveSessionId?: string;
}

export type RetentionVerdict =
  | { keep: true; reason: string }
  | { keep: false; removeBranch: boolean; reason: string };

/**
 * Whether a worktree Cyberdeck created may be reclaimed, and what "reclaimed" is allowed to mean.
 *
 * The retention policy in one function, because the interesting half of automatic provisioning is
 * not creating worktrees but deciding when it is safe to stop keeping one. The rules, in order:
 *
 * 1. A worktree with a live worker in it is never touched. Its process is holding those files open.
 * 2. A dirty worktree is never touched. Uncommitted work exists nowhere else, and no amount of
 *    tidiness is worth it.
 * 3. A worktree whose commits exist only there — not in its base ref, not on any remote — is never
 *    touched. That is unlanded work, and reclaiming it is deleting it.
 * 4. Anything else is a directory whose contents are reproducible from refs that outlive it, so the
 *    directory goes. The *branch* goes only when the base ref already contains it; a pushed but
 *    unmerged branch keeps its name so the operator can still find the work by it.
 *
 * Nothing here runs on a timer. There is no age at which unlanded work becomes safe to delete, and
 * a worktree that is safe to delete is equally safe an hour later, so a clock would only decide
 * *when* the operator gets surprised.
 */
export function retentionVerdict(worktree: ProvisionedWorktree): RetentionVerdict {
  if (worktree.liveSessionId !== undefined) {
    return { keep: true, reason: `worker ${worktree.liveSessionId} is still running here` };
  }
  if (worktree.dirty) {
    return { keep: true, reason: "uncommitted changes" };
  }
  if (worktree.commitsAheadOfBase > 0 && !worktree.pushed) {
    const commits = worktree.commitsAheadOfBase;
    return {
      keep: true,
      reason: `${commits} commit${commits === 1 ? "" : "s"} not in ${worktree.provenance.baseRef} and not pushed`,
    };
  }
  return {
    keep: false,
    removeBranch: worktree.commitsAheadOfBase === 0,
    reason: worktree.commitsAheadOfBase === 0
      ? `nothing beyond ${worktree.provenance.baseRef}`
      : `${worktree.commitsAheadOfBase} commit(s) preserved on a remote`,
  };
}

/**
 * `git worktree list --porcelain` is a blank-line-separated stanza per worktree, each opening with
 * `worktree <path>`. Parsed rather than shelled through `--format` so the one shape this depends on
 * is documented here and testable without a repository.
 */
export function parseWorktreeList(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current !== undefined) entries.push(current);
      current = { path: line.slice("worktree ".length).trim(), detached: false };
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//u, "");
    } else if (line.trim() === "detached") {
      current.detached = true;
    }
  }
  if (current !== undefined) entries.push(current);
  return entries;
}

export interface WorktreeInventoryOptions {
  timeoutMs?: number;
  /** Session ids keyed by the cwd they are running in, so a live worker's worktree is left alone. */
  liveSessions?: ReadonlyMap<string, string>;
}

/** Reads a repository for the worktrees Cyberdeck created in it, and reclaims the safe ones. */
export class GitWorktreeInventory {
  private readonly timeoutMs: number;
  private readonly liveSessions: ReadonlyMap<string, string>;

  constructor(options: WorktreeInventoryOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.liveSessions = options.liveSessions ?? new Map();
  }

  /** Every worktree of `repositoryPath` that carries Cyberdeck provenance. Others are not ours. */
  async list(repositoryPath: string): Promise<ProvisionedWorktree[]> {
    const output = await this.git(repositoryPath, ["worktree", "list", "--porcelain"]) ?? "";
    const provisioned: ProvisionedWorktree[] = [];
    for (const entry of parseWorktreeList(output)) {
      const provenance = await this.provenance(entry.path);
      if (provenance === undefined) continue;
      const liveSessionId = this.liveSessions.get(resolve(entry.path));
      provisioned.push({
        path: entry.path,
        ...(entry.branch === undefined ? {} : { branch: entry.branch }),
        provenance,
        dirty: await this.dirty(entry.path),
        commitsAheadOfBase: await this.commitsAheadOfBase(entry.path, provenance),
        pushed: await this.pushed(entry.path),
        ...(liveSessionId === undefined ? {} : { liveSessionId }),
      });
    }
    return provisioned;
  }

  /**
   * Reclaim one worktree the rules cleared. Neither call is forced, so git remains the last check:
   * if anything changed between the verdict and here, the removal fails rather than overrides.
   */
  async remove(worktree: ProvisionedWorktree, removeBranch: boolean): Promise<void> {
    const repository = worktree.provenance.repositoryPath;
    await this.git(repository, ["worktree", "remove", worktree.path]);
    if (removeBranch && worktree.branch !== undefined) {
      await this.git(repository, ["branch", "-d", worktree.branch]).catch(() => undefined);
    }
  }

  private async provenance(worktreePath: string): Promise<WorktreeProvenance | undefined> {
    const adminDirectory = await this.git(worktreePath, ["rev-parse", "--absolute-git-dir"])
      .catch(() => undefined);
    if (adminDirectory === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(adminDirectory, PROVENANCE_FILENAME), "utf8"),
      );
      return isProvenance(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async dirty(worktreePath: string): Promise<boolean> {
    const status = await this.git(worktreePath, ["status", "--porcelain"]).catch(() => "dirty");
    return status !== undefined && status !== "";
  }

  private async commitsAheadOfBase(
    worktreePath: string,
    provenance: WorktreeProvenance,
  ): Promise<number> {
    const count = await this
      .git(worktreePath, ["rev-list", "--count", `${provenance.baseRef}..HEAD`])
      .catch(() => undefined);
    // An unanswerable question is not an empty answer: a base ref that no longer resolves means the
    // worktree is kept, which is what a large positive count produces.
    return count === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(count, 10);
  }

  private async pushed(worktreePath: string): Promise<boolean> {
    const ahead = await this
      .git(worktreePath, ["rev-list", "--count", "@{upstream}..HEAD"])
      .catch(() => undefined);
    return ahead === "0";
  }

  private async git(cwd: string, args: string[]): Promise<string | undefined> {
    const { stdout } = await run("git", ["-C", cwd, ...args], {
      timeout: this.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  }
}

function isProvenance(value: unknown): value is WorktreeProvenance {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && typeof candidate.sessionId === "string"
    && typeof candidate.branch === "string"
    && typeof candidate.baseRef === "string"
    && typeof candidate.repositoryPath === "string"
    && typeof candidate.worktreePath === "string";
}
