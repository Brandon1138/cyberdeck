import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

/**
 * Where a worker's work lives, as typed fields rather than as prose in a prompt.
 *
 * Before this existed, a dispatch that required a git worktree said so only in the worker's
 * instructions. The broker could not check that the worktree was there, could not tell whether the
 * worker was expected to create it, and therefore could not notice that the sandbox it was about to
 * grant made creating it impossible. The 2026-08-14 failure was exactly that: workers were told to
 * run `git worktree add` inside a sandbox whose only writable root was the worktree that did not
 * exist yet, and the denial surfaced as `cannot lock ref ... 'Operation not permitted'`.
 *
 * `cyberdeck-provisioned` is the third mode and the one an orchestrator should reach for: Cyberdeck
 * itself runs `git worktree add` before a provider process exists. The worker never touches git
 * plumbing, so it needs neither the write grant on the repository's git common directory nor a
 * prompt that explains how to make its own isolation — which is what makes the 2026-08-14 failure
 * unreachable from this mode rather than merely diagnosed.
 */
export const WorkerProvisioningSchema = z.enum([
  "pre-provisioned",
  "worker-provisioned",
  "cyberdeck-provisioned",
]);

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, "path must be absolute");

/**
 * A ref name Cyberdeck is willing to hand to `git`. Deliberately narrower than `git check-ref-format`:
 * everything rejected here is either a flag-injection shape or a name no dispatch has ever needed.
 */
const RefNameSchema = z.string().trim().min(1).max(255)
  .refine((value) => !value.startsWith("-"), "ref must not start with '-'")
  .refine((value) => !/[\s~^:?*[\\]/u.test(value), "ref must not contain whitespace or git glob characters")
  .refine((value) => !value.includes(".."), "ref must not contain '..'");

export const WorkerWorkspaceSchema = z.object({
  /**
   * The worktree the worker runs in. `cwd` must be this path or inside it.
   *
   * Optional only for `cyberdeck-provisioned`, where naming the worktree is Cyberdeck's job rather
   * than the caller's: an orchestrator that has to invent a path is one step away from having to
   * invent the `git worktree add` that creates it. A caller that does want a specific path may still
   * say so, and that path is used verbatim.
   */
  worktreePath: AbsolutePathSchema.optional(),
  /** The branch the worker's commits land on. */
  branch: RefNameSchema,
  /** The ref the branch was cut from, and the baseline a review diffs against. */
  baseRef: RefNameSchema,
  provisioning: WorkerProvisioningSchema,
  /**
   * The repository the worktree belongs to. Recorded by Cyberdeck when it provisions, so a worker
   * living in a sibling directory can still be shown under the project it is working on rather than
   * as a stray root of its own.
   */
  repositoryPath: AbsolutePathSchema.optional(),
  /**
   * Absolute directories that must be writable in addition to the worktree. For a
   * `worker-provisioned` workspace this must cover the repository's git common directory, because
   * `git worktree add` writes the new ref and the new worktree administrative directory there. A
   * `cyberdeck-provisioned` workspace needs neither, because the worker never runs that command.
   */
  writableRoots: z.array(AbsolutePathSchema).max(8).default([]),
}).strict().superRefine((workspace, context) => {
  if (workspace.provisioning !== "cyberdeck-provisioned" && workspace.worktreePath === undefined) {
    context.addIssue({
      code: "custom",
      path: ["worktreePath"],
      message: `worktreePath is required for provisioning ${workspace.provisioning}`,
    });
  }
});

export type WorkerProvisioning = z.infer<typeof WorkerProvisioningSchema>;
export type WorkerWorkspace = z.infer<typeof WorkerWorkspaceSchema>;

export type WorkerWorkspaceFailureCode =
  | "WORKSPACE_CWD_OUTSIDE_WORKTREE"
  | "WORKSPACE_PROVISIONING_REQUIRES_WRITE"
  | "WORKSPACE_GIT_DIR_NOT_WRITABLE"
  | "WORKSPACE_TARGET_NOT_WRITABLE"
  | "WORKSPACE_WORKTREE_MISSING"
  | "WORKSPACE_BRANCH_MISMATCH"
  | "WORKSPACE_BASE_REF_UNRESOLVED"
  | "WORKSPACE_BRANCH_EXISTS"
  | "WORKSPACE_TARGET_EXISTS";

export type WorkerWorkspaceCheck =
  | { ok: true; value: WorkerWorkspace }
  | { ok: false; code: WorkerWorkspaceFailureCode; message: string };

/**
 * The naming policy for a worktree Cyberdeck creates, in one place because it is the half of
 * provisioning an operator has to be able to predict. A worker's worktree is a *sibling* of the
 * repository it was cut from, named `<repository>-<branch leaf>`:
 *
 * ```text
 * /Users/x/code/cyberdeck        the repository
 * /Users/x/code/cyberdeck-mik-75 the worktree for branch brandon/mik-75
 * ```
 *
 * Sibling rather than nested, because a worktree inside the repository's working tree shows up as
 * an untracked directory in every `git status` the operator and every other worker runs. Named
 * after the branch rather than the session id, because the operator finds this directory by
 * remembering what the work was, and a uuid is not that. Deterministic rather than uniquified with
 * a counter: a collision means the branch leaf is already provisioned, and answering that by
 * silently picking `-2` is how a fleet ends up with three worktrees nobody can tell apart.
 */
export function provisionedWorktreeSlug(branch: string): string {
  const leaf = branch.split("/").filter((segment) => segment !== "").at(-1) ?? branch;
  const slug = leaf.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (slug === "" ? "worktree" : slug).slice(0, 48).replace(/-+$/u, "");
}

/** Where `provisionedWorktreeSlug` says the worktree for `branch` cut from `repositoryPath` goes. */
export function defaultProvisionedWorktreePath(repositoryPath: string, branch: string): string {
  const root = resolve(repositoryPath);
  return join(dirname(root), `${basename(root)}-${provisionedWorktreeSlug(branch)}`);
}

/** What the broker must be able to learn about a repository to validate a workspace. */
export interface WorkspaceProbe {
  /** Absolute `--git-common-dir` of the repository containing `path`, or undefined if it is not one. */
  gitCommonDirectory(path: string): Promise<string | undefined>;
  /** Absolute `--show-toplevel` of the worktree at `path`, or undefined if `path` is not a worktree. */
  worktreeRoot(path: string): Promise<string | undefined>;
  /** The branch checked out at `path`, or undefined when detached or absent. */
  checkedOutBranch(path: string): Promise<string | undefined>;
  /** Whether `ref` resolves in the repository containing `path`. */
  refResolves(path: string, ref: string): Promise<boolean>;
}

/**
 * The git boundary a `cyberdeck-provisioned` workspace needs, injected so the broker can be tested
 * without a repository and so the one place that runs `git worktree add` on a worker's behalf is
 * nameable. `provision` is called before a provider process exists; `discard` is called only when
 * the start that created the worktree failed before that process existed.
 */
export interface WorktreeProvisioner {
  provision(request: WorktreeProvisionRequest): Promise<ProvisionedWorktree>;
  /**
   * Give back a worktree whose worker never started. Never forces: a worktree that has somehow
   * acquired changes in the seconds it existed is left alone and reported, because deleting an
   * operator's work to tidy up a failed launch is worse than leaving a directory behind.
   */
  discard(workspace: WorkerWorkspace): Promise<void>;
}

export interface WorktreeProvisionRequest {
  /** Validated workspace. `worktreePath` and `repositoryPath` may still be unresolved. */
  workspace: WorkerWorkspace;
  /** Where the worker was asked to start: the repository the worktree is cut from. */
  cwd: string;
  /** The session the worktree is being made for, recorded so later hygiene knows whose it was. */
  sessionId: string;
}

export interface ProvisionedWorktree {
  /** The workspace as built, with `worktreePath` and `repositoryPath` populated. */
  workspace: WorkerWorkspace;
  /**
   * The commit `workspace.baseRef` named when the worktree was cut. Declared bases are symbolic —
   * the composer says `HEAD` — and a symbolic name re-read inside the worktree later answers with
   * the worktree's own tip, which is why the baseline has to be pinned to a commit here.
   */
  baseCommit: string;
  /** Things the worker's operator should know, e.g. that the worktree has no `node_modules`. */
  warnings: string[];
}

function contains(parent: string, child: string): boolean {
  const from = resolve(parent);
  const to = resolve(child);
  if (from === to) return true;
  const step = relative(from, to);
  return step !== "" && !step.startsWith("..") && !isAbsolute(step);
}

function coveredByWritableRoot(
  roots: readonly string[],
  path: string,
): boolean {
  return roots.some((root) => contains(root, path));
}

/**
 * Checks that can be made without touching a repository. Kept separate so a caller that has no
 * probe — a schema-level validation, a test — still gets the contradiction failures, which are the
 * ones that produce a worker that starts and then cannot act.
 */
export function checkWorkerWorkspaceShape(
  workspace: WorkerWorkspace,
  cwd: string,
): WorkerWorkspaceCheck {
  // Only a pre-provisioned worker starts inside its worktree. A worker-provisioned one starts in
  // the repository it will run `git worktree add` from, which is by definition not the worktree it
  // is about to create. A cyberdeck-provisioned one starts in that same repository and is *moved*
  // into its worktree once the directory exists.
  const declared = workspace.worktreePath;
  if (
    workspace.provisioning === "pre-provisioned"
    && (declared === undefined || !contains(declared, cwd))
  ) {
    return {
      ok: false,
      code: "WORKSPACE_CWD_OUTSIDE_WORKTREE",
      message: `Worker cwd ${cwd} is outside its declared worktree ${declared ?? "(undeclared)"}`,
    };
  }
  if (workspace.provisioning !== "pre-provisioned" && declared !== undefined && contains(declared, cwd)) {
    return {
      ok: false,
      code: "WORKSPACE_CWD_OUTSIDE_WORKTREE",
      message: workspace.provisioning === "worker-provisioned"
        ? `Worker cwd ${cwd} is inside the worktree ${declared} it is supposed to create. `
          + "Start the worker in the repository the worktree is cut from."
        : `Worker cwd ${cwd} is inside the worktree ${declared} Cyberdeck is being asked to create. `
          + "Start the worker in the repository the worktree is cut from.",
    };
  }
  return { ok: true, value: workspace };
}

export interface WorkerWorkspaceValidation {
  workspace: WorkerWorkspace;
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  probe?: WorkspaceProbe | undefined;
}

/**
 * The full check, run before a worker process exists.
 *
 * A `worker-provisioned` workspace is the case that used to fail silently: the worker was granted
 * write access to a directory that did not exist yet and denied it everywhere `git worktree add`
 * actually writes. It now fails here, naming the git common directory the dispatch has to add.
 */
export async function validateWorkerWorkspace(
  input: WorkerWorkspaceValidation,
): Promise<WorkerWorkspaceCheck> {
  const { workspace, cwd, sandbox, probe } = input;
  const shape = checkWorkerWorkspaceShape(workspace, cwd);
  if (!shape.ok) return shape;

  if (workspace.provisioning === "worker-provisioned" && sandbox !== "workspace-write") {
    return {
      ok: false,
      code: "WORKSPACE_PROVISIONING_REQUIRES_WRITE",
      message:
        `Workspace ${workspace.worktreePath} is worker-provisioned, so the worker must run `
        + "`git worktree add`, which a read-only sandbox denies. Request sandbox workspace-write, or "
        + "pre-provision the worktree and declare provisioning pre-provisioned.",
    };
  }

  if (probe === undefined) return shape;

  if (workspace.provisioning === "cyberdeck-provisioned") {
    return validateCyberdeckProvisioned(workspace, cwd, probe);
  }

  if (workspace.provisioning === "worker-provisioned") {
    // `worktreePath` is required for this mode by the schema; the local binding is what lets the
    // rest of the branch read as the check it is rather than as a chain of assertions.
    const target = workspace.worktreePath ?? cwd;
    // The provider grants the session its cwd and the declared writable roots, and nothing else.
    // `git worktree add` writes in two places, and neither is granted by default: the new worktree
    // directory, and refs/heads/<branch> plus worktrees/<name> under the git common directory of
    // the *source* repository.
    if (!coveredByWritableRoot([cwd, ...workspace.writableRoots], target)) {
      return {
        ok: false,
        code: "WORKSPACE_TARGET_NOT_WRITABLE",
        message:
          `A worker-provisioned workspace must be able to create ${target}, which is `
          + `outside the worker's cwd ${cwd}. Add ${target} or its parent to `
          + "writableRoots.",
      };
    }
    const common = await probe.gitCommonDirectory(cwd);
    if (common === undefined) {
      return {
        ok: false,
        code: "WORKSPACE_WORKTREE_MISSING",
        message: `Worker cwd ${cwd} is not inside a git repository, so no worktree can be created from it`,
      };
    }
    if (!coveredByWritableRoot([cwd, ...workspace.writableRoots], common)) {
      return {
        ok: false,
        code: "WORKSPACE_GIT_DIR_NOT_WRITABLE",
        message:
          `A worker-provisioned workspace must be able to write ${common}, where \`git worktree add\` `
          + `creates refs/heads/${workspace.branch} and the worktree administrative directory. `
          + `Add ${common} to writableRoots.`,
      };
    }
    if (!await probe.refResolves(cwd, workspace.baseRef)) {
      return {
        ok: false,
        code: "WORKSPACE_BASE_REF_UNRESOLVED",
        message: `Base ref ${workspace.baseRef} does not resolve in the repository at ${cwd}`,
      };
    }
    return shape;
  }

  const worktreePath = workspace.worktreePath ?? cwd;
  const root = await probe.worktreeRoot(worktreePath);
  if (root === undefined || resolve(root) !== resolve(worktreePath)) {
    return {
      ok: false,
      code: "WORKSPACE_WORKTREE_MISSING",
      message: root === undefined
        ? `Declared worktree ${worktreePath} is not a git worktree; nothing pre-provisioned it`
        : `Declared worktree ${worktreePath} is inside worktree ${root}, not its root`,
    };
  }
  const branch = await probe.checkedOutBranch(worktreePath);
  if (branch !== workspace.branch) {
    return {
      ok: false,
      code: "WORKSPACE_BRANCH_MISMATCH",
      message:
        `Declared branch ${workspace.branch} is not checked out at ${worktreePath}`
        + `${branch === undefined ? " (detached HEAD)" : `; found ${branch}`}`,
    };
  }
  if (!await probe.refResolves(worktreePath, workspace.baseRef)) {
    return {
      ok: false,
      code: "WORKSPACE_BASE_REF_UNRESOLVED",
      message: `Base ref ${workspace.baseRef} does not resolve in ${worktreePath}`,
    };
  }
  return shape;
}

/**
 * Everything that has to be true before Cyberdeck runs `git worktree add` on a worker's behalf.
 *
 * The point of checking here rather than reading git's exit code afterwards is that all four
 * answers are actionable by the caller *and* the resolved worktree path comes back with them: the
 * caller declared a branch and a base, and this is where it learns the path Cyberdeck's naming
 * policy picked for them. Nothing on this path needs a write grant, because the worker is not the
 * one creating anything.
 */
async function validateCyberdeckProvisioned(
  workspace: WorkerWorkspace,
  cwd: string,
  probe: WorkspaceProbe,
): Promise<WorkerWorkspaceCheck> {
  const repositoryPath = await probe.worktreeRoot(cwd);
  if (repositoryPath === undefined) {
    return {
      ok: false,
      code: "WORKSPACE_WORKTREE_MISSING",
      message: `Worker cwd ${cwd} is not inside a git repository, so no worktree can be cut from it`,
    };
  }
  const worktreePath = workspace.worktreePath
    ?? defaultProvisionedWorktreePath(repositoryPath, workspace.branch);
  if (contains(worktreePath, cwd)) {
    return {
      ok: false,
      code: "WORKSPACE_CWD_OUTSIDE_WORKTREE",
      message:
        `Worker cwd ${cwd} is inside the worktree ${worktreePath} Cyberdeck is being asked to `
        + "create. Start the worker in the repository the worktree is cut from.",
    };
  }
  if (!await probe.refResolves(cwd, workspace.baseRef)) {
    return {
      ok: false,
      code: "WORKSPACE_BASE_REF_UNRESOLVED",
      message: `Base ref ${workspace.baseRef} does not resolve in the repository at ${cwd}`,
    };
  }
  // A branch that already exists is either another worker's or the operator's. Checking it out into
  // a second worktree is what git refuses anyway; refusing it here says which branch and why.
  if (await probe.refResolves(cwd, `refs/heads/${workspace.branch}`)) {
    return {
      ok: false,
      code: "WORKSPACE_BRANCH_EXISTS",
      message:
        `Branch ${workspace.branch} already exists in ${repositoryPath}. Pick a branch nothing has `
        + "claimed, or pre-provision the worktree yourself and declare provisioning pre-provisioned.",
    };
  }
  if (await probe.worktreeRoot(worktreePath) !== undefined) {
    return {
      ok: false,
      code: "WORKSPACE_TARGET_EXISTS",
      message:
        `${worktreePath} is already a git worktree. Cyberdeck will not reuse or overwrite it; `
        + "declare a different branch, or name a free worktreePath explicitly.",
    };
  }
  return { ok: true, value: { ...workspace, worktreePath, repositoryPath } };
}

/**
 * The writable roots a launch must grant: the declared extras, deduplicated and normalized.
 *
 * A `pre-provisioned` worker's own worktree is dropped, and only because that worker launches
 * inside it — the provider already grants the session its cwd, so re-granting the worktree emits an
 * argument that says nothing. A `cyberdeck-provisioned` worker is dropped for the same reason and
 * one step later: by the time a provider process exists, the worktree is there and is its cwd.
 * A `worker-provisioned` worker launches in the *source* repository instead, so its target is
 * neither inside cwd nor created yet; a declared `worktreePath` root is the grant that lets
 * `git worktree add` create it, and dropping it is what left the 2026-08-14 worker unable to write
 * the very directory it was dispatched to make.
 */
export function workspaceWritableRoots(workspace: WorkerWorkspace | undefined): string[] {
  if (workspace === undefined) return [];
  const alreadyGranted = workspace.provisioning !== "worker-provisioned"
    && workspace.worktreePath !== undefined
    ? resolve(workspace.worktreePath)
    : undefined;
  const seen = new Set<string>();
  for (const root of workspace.writableRoots) {
    const normalized = resolve(root);
    if (normalized !== alreadyGranted) seen.add(normalized);
  }
  return [...seen].sort();
}
