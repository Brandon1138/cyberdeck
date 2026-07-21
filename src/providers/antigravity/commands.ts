import type { JobRequest } from "../../domain/job.js";
import { isFableModel } from "../../domain/policy.js";
import type { Sandbox } from "../../domain/session.js";

export interface AntigravityCommand {
  executable: "agy";
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** `agy` documents the one-shot prompt on argv, so stdin is closed empty. */
  stdin: "";
}

export interface AntigravityCommandOptions {
  /** Injectable only so deterministic tests can use an empty PATH. Production inherits `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Interactive command suitable for a broker-owned PTY.
 *
 * The older Phase 1 session union is closed to Codex and Claude, so this accepts the bounded
 * request shape as neutral command-construction evidence and does not self-register with the
 * interactive broker. No prompt, continuation, agent, or automatic model is added.
 */
export function buildAntigravityInteractiveCommand(
  request: JobRequest,
  options: AntigravityCommandOptions = {},
): AntigravityCommand {
  assertAntigravityRequest(request);
  const args = antigravitySandboxArgs(request.sandbox);
  appendExplicitModel(args, request.model);
  return command(request, args, options);
}

/**
 * One bounded `agy` invocation grounded in the committed B1 help evidence.
 *
 * `agy` advertises `--print`/`--prompt`, but no stdin input format and no structured output format.
 * The instruction is therefore the value of `--print`; stdout remains unstructured text.
 */
export function buildAntigravityHeadlessCommand(
  request: JobRequest,
  options: AntigravityCommandOptions = {},
): AntigravityCommand {
  assertAntigravityRequest(request);
  const args = ["--print", request.instruction, ...antigravitySandboxArgs(request.sandbox)];
  appendExplicitModel(args, request.model);
  return command(request, args, options);
}

function command(
  request: JobRequest,
  args: string[],
  options: AntigravityCommandOptions,
): AntigravityCommand {
  return {
    executable: "agy",
    args,
    cwd: request.cwd,
    env: { ...(options.env ?? process.env) },
    stdin: "",
  };
}

function antigravitySandboxArgs(sandbox: Sandbox): string[] {
  if (sandbox === "workspace-write") {
    throw new AntigravityUnsupportedSandboxError();
  }
  return ["--mode", "plan", "--sandbox"];
}

function appendExplicitModel(args: string[], model: string | undefined): void {
  if (model !== undefined) args.push("--model", model);
}

function assertAntigravityRequest(request: JobRequest): void {
  if (request.provider !== "antigravity") {
    throw new Error(`Antigravity adapter cannot run provider ${request.provider}`);
  }
  if (isFableModel(request.model)) {
    throw new AntigravityLaunchSafetyError("Fable models are never launched through Antigravity");
  }
  if (request.model?.startsWith("-") === true) {
    throw new AntigravityLaunchSafetyError(
      "an option-shaped model identifier is refused before argv construction",
    );
  }
}

export class AntigravityUnsupportedSandboxError extends Error {
  readonly code = "ANTIGRAVITY_WORKSPACE_WRITE_UNSUPPORTED";

  constructor() {
    super(
      "ANTIGRAVITY_WORKSPACE_WRITE_UNSUPPORTED: agy documents accept-edits, but committed " +
        "evidence does not establish that it preserves workspace-write without automatic approval",
    );
    this.name = "AntigravityUnsupportedSandboxError";
  }
}

export class AntigravityLaunchSafetyError extends Error {
  readonly code = "ANTIGRAVITY_LAUNCH_UNSAFE";

  constructor(reason: string) {
    super(`ANTIGRAVITY_LAUNCH_UNSAFE: ${reason}`);
    this.name = "AntigravityLaunchSafetyError";
  }
}
