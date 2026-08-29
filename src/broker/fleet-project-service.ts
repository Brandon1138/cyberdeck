import { basename, dirname, resolve } from "node:path";
import type { GitOutput } from "../domain/worktree-review.js";

/**
 * Exactly the preference rows a project registry reads and writes.
 *
 * Narrow on purpose: the concrete store also holds folder dispositions, launch profiles, and
 * detach identities, none of which this service has any business reaching for.
 */
export interface FleetProjectStore {
  listProjects(): Promise<string[]>;
  projectDispositions(): Promise<Map<string, boolean>>;
  setProject(root: string, registered: boolean): Promise<void>;
  projectMigrationCompleted(): Promise<boolean>;
  completeProjectMigration(): Promise<void>;
}

/** Where a path sits in git, once the difference between a repository and a worktree matters. */
export interface ProjectResolution {
  /** The git top-level containing the path. */
  toplevel: string;
  /** The repository the Fleet list would group under — the parent when `toplevel` is linked. */
  root: string;
  /** True when `toplevel` is a linked worktree whose repository lives at `root`. */
  linkedWorktree: boolean;
}

export type FleetProjectAddResult =
  | { status: "registered"; root: string; toplevel: string; alreadyRegistered: boolean }
  /**
   * The path is a linked worktree. Registering it would give one per-task checkout a section of
   * its own, which is the shape the registry exists to collapse, so the parent is offered and
   * nothing is written until the operator says which one they meant.
   */
  | { status: "worktree"; root: string; toplevel: string };

export interface FleetProjectRemoveResult {
  removed: boolean;
  root: string;
}

export interface FleetProjectSeedResult {
  seeded: boolean;
  roots: readonly string[];
}

export interface FleetProjectServiceOptions {
  store: FleetProjectStore;
  /** The git boundary, injected so resolution is testable without repositories on disk. */
  gitIn: (cwd: string) => GitOutput;
}

/**
 * The operator's project registry.
 *
 * Grouping the Fleet list by `cwd` made every per-task worktree and scratch directory a top-level
 * folder. What the operator has is a handful of repositories, so the registry names those and
 * everything else folds underneath the longest one that contains it.
 */
export class FleetProjectService {
  private readonly store: FleetProjectStore;
  private readonly gitIn: (cwd: string) => GitOutput;

  constructor(options: FleetProjectServiceOptions) {
    this.store = options.store;
    this.gitIn = options.gitIn;
  }

  list(): Promise<string[]> {
    return this.store.listProjects();
  }

  async add(
    request: { path: string; acceptParent?: boolean | undefined },
  ): Promise<FleetProjectAddResult> {
    const resolution = await this.resolve(request.path);
    if (resolution === undefined) {
      throw Object.assign(
        new Error(`Not a Git repository: ${resolve(request.path)}`),
        { code: "INVALID_REQUEST" },
      );
    }
    // A worktree is only registered when the operator has been shown the parent and still meant
    // the worktree; the default answer is the repository.
    if (resolution.linkedWorktree && request.acceptParent !== true) {
      return { status: "worktree", root: resolution.root, toplevel: resolution.toplevel };
    }
    const root = resolution.linkedWorktree ? resolution.root : resolution.toplevel;
    const alreadyRegistered = (await this.store.projectDispositions()).get(root) === true;
    if (!alreadyRegistered) await this.store.setProject(root, true);
    return { status: "registered", root, toplevel: resolution.toplevel, alreadyRegistered };
  }

  /**
   * Unregister a root. Threads are never touched: they fall through to the unregistered bucket,
   * which is exactly what makes removal safe to press.
   */
  async remove(request: { path: string }): Promise<FleetProjectRemoveResult> {
    const literal = resolve(request.path);
    const dispositions = await this.store.projectDispositions();
    if (dispositions.get(literal) === true) {
      await this.store.setProject(literal, false);
      return { removed: true, root: literal };
    }
    // A removed repository still has to be removable, so git is only consulted when the literal
    // path is not itself the registered root.
    const resolution = await this.resolve(literal);
    const root = resolution === undefined
      ? literal
      : resolution.linkedWorktree
        ? resolution.root
        : resolution.toplevel;
    if (dispositions.get(root) !== true) return { removed: false, root };
    await this.store.setProject(root, false);
    return { removed: true, root };
  }

  /**
   * Seed the registry once from the directories threads already live in.
   *
   * Only roots the registry has never had an opinion about are added, so a root the operator
   * removed stays removed even if a thread still points inside it. The pass is marked complete
   * whether or not it found anything: a second scan would re-add nothing and cost a git process
   * per directory.
   */
  async seed(cwds: readonly string[]): Promise<FleetProjectSeedResult> {
    if (await this.store.projectMigrationCompleted()) return { seeded: false, roots: [] };
    const dispositions = await this.store.projectDispositions();
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const cwd of new Set(cwds)) {
      // Git's own directory is never a project, and a thread parked inside one is not evidence
      // of a repository the operator works in.
      if (cwd === "" || /(?:^|\/)\.git(?:\/|$)/u.test(cwd)) continue;
      const resolution = await this.resolve(cwd);
      if (resolution === undefined) continue;
      const root = resolution.linkedWorktree ? resolution.root : resolution.toplevel;
      if (seen.has(root) || dispositions.has(root)) continue;
      seen.add(root);
      await this.store.setProject(root, true);
      roots.push(root);
    }
    await this.store.completeProjectMigration();
    return { seeded: true, roots: roots.sort((left, right) => left.localeCompare(right)) };
  }

  /**
   * Read the repository behind a path, or `undefined` when git has none.
   *
   * A linked worktree is told apart from its repository by `--git-dir` disagreeing with
   * `--git-common-dir`; the repository is then the directory holding that common `.git`. A common
   * directory that is not called `.git` is a bare repository with no working tree to offer, so the
   * top-level stands as its own root rather than being replaced by a guess at its parent.
   */
  private async resolve(path: string): Promise<ProjectResolution | undefined> {
    const absolute = resolve(path);
    const git = this.gitIn(absolute);
    const toplevel = await git(["rev-parse", "--show-toplevel"])
      .then((value) => value.trim(), () => "");
    if (toplevel === "") return undefined;
    const [gitDir, commonDir] = await Promise.all([
      git(["rev-parse", "--git-dir"]).then((value) => value.trim(), () => ""),
      git(["rev-parse", "--git-common-dir"]).then((value) => value.trim(), () => ""),
    ]);
    // Both are reported relative to the directory git ran in when they are not absolute.
    const resolvedGitDir = gitDir === "" ? "" : resolve(absolute, gitDir);
    const resolvedCommonDir = commonDir === "" ? "" : resolve(absolute, commonDir);
    const linked = resolvedGitDir !== ""
      && resolvedCommonDir !== ""
      && resolvedGitDir !== resolvedCommonDir
      && basename(resolvedCommonDir) === ".git";
    return {
      toplevel,
      root: linked ? dirname(resolvedCommonDir) : toplevel,
      linkedWorktree: linked,
    };
  }
}
