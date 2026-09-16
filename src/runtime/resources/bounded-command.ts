import { execFile } from "node:child_process";

export type ResourceCommand = (file: string, args: string[]) => Promise<string>;
/** No shell, no command output in errors, bounded time and capture buffers. */
export const runResourceCommand: ResourceCommand = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
    if (error) reject(new Error("resource-command-unavailable"));
    else resolve(stdout);
  });
});
