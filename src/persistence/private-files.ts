import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/** Create or repair a directory that may contain private Cyberdeck state. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/** Open an append-only private state file and repair permissions on upgrades. */
export async function openPrivateAppendFile(path: string): Promise<FileHandle> {
  await ensurePrivateDirectory(dirname(path));
  const handle = await open(path, "a", 0o600);
  await handle.chmod(0o600);
  return handle;
}
