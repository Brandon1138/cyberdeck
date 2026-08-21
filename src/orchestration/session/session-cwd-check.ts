import { realpath, stat } from "node:fs/promises";
import { SessionWorkspaceError } from "./session-workspace-coordinator.js";

/**
 * The default `SessionCwdCheck`: a cwd is usable when it resolves and what it resolves to is a
 * directory. Symlinks are followed first, so a link pointing at a deleted target is refused rather
 * than accepted on the strength of the link existing.
 *
 * This lives beside the coordinator rather than in composition because a `SessionRegistry` built
 * without a check must still refuse an unusable cwd. Making the refusal something a caller has to
 * remember to wire would mean the one call that forgot spawns a provider process in a directory
 * that is not there — which is the failure the check exists to prevent, reintroduced as a wiring
 * mistake nothing would report.
 */
export async function checkSessionCwdAccessible(cwd: string): Promise<void> {
  try {
    const canonical = await realpath(cwd);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new SessionWorkspaceError(
      "INVALID_SESSION_CWD",
      `Session cwd is not an accessible directory: ${cwd}`,
    );
  }
}
