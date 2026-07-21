import type { JobRequest } from "../../domain/job.js";

export interface CursorCommand {
  executable: "agent";
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface CursorHeadlessOptions {
  streamPartialOutput?: boolean;
}

/**
 * Interactive Cursor Agent command suitable for a broker-owned PTY. No prompt, resume, trust,
 * worktree, or approval flag is emitted. `--workspace` and `cwd` deliberately name the same root.
 */
export function buildCursorInteractiveCommand(request: JobRequest): CursorCommand {
  const args = cursorSafetyArgs(request);
  if (request.model !== undefined) args.push("--model", request.model);
  return { executable: "agent", args, cwd: request.cwd, env: { ...process.env } };
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
  args.push(request.instruction);
  return { executable: "agent", args, cwd: request.cwd, env: { ...process.env } };
}

function cursorSafetyArgs(request: JobRequest): string[] {
  const args = ["--workspace", request.cwd, "--sandbox", "enabled"];
  if (request.sandbox === "read-only") args.push("--mode", "plan");
  // Cursor advertises only plan/ask as read-only modes. Workspace-write therefore omits --mode and
  // relies on the documented normal agent mode while keeping the explicit sandbox enabled. It does
  // not add force, yolo, trust, Smart Auto, or automatic MCP approval.
  return args;
}
