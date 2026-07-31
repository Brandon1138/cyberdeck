import { chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePrivateDirectory } from "../persistence/private-files.js";

export interface SessionLaunchFilesOptions {
  directory?: string;
}

function launchFilesRoot(options: SessionLaunchFilesOptions): string {
  return options.directory ?? join(tmpdir(), `cyberdeck-${process.getuid?.() ?? "user"}`, "launch");
}

export function sessionLaunchFilePath(
  sessionId: string,
  name: string,
  options: SessionLaunchFilesOptions = {},
): string {
  return join(launchFilesRoot(options), sessionId, name);
}

/**
 * `name` may contain path segments, so a provider that needs a small directory layout (Cursor's
 * injected plugin and config directories) gets it from the same private-by-construction seam as a
 * flat payload file rather than building one of its own.
 */
export async function writeSessionLaunchFile(
  sessionId: string,
  name: string,
  contents: string,
  options: SessionLaunchFilesOptions = {},
): Promise<string> {
  const path = sessionLaunchFilePath(sessionId, name, options);
  await ensurePrivateDirectory(dirname(path));
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function removeSessionLaunchFiles(
  sessionId: string,
  options: SessionLaunchFilesOptions = {},
): Promise<void> {
  await rm(join(launchFilesRoot(options), sessionId), { recursive: true, force: true });
}
