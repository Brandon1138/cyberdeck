import { isAbsolute, relative, resolve } from "node:path";
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
 */
export const WorkerProvisioningSchema = z.enum(["pre-provisioned", "worker-provisioned"]);

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
  /** The worktree the worker runs in. `cwd` must be this path or inside it. */
  worktreePath: AbsolutePathSchema,
  /** The branch the worker's commits land on. */
  branch: RefNameSchema,
  /** The ref the branch was cut from, and the baseline a review diffs against. */
  baseRef: RefNameSchema,
  provisioning: WorkerProvisioningSchema,
  /**
   * Absolute directories that must be writable in addition to the worktree. For a
   * `worker-provisioned` workspace this must cover the repository's git common directory, because
   * `git worktree add` writes the new ref and the new worktree administrative directory there.
   */
  writableRoots: z.array(AbsolutePathSchema).max(8).default([]),
}).strict();

export type WorkerProvisioning = z.infer<typeof WorkerProvisioningSchema>;
export type WorkerWorkspace = z.infer<typeof WorkerWorkspaceSchema>;

export type WorkerWorkspaceFailureCode =
  | "WORKSPACE_CWD_OUTSIDE_WORKTREE"
  | "WORKSPACE_PROVISIONING_REQUIRES_WRITE"
  | "WORKSPACE_GIT_DIR_NOT_WRITABLE"
  | "WORKSPACE_TARGET_NOT_WRITABLE"
  | "WORKSPACE_WORKTREE_MISSING"
  | "WORKSPACE_BRANCH_MISMATCH"
  | "WORKSPACE_BASE_REF_UNRESOLVED";

export type WorkerWorkspaceCheck =
  | { ok: true; value: WorkerWorkspace }
  | { ok: false; code: WorkerWorkspaceFailureCode; message: string };

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
  // is about to create.
  if (workspace.provisioning === "pre-provisioned" && !contains(workspace.worktreePath, cwd)) {
    return {
      ok: false,
      code: "WORKSPACE_CWD_OUTSIDE_WORKTREE",
      message: `Worker cwd ${cwd} is outside its declared worktree ${workspace.worktreePath}`,
    };
  }
  if (workspace.provisioning === "worker-provisioned" && contains(workspace.worktreePath, cwd)) {
    return {
      ok: false,
      code: "WORKSPACE_CWD_OUTSIDE_WORKTREE",
      message:
        `Worker cwd ${cwd} is inside the worktree ${workspace.worktreePath} it is supposed to `
        + "create. Start the worker in the repository the worktree is cut from.",
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

  if (workspace.provisioning === "worker-provisioned") {
    // The provider grants the session its cwd and the declared writable roots, and nothing else.
    // `git worktree add` writes in two places, and neither is granted by default: the new worktree
    // directory, and refs/heads/<branch> plus worktrees/<name> under the git common directory of
    // the *source* repository.
    if (!coveredByWritableRoot([cwd, ...workspace.writableRoots], workspace.worktreePath)) {
      return {
        ok: false,
        code: "WORKSPACE_TARGET_NOT_WRITABLE",
        message:
          `A worker-provisioned workspace must be able to create ${workspace.worktreePath}, which is `
          + `outside the worker's cwd ${cwd}. Add ${workspace.worktreePath} or its parent to `
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

  const root = await probe.worktreeRoot(workspace.worktreePath);
  if (root === undefined || resolve(root) !== resolve(workspace.worktreePath)) {
    return {
      ok: false,
      code: "WORKSPACE_WORKTREE_MISSING",
      message: root === undefined
        ? `Declared worktree ${workspace.worktreePath} is not a git worktree; nothing pre-provisioned it`
        : `Declared worktree ${workspace.worktreePath} is inside worktree ${root}, not its root`,
    };
  }
  const branch = await probe.checkedOutBranch(workspace.worktreePath);
  if (branch !== workspace.branch) {
    return {
      ok: false,
      code: "WORKSPACE_BRANCH_MISMATCH",
      message:
        `Declared branch ${workspace.branch} is not checked out at ${workspace.worktreePath}`
        + `${branch === undefined ? " (detached HEAD)" : `; found ${branch}`}`,
    };
  }
  if (!await probe.refResolves(workspace.worktreePath, workspace.baseRef)) {
    return {
      ok: false,
      code: "WORKSPACE_BASE_REF_UNRESOLVED",
      message: `Base ref ${workspace.baseRef} does not resolve in ${workspace.worktreePath}`,
    };
  }
  return shape;
}

/** The writable roots a launch must grant: the declared extras, deduplicated and normalized. */
export function workspaceWritableRoots(workspace: WorkerWorkspace | undefined): string[] {
  if (workspace === undefined) return [];
  const seen = new Set<string>();
  for (const root of workspace.writableRoots) {
    const normalized = resolve(root);
    if (normalized !== resolve(workspace.worktreePath)) seen.add(normalized);
  }
  return [...seen].sort();
}
