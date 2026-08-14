import type { JobRequest } from "../../domain/job.js";
import type { ApprovalMode, StartSessionRequest } from "../../domain/session.js";
import { resolveProviderPermissionPlan } from "../../domain/permission-resolution.js";
import type { ProviderLaunchSpec } from "../provider.js";
import {
  buildProviderChildEnvironment,
  jobLaunchEnvironment,
} from "../launch-environment.js";
import { applyWorkerMode } from "../worker-mode.js";

type CursorInteractiveRequest = Pick<
  StartSessionRequest,
  "cwd" | "sandbox" | "model" | "approvalMode"
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

export interface CursorInteractiveOptions {
  initialPrompt?: string | undefined;
  /**
   * The provider-native conversation this Cyberdeck thread owns. Cursor adopts an unknown chat id
   * as a new conversation and reopens a known one, so naming it makes launch and resume the same
   * command and keeps the identity stable across broker restarts.
   */
  chatId?: string | undefined;
  /** Session-scoped plugin directory contributing the Cyberdeck MCP server. */
  pluginDirectory?: string | undefined;
  sourceEnvironment?: Readonly<NodeJS.ProcessEnv> | undefined;
}

/**
 * Interactive Cursor Agent command suitable for a broker-owned PTY. An explicit initial prompt is
 * the documented positional operand; no worktree or approval flag is emitted. `--workspace` and
 * `cwd` deliberately name the same root. Scouts never use this path.
 */
export function buildCursorInteractiveCommand(
  request: CursorInteractiveRequest,
  options: CursorInteractiveOptions = {},
): CursorCommand {
  const args = cursorSafetyArgs(request);
  if (request.model !== undefined) args.push("--model", request.model);
  if (options.pluginDirectory !== undefined) args.push("--plugin-dir", options.pluginDirectory);
  if (options.chatId !== undefined) args.push("--resume", options.chatId);
  if (options.initialPrompt !== undefined) args.push(options.initialPrompt);
  return {
    executable: "agent",
    args,
    cwd: request.cwd,
    env: buildProviderChildEnvironment({
      source: options.sourceEnvironment ?? process.env,
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
 * scraping. Ask mode plus Cursor sandboxing remains the read-only execution boundary. `--trust`
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
    ...cursorSafetyArgs(request, "ask"),
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

/**
 * Permission flags come from the shared resolver so a Cursor session cannot read a stored request
 * differently from a Codex or Claude one. `--workspace` is not a permission flag and stays here.
 * `--force`, `--yolo`, `--trust`, and `--approve-mcps` are never emitted.
 */
function cursorSafetyArgs(
  request: Pick<JobRequest, "cwd" | "sandbox"> & { approvalMode?: ApprovalMode | undefined },
  readOnlyMode: "plan" | "ask" = "plan",
): string[] {
  const plan = resolveProviderPermissionPlan("cursor", {
    sandbox: request.sandbox,
    approvalMode: request.approvalMode,
    cursorReadOnlyMode: readOnlyMode,
  });
  if (!plan.ok) throw Object.assign(new Error(plan.message), { code: plan.code });
  return ["--workspace", request.cwd, ...plan.value.args];
}
