import { spawn as spawnChildProcess } from "node:child_process";
import type { AppServerSpawn } from "./dispatch-adapter.js";

export const defaultAppServerSpawn: AppServerSpawn = (command) => {
  const child = spawnChildProcess(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    get pid() { return child.pid; },
    onStdout: (listener) => child.stdout?.on("data", listener),
    onStderr: (listener) => child.stderr?.on("data", listener),
    onExit: (listener) => child.on("exit", listener),
    onError: (listener) => child.on("error", listener),
    write: (data) => { child.stdin?.write(data); },
    endStdin: () => { child.stdin?.end(); },
    kill: (signal) => { child.kill(signal); },
  };
};
