import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
/** No inherited Git environment, SSH helpers, credential helpers, hooks or external programs. */
export function trustedGitEnvironment(): NodeJS.ProcessEnv {
  const overrides = {
    "core.hooksPath": "/dev/null", "core.fsmonitor": "false", "core.sshCommand": "/usr/bin/false",
    "credential.helper": "", "protocol.allow": "never", "protocol.file.allow": "always",
    "submodule.recurse": "false", "core.attributesFile": "/dev/null", "diff.external": "",
  };
  return {
    PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: "/dev/null", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(Object.keys(overrides).length),
    ...Object.fromEntries(Object.entries(overrides).flatMap(([key, value], index) =>
      [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
  };
}
/** Only call non-executing object/ref commands against worker-controlled repositories. */
export async function trustedGit(cwd: string, args: string[]): Promise<Buffer> {
  return (await exec("/usr/bin/git", ["--no-optional-locks", "-C", cwd, ...args], {
    env: trustedGitEnvironment(), encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
  })).stdout;
}
