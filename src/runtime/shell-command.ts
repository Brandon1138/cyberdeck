import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface ShellCommandRequest {
  /** Exactly what the operator typed. It is handed to the shell unaltered. */
  command: string;
  cwd: string;
  /** Called with output as it arrives. The sentinel is never part of a chunk. */
  onOutput?: ((chunk: string) => void) | undefined;
  /** Defaults to the operator's `$SHELL`. */
  shell?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ShellCommandResult {
  /** The operator's line's status, read off the sentinel rather than off the wrapper. */
  exitStatus: number;
  /**
   * The shell's `$PWD` once the line finished, or `undefined` when the sentinel never arrived or
   * named something that is not a directory. `undefined` means "leave Fleet's cwd alone" — never
   * "the operator is now at an unknown place".
   */
  cwd?: string | undefined;
}

/**
 * Runs one composer line through `$SHELL -lc` and reports where the shell ended up.
 *
 * A child cannot move its parent, so `cd` only persists because the shell is asked to say where it
 * is once the line is done. That answer has to survive a command printing arbitrary bytes, so the
 * marker is a fresh 256-bit random string per invocation rather than a fixed word a `git log` could
 * carry: no output can contain it, because it did not exist until this call. The marker is matched
 * only on stdout — stderr is passed through untouched, so an interleaved stderr write can never
 * split it — and everything from the marker onward is withheld from the caller.
 *
 * Output is piped rather than run on a pty. That is deliberate: with no tty, `git` and friends do
 * not reach for a pager, so a non-interactive line can never hang waiting for `less`. Anything that
 * genuinely wants a terminal is Ctrl+G's job, not this one's.
 */
export async function runShellCommand(request: ShellCommandRequest): Promise<ShellCommandResult> {
  const shell = request.shell ?? process.env.SHELL;
  if (shell === undefined || shell === "") {
    throw Object.assign(new Error("No login shell is set in $SHELL"), { code: "SHELL_UNSET" });
  }

  const marker = randomBytes(32).toString("hex");
  const separator = `\n${marker}\n`;
  // The operator's line is terminated by a newline rather than by `;` so a trailing comment, a
  // trailing `&`, or a heredoc cannot swallow the reporting that follows it.
  const script = [
    request.command,
    "__cyberdeck_status=$?",
    `printf '\\n%s\\n%s\\n%s' '${marker}' "$__cyberdeck_status" "$PWD"`,
  ].join("\n");

  const emit = request.onOutput ?? (() => {});
  let pending = "";
  let tail = "";
  let sealed = false;

  const consumeStdout = (chunk: string) => {
    if (sealed) {
      tail += chunk;
      return;
    }
    pending += chunk;
    const index = pending.indexOf(separator);
    if (index >= 0) {
      if (index > 0) emit(pending.slice(0, index));
      tail = pending.slice(index + separator.length);
      pending = "";
      sealed = true;
      return;
    }
    // A separator can straddle two chunks, so whatever trailing bytes could still be its opening
    // are held back rather than printed and regretted. Only bytes that actually begin the
    // separator are held: withholding a fixed window instead would stall every short line behind
    // the next write, and most lines are short.
    const withheld = separatorPrefixSuffix(pending, separator);
    const flushed = pending.slice(0, pending.length - withheld);
    pending = pending.slice(pending.length - withheld);
    if (flushed !== "") emit(flushed);
  };

  const child = spawn(shell, ["-lc", script], {
    cwd: request.cwd,
    env: request.env ?? process.env,
    // No stdin: a line that wants to prompt should fail rather than hang a Fleet the operator
    // cannot type into.
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", consumeStdout);
  child.stderr.on("data", (chunk: string) => { emit(chunk); });

  const exitStatus = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve(code ?? (signal === null ? 1 : 128 + signalNumber(signal))));
  });

  // Whatever was held back for a separator that never came is still the operator's output.
  if (!sealed && pending !== "") emit(pending);

  if (!sealed) return { exitStatus };
  const newline = tail.indexOf("\n");
  if (newline < 0) return { exitStatus };
  const reported = Number.parseInt(tail.slice(0, newline), 10);
  // The path is the rest of the tail verbatim, so a directory whose name contains a newline still
  // reads back whole.
  const cwd = tail.slice(newline + 1);
  const status = Number.isInteger(reported) ? reported : exitStatus;
  return { exitStatus: status, ...(await directoryOrUndefined(cwd)) };
}

/** How much of the buffer's tail is a genuine opening of the separator, and so cannot be printed. */
function separatorPrefixSuffix(pending: string, separator: string): number {
  const longest = Math.min(pending.length, separator.length - 1);
  for (let length = longest; length > 0; length -= 1) {
    if (pending.endsWith(separator.slice(0, length))) return length;
  }
  return 0;
}

async function directoryOrUndefined(path: string): Promise<{ cwd?: string }> {
  // A backgrounded job can still write after the sentinel, so the reported path is believed only
  // when it is one: anything else leaves Fleet where it was.
  if (!isAbsolute(path)) return {};
  try {
    if (!(await stat(path)).isDirectory()) return {};
  } catch {
    return {};
  }
  return { cwd: path };
}

function signalNumber(signal: NodeJS.Signals): number {
  return ({ SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal] ?? 1;
}
