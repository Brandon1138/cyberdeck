import { spawn } from "node:child_process";

export const CLIPBOARD_TIMEOUT_MS = 5_000;
export const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type ClipboardCommandResult =
  | { status: "ok"; stdout: Buffer }
  | { status: "failed"; failure: "missing" | "timeout" | "too-large" | "exit"; exitCode?: number; stderr: Buffer };

export interface ClipboardCommandOptions {
  env: NodeJS.ProcessEnv;
  maxBytes: number;
  timeoutMs: number;
}

export type ClipboardCommand = (
  command: string, args: readonly string[], options: ClipboardCommandOptions,
) => Promise<ClipboardCommandResult>;

/** Bound both pipes and kill a stalled reader. Errors never include clipboard output or argv. */
export const runClipboardCommand: ClipboardCommand = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      env: options.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;
    const finish = (result: ClipboardCommandResult, kill = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) {
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolve(result);
    };
    const failure = (kind: "timeout" | "too-large"): void => {
      finish({ status: "failed", failure: kind, stderr: Buffer.alloc(0) }, true);
    };
    const timer = setTimeout(() => failure("timeout"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > options.maxBytes) failure("too-large");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      errorBytes += chunk.length;
      if (errorBytes > 4_096) failure("too-large");
      else stderr.push(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ status: "failed", failure: error.code === "ENOENT" ? "missing" : "exit", stderr: Buffer.alloc(0) });
    });
    child.on("close", (code) => {
      finish(code === 0
        ? { status: "ok", stdout: Buffer.concat(stdout) }
        : { status: "failed", failure: "exit", ...(code === null ? {} : { exitCode: code }), stderr: Buffer.concat(stderr) });
    });
  });

export function clipboardCommandReason(command: string, result: Extract<ClipboardCommandResult, { status: "failed" }>): string {
  switch (result.failure) {
    case "missing": return `${command} is unavailable; install or enable the clipboard integration`;
    case "timeout": return `${command} clipboard read timed out`;
    case "too-large": return `${command} clipboard output exceeded its size limit`;
    case "exit": return `${command} could not read the clipboard`;
  }
}
