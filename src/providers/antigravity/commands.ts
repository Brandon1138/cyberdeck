import type { JobRequest } from "../../domain/job.js";
import { isFableModel } from "../../domain/policy.js";
import type { ReasoningEffort, Sandbox } from "../../domain/session.js";

type AntigravityInteractiveRequest = Pick<JobRequest, "provider" | "cwd" | "sandbox" | "model"> & {
  effort?: ReasoningEffort;
};

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
  /** Provider-documented interactive prompt mode; omitted for a promptless TUI launch. */
  initialPrompt?: string;
}

/**
 * Interactive command suitable for a broker-owned PTY.
 *
 * The session adapter consumes this builder after explicit provider registration. No continuation,
 * agent, or automatic model is added; an optional initial prompt uses the documented interactive
 * prompt flag.
 */
export function buildAntigravityInteractiveCommand(
  request: AntigravityInteractiveRequest,
  options: AntigravityCommandOptions = {},
): AntigravityCommand {
  assertAntigravityRequest(request);
  const args = options.initialPrompt === undefined
    ? antigravitySandboxArgs(request.sandbox)
    : ["--prompt-interactive", options.initialPrompt, ...antigravitySandboxArgs(request.sandbox)];
  appendExplicitModel(args, request.model);
  appendExplicitEffort(args, request.effort);
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
  request: Pick<JobRequest, "cwd">,
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

function appendExplicitEffort(args: string[], effort: ReasoningEffort | undefined): void {
  if (effort === undefined) return;
  if (effort !== "low" && effort !== "medium" && effort !== "high") {
    throw new AntigravityLaunchSafetyError(`unsupported effort ${effort}; agy supports low, medium, or high`);
  }
  args.push("--effort", effort);
}

function assertAntigravityRequest(
  request: Pick<JobRequest, "provider" | "model">,
): void {
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
