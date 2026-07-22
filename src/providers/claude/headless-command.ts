import type { JobRequest } from "../../domain/job.js";
import { evaluateClaudeLaunchSafety } from "../../domain/policy.js";
import { claudePermissionMode } from "./permissions.js";
import { jobLaunchEnvironment } from "../launch-environment.js";
import { applyWorkerMode } from "../worker-mode.js";

/** A fully-resolved headless invocation. `stdin` is written to the process and then closed. */
export interface ClaudeHeadlessCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
}

export interface ClaudeHeadlessOptions {
  /**
   * Opt-in `--include-partial-messages`. Off by default: a bounded job needs only a terminal
   * result, and the CLI documents this flag as valid solely with `--print` and
   * `--output-format=stream-json`, which is the only combination this builder emits.
   */
  includePartialMessages?: boolean;
}

/**
 * Build the structured headless invocation for one bounded job.
 *
 * Every flag here is one the installed CLI's own help documents for print mode
 * (`--print`, `--input-format text|stream-json`, `--output-format text|json|stream-json`,
 * `--include-partial-messages`, `--permission-mode`, `--model`). Nothing is borrowed from another
 * provider's surface.
 *
 * Deliberately absent:
 * - `--resume`, `--continue`, `--fork-session`, `--from-pr`, `--session-id`. Provider-native session
 *   persistence is a different thing from a Cyberdeck process lifetime, and the exact mechanics are
 *   unverified. A bounded job is a fresh invocation and claims no continuity.
 * - `--fallback-model`. Cyberdeck never picks a substitute model.
 * - `role`. It is an opaque caller label with no routing or model semantics.
 *
 * The instruction travels on stdin under `--input-format text` rather than as an argv operand, so a
 * long or shell-sensitive instruction cannot be mangled by argv handling.
 */
export function buildClaudeHeadlessCommand(
  request: JobRequest,
  options: ClaudeHeadlessOptions = {},
): ClaudeHeadlessCommand {
  // Runs before any argv exists, so an unsafe launch fails before process construction.
  const safety = evaluateClaudeLaunchSafety(request.provider, request.model);
  if (!safety.safe) {
    throw new ClaudeLaunchSafetyError(safety.code);
  }

  const args = [
    "--print",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--permission-mode",
    claudePermissionMode(request.sandbox),
  ];
  if (options.includePartialMessages === true) {
    args.push("--include-partial-messages");
  }
  // Forwarded only because the caller explicitly supplied it; omission stays omission.
  if (request.model !== undefined) {
    args.push("--model", request.model);
  }

  return {
    executable: "claude",
    args,
    cwd: request.cwd,
    env: jobLaunchEnvironment({ ...process.env, DISABLE_UPDATES: "1" }, request),
    stdin: applyWorkerMode(request.instruction, request.workerMode),
  };
}

export class ClaudeLaunchSafetyError extends Error {
  constructor(readonly code: "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_MODEL") {
    super(
      `${code}: a live Claude launch requires an explicit operator-selected model; ` +
        "an omitted model is not treated as implicit authorization for the provider default",
    );
    this.name = "ClaudeLaunchSafetyError";
  }
}
