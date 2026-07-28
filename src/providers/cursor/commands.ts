import type { JobRequest } from "../../domain/job.js";
import type { StartSessionRequest } from "../../domain/session.js";
import type { ProviderLaunchSpec } from "../provider.js";
import {
  buildProviderChildEnvironment,
  jobLaunchEnvironment,
} from "../launch-environment.js";
import { applyWorkerMode } from "../worker-mode.js";

type CursorInteractiveRequest = Pick<
  StartSessionRequest,
  "cwd" | "sandbox" | "model"
>;
type CursorScoutRequest = Pick<
  StartSessionRequest,
  "cwd" | "sandbox" | "model" | "profile"
>;

export interface CursorCommand {
  executable: "agent";
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface CursorHeadlessOptions {
  streamPartialOutput?: boolean;
  sourceEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

/**
 * Interactive Cursor Agent command suitable for a broker-owned PTY. An explicit initial prompt is
 * the documented positional operand; no resume, worktree, or approval flag is emitted.
 * `--workspace` and `cwd` deliberately name the same root. Scouts never use this path.
 */
export function buildCursorInteractiveCommand(
  request: CursorInteractiveRequest,
  initialPrompt?: string,
  sourceEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): CursorCommand {
  const args = cursorSafetyArgs(request);
  if (request.model !== undefined) args.push("--model", request.model);
  if (initialPrompt !== undefined) args.push(initialPrompt);
  return {
    executable: "agent",
    args,
    cwd: request.cwd,
    env: buildProviderChildEnvironment({
      source: sourceEnvironment,
      provider: "cursor",
      cwd: request.cwd,
      terminal: "pty",
      identity: { role: "session" },
    }),
  };
}

/**
 * Bounded Cursor invocation grounded only in `agent --help`. Cursor documents the instruction as a
 * positional `prompt` argument; unlike Claude it documents no stdin input-format contract.
 */
export function buildCursorHeadlessCommand(
  request: JobRequest,
  options: CursorHeadlessOptions = {},
): CursorCommand {
  const args = ["--print", "--output-format", "stream-json"];
  if (options.streamPartialOutput === true) args.push("--stream-partial-output");
  args.push(...cursorSafetyArgs(request));
  if (request.model !== undefined) args.push("--model", request.model);
  args.push(applyWorkerMode(request.instruction, request.workerMode));
  return {
    executable: "agent",
    args,
    cwd: request.cwd,
    env: jobLaunchEnvironment(options.sourceEnvironment ?? process.env, "cursor", request),
  };
}

/**
 * One-shot Scout command. The brief is a positional prompt documented by Cursor; `--print` and
 * stream-json eliminate terminal menus, readiness glyphs, pasted-input timing, and completion
 * scraping. Plan mode plus Cursor sandboxing remains the read-only execution boundary. `--trust`
 * acknowledges only the exact operator-granted workspace and does not grant write access.
 */
export function buildCursorScoutCommand(
  request: CursorScoutRequest,
  prompt: string,
  sourceEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): CursorCommand & Pick<ProviderLaunchSpec, "transport" | "sensitiveArgIndexes"> {
  if (request.profile !== "scout") {
    throw new Error("Cursor Scout command requires profile scout");
  }
  if (request.sandbox !== "read-only") {
    throw new Error("Cursor Scout command requires read-only sandbox");
  }
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    ...cursorSafetyArgs(request),
    "--trust",
  ];
  if (request.model !== undefined) args.push("--model", request.model);
  const promptIndex = args.length;
  args.push(prompt);
  return {
    executable: "agent",
    args,
    cwd: request.cwd,
    env: buildProviderChildEnvironment({
      source: sourceEnvironment,
      provider: "cursor",
      cwd: request.cwd,
      terminal: "pipe",
      identity: { role: "worker", workerMode: "normal" },
    }),
    transport: "pipe",
    sensitiveArgIndexes: [promptIndex],
  };
}

function cursorSafetyArgs(request: Pick<JobRequest, "cwd" | "sandbox">): string[] {
  const args = ["--workspace", request.cwd, "--sandbox", "enabled"];
  if (request.sandbox === "read-only") args.push("--mode", "plan");
  // Cursor advertises only plan/ask as read-only modes. Workspace-write therefore omits --mode and
  // relies on the documented normal agent mode while keeping the explicit sandbox enabled. It does
  // not add force, yolo, trust, Smart Auto, or automatic MCP approval.
  return args;
}
