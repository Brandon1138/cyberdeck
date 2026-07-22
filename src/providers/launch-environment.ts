import type { JobRequest } from "../domain/job.js";
import type { SessionRecord, WorkerMode } from "../domain/session.js";

export type CyberdeckProcessRole = "worker" | "orchestrator" | "session";

interface LaunchIdentity {
  role: CyberdeckProcessRole;
  workerMode?: WorkerMode;
}

/**
 * Add inert Cyberdeck identity metadata without disturbing provider or proxy configuration.
 * Values are always overwritten after the inherited environment so stale shell state cannot
 * misclassify a child process. Consumers must not treat these convenience variables as authority.
 */
export function cyberdeckLaunchEnvironment(
  base: NodeJS.ProcessEnv,
  identity: LaunchIdentity,
): NodeJS.ProcessEnv {
  return {
    ...base,
    CYBERDECK_PROCESS_ROLE: identity.role,
    CYBERDECK_WORKER_MODE: identity.workerMode ?? "normal",
  };
}

export function sessionLaunchEnvironment(
  base: NodeJS.ProcessEnv,
  session: Pick<SessionRecord, "kind" | "workerMode">,
): NodeJS.ProcessEnv {
  return cyberdeckLaunchEnvironment(base, {
    role: session.kind ?? "session",
    ...(session.workerMode === undefined ? {} : { workerMode: session.workerMode }),
  });
}

export function jobLaunchEnvironment(
  base: NodeJS.ProcessEnv,
  request: Pick<JobRequest, "workerMode">,
): NodeJS.ProcessEnv {
  return cyberdeckLaunchEnvironment(base, {
    role: "worker",
    ...(request.workerMode === undefined ? {} : { workerMode: request.workerMode }),
  });
}
