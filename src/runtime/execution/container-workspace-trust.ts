import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeWorkspaceTrust } from "../../providers/claude/workspace-trust.js";
import { CodexWorkspaceTrust } from "../../providers/codex/workspace-trust.js";
import type { ContainerLaunchContext } from "./container-launch-context.js";

/** Called during execution preparation, after the prior guest is confirmed quiescent. Never
 * follow provider-owned symlinks on the host, and reuse the same trust writers/policy as #113. */
export async function prepareContainerWorkspaceTrust(context: ContainerLaunchContext, provider: string,
  allows: ((source: string) => Promise<boolean>) | undefined,
): Promise<void> {
  if (!allows || !await allows(context.workspace.source)) return;
  if (!(await lstat(context.hostState)).isDirectory()) throw new Error("CONTAINER_TRUST_PATH_REFUSED");
  const canonicalize = async (path: string) => path; // Exact guest cwd, not a host realpath.
  if (provider === "claude") {
    const settingsPath = join(context.hostState, ".claude.json");
    await regularOrAbsent(settingsPath);
    await new ClaudeWorkspaceTrust({ settingsPath, canonicalize }).trust(context.guest.workspace);
  } else if (provider === "codex") {
    const directory = join(context.hostState, ".codex");
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    if (!(await lstat(directory)).isDirectory()) throw new Error("CONTAINER_TRUST_PATH_REFUSED");
    const configPath = join(directory, "config.toml");
    await regularOrAbsent(configPath);
    await new CodexWorkspaceTrust({ configPath, canonicalize }).trust(context.guest.workspace);
  }
}

async function regularOrAbsent(path: string): Promise<void> {
  try { if (!(await lstat(path)).isFile()) throw new Error("CONTAINER_TRUST_PATH_REFUSED"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
