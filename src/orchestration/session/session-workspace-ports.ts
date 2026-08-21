/**
 * The two things the workspace coordinator has to learn from a real filesystem, expressed as
 * functions of a path so the application service never names `node:fs`, `git`, or a provider.
 */

/**
 * Refuse a session whose cwd is not an accessible directory. Throws; a resolved promise is the
 * only "yes". Kept as an effect rather than a predicate because the refusal carries the message the
 * caller is shown, and inventing that message twice is how two callers end up disagreeing.
 */
export type SessionCwdCheck = (cwd: string) => Promise<void>;

/**
 * Fingerprint the observable repository state at `cwd`. The coordinator compares two of these and
 * never interprets one, so any implementation that is stable for an unchanged tree will do.
 */
export type WorkspaceStateReader = (cwd: string) => Promise<string>;

/** What a completed provision is worth recording, as the journal's own field names. */
export interface WorkspaceProvisioningFacts {
  worktreePath: string | null;
  repositoryPath: string | null;
  branch: string;
  baseRef: string;
  baseCommit: string;
  warnings: string[];
}

/**
 * Where provisioning facts are made durable. The registry owns the journal; this is the one call it
 * hands the coordinator so the provision, its record, and its rollback stay one sequence.
 */
export interface WorkspaceProvisioningJournal {
  workspaceProvisioned(sessionId: string, facts: WorkspaceProvisioningFacts): Promise<void>;
}

/**
 * The answer to "did this Scout leave the repository as it found it", with the reason already
 * worded for the failure the caller records. `ok` carries the hash both readings agreed on.
 */
export type ScoutWorkspaceVerdict =
  | { ok: true; workspaceStateHash: string }
  | { ok: false; reason: string };
