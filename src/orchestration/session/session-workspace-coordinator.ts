import type { StartSessionRequest } from "../../domain/session.js";
import { scoutScopeViolation } from "../../domain/worker-profile.js";
import type {
  ProvisionedWorktree,
  WorktreeProvisioner,
} from "../../domain/worker-workspace.js";
import type {
  ScoutWorkspaceVerdict,
  SessionCwdCheck,
  WorkspaceProvisioningJournal,
  WorkspaceStateReader,
} from "./session-workspace-ports.js";

/**
 * Every way preparing a session's workspace can refuse the start, with the code the caller reports.
 *
 * Separate from the registry's own error type on purpose: the coordinator knows what went wrong
 * with a workspace, not what a broker RPC calls it. The registry translates one to the other, so
 * the code and the message reach a client byte-identical to before this file existed.
 */
export type SessionWorkspaceErrorCode =
  | "INVALID_SESSION_CWD"
  | "INVALID_WORKER_PROFILE"
  | "WORKSPACE_PROVISIONER_UNAVAILABLE"
  | "WORKSPACE_PROVISION_FAILED";

export class SessionWorkspaceError extends Error {
  constructor(readonly code: SessionWorkspaceErrorCode, message: string) {
    super(message);
    this.name = "SessionWorkspaceError";
  }
}

export interface SessionWorkspaceCoordinatorOptions {
  journal: WorkspaceProvisioningJournal;
  /**
   * Refuses an inaccessible cwd. Optional only so a caller that has already validated the path — a
   * test harness, a replay — can say so; absent means every cwd is accepted.
   */
  validateCwd?: SessionCwdCheck | undefined;
  /** Reads observable repository state for the Scout canary. Absent means a Scout cannot verify. */
  workspaceState?: WorkspaceStateReader | undefined;
  /**
   * Creates the worktree for a `cyberdeck-provisioned` workspace. Absent means the broker cannot
   * provision, and a start that asks it to is refused rather than quietly downgraded to running in
   * whatever checkout the caller happened to name.
   */
  provisioner?: WorktreeProvisioner | undefined;
}

/**
 * Prepares and verifies the workspace one session runs in.
 *
 * The four things collected here used to sit inside the registry, interleaved with admission,
 * spawning, and attachment: refusing an unusable cwd, cutting and giving back a worktree, reading
 * repository state once per directory however many callers ask, and deciding whether a Scout left
 * that repository as it found it. They belong together because they share one ordering constraint —
 * nothing here may run after a provider process exists — and one rollback rule: a worktree is given
 * back only when *this* start created it, and never by force.
 *
 * The registry keeps admission and keeps the journal. This owns what a workspace has to be true of.
 */
export class SessionWorkspaceCoordinator {
  /**
   * One in-flight capture per directory. Two Scouts in the same repository, or a pre-launch capture
   * racing another session's post-run verification, would otherwise run `git status` and a full
   * tracked diff twice over the same tree and answer the same thing.
   */
  private readonly stateInflight = new Map<string, Promise<string>>();

  constructor(private readonly options: SessionWorkspaceCoordinatorOptions) {}

  /**
   * Everything about a start request that can be refused before an id exists: the Scout profile's
   * fixed shape, the scope its brief is allowed to name, and whether its cwd is a directory at all.
   *
   * Runs before admission so a request that could never launch never consumes a worker slot.
   */
  async verifyStartRequest(request: StartSessionRequest): Promise<void> {
    if (request.profile === "scout") {
      if (request.brief === undefined) {
        throw new SessionWorkspaceError("INVALID_WORKER_PROFILE", "Scout profile requires a structured brief");
      }
      if ((request.kind ?? "worker") !== "worker") {
        throw new SessionWorkspaceError("INVALID_WORKER_PROFILE", "Scout profile can only use worker lifecycle");
      }
      if (
        request.provider !== "cursor"
        || request.model !== "composer"
        || request.sandbox !== "read-only"
        || request.approvalMode !== "auto"
        || request.workerMode === "caveman"
      ) {
        throw new SessionWorkspaceError(
          "INVALID_WORKER_PROFILE",
          "Scout profile requires Cursor Composer, read-only sandbox, auto approval, and normal worker mode",
        );
      }
      const scopeViolation = scoutScopeViolation(request.cwd, request.brief.scope);
      if (scopeViolation !== undefined) {
        throw new SessionWorkspaceError("INVALID_WORKER_PROFILE", scopeViolation);
      }
    }
    await this.options.validateCwd?.(request.cwd);
  }

  /**
   * Create the worktree a `cyberdeck-provisioned` start asked for, and answer with nothing for
   * every other mode.
   *
   * This is the whole of "an orchestrator no longer shells out": the declaration reached the broker
   * as typed fields, the broker owns the one `git worktree add`, and the worker's cwd becomes the
   * worktree it never had to know how to make. Every other provisioning mode is untouched — a
   * pre-provisioned worktree is still validated and used as-is, and a worker-provisioned one still
   * gets the grants that let the worker do it itself.
   */
  async provision(
    request: StartSessionRequest,
    sessionId: string,
  ): Promise<ProvisionedWorktree | undefined> {
    const workspace = request.workspace;
    if (workspace?.provisioning !== "cyberdeck-provisioned") return undefined;
    const provisioner = this.options.provisioner;
    if (provisioner === undefined) {
      throw new SessionWorkspaceError(
        "WORKSPACE_PROVISIONER_UNAVAILABLE",
        "This broker cannot provision worktrees; pre-provision one and declare provisioning "
        + "pre-provisioned",
      );
    }
    let provisioned: ProvisionedWorktree;
    try {
      provisioned = await provisioner.provision({ workspace, cwd: request.cwd, sessionId });
    } catch (error) {
      throw new SessionWorkspaceError("WORKSPACE_PROVISION_FAILED", errorMessage(error));
    }
    // Everything past this point has a worktree behind it, and throwing from here would return no
    // `ProvisionedWorktree` for the caller's discard path to act on: the start would fail leaving
    // the branch and the directory behind, and the deterministic naming means the retry that
    // follows is refused with WORKSPACE_BRANCH_EXISTS. So this failure gives the worktree back
    // itself — still non-forced, so anything that somehow landed in it survives.
    try {
      await this.options.journal.workspaceProvisioned(sessionId, {
        worktreePath: provisioned.workspace.worktreePath ?? null,
        repositoryPath: provisioned.workspace.repositoryPath ?? null,
        branch: provisioned.workspace.branch,
        baseRef: provisioned.workspace.baseRef,
        baseCommit: provisioned.baseCommit,
        warnings: provisioned.warnings,
      });
    } catch (error) {
      await provisioner.discard(provisioned.workspace).catch(() => undefined);
      throw new SessionWorkspaceError(
        "WORKSPACE_PROVISION_FAILED",
        `Worktree ${provisioned.workspace.worktreePath ?? "(unnamed)"} was created and then given `
        + `back because its provisioning could not be journaled: `
        + `${errorMessage(error)}`,
      );
    }
    return provisioned;
  }

  /**
   * Give back a worktree whose start failed before a provider process existed.
   *
   * Only ever called with what `provision` returned, which is what makes this safe: a worktree this
   * start did not create is not something it may delete. `discard` still refuses to force, so
   * anything that did land in the worktree survives, and a failing discard is swallowed because the
   * start is already failing for a reason the caller would rather report.
   */
  async discardFailedStart(provisioned: ProvisionedWorktree | undefined): Promise<void> {
    if (provisioned === undefined) return;
    await this.options.provisioner?.discard(provisioned.workspace).catch(() => undefined);
  }

  /**
   * Fingerprint `cwd`, sharing one reading with every concurrent caller asking about the same
   * directory. The entry is dropped when the capture settles, so the next ask is a fresh reading
   * rather than a cached one — this deduplicates concurrency, it does not memoize.
   */
  captureWorkspaceState(cwd: string): Promise<string> {
    const existing = this.stateInflight.get(cwd);
    if (existing !== undefined) return existing;
    const pending = this.readWorkspaceState(cwd).finally(() => {
      if (this.stateInflight.get(cwd) === pending) this.stateInflight.delete(cwd);
    });
    this.stateInflight.set(cwd, pending);
    return pending;
  }

  /**
   * Whether a finished Scout left `cwd` exactly as its pre-launch baseline found it.
   *
   * The provider's own plan and sandbox boundary is primary enforcement; this is the check that
   * makes a mutation a failed Scout result rather than prose nobody verified. A missing baseline is
   * a failure too — an unverifiable read-only claim is not a verified one.
   */
  async verifyScoutWorkspace(
    baseline: string | undefined,
    cwd: string,
  ): Promise<ScoutWorkspaceVerdict> {
    if (baseline === undefined) {
      return { ok: false, reason: "Scout has no pre-launch workspace state baseline" };
    }
    let after: string;
    try {
      after = await this.captureWorkspaceState(cwd);
    } catch (error) {
      return { ok: false, reason: `Post-run workspace verification failed: ${errorMessage(error)}` };
    }
    if (after !== baseline) {
      return {
        ok: false,
        reason: "Scout changed observable repository state despite its read-only profile",
      };
    }
    return { ok: true, workspaceStateHash: baseline };
  }

  private async readWorkspaceState(cwd: string): Promise<string> {
    const read = this.options.workspaceState;
    if (read === undefined) {
      throw new Error("This broker cannot read workspace state; no state reader is configured");
    }
    return read(cwd);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
