import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

/** root is a broker-owned mount root whose parent is not writable by the worker.
 * Reject symlinks in every worker-controlled component, including racing replacements.
 * macOS provides O_NOFOLLOW_ANY; Linux resolves each component through an owned directory FD.
 */
export async function openContainedSource(root: string, path: string): Promise<FileHandle> {
  const suffix = relative(resolve(root), resolve(path));
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || suffix.startsWith(sep)) throw new Error("ACTIVITY_SOURCE_ESCAPE");
  const canonicalRoot = await realpath(root);
  if (process.platform === "darwin") {
    // Darwin sys/fcntl.h: O_NOFOLLOW_ANY, intentionally not exposed by Node constants.
    return open(`${canonicalRoot}${sep}${suffix}`, constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
  }
  if (process.platform !== "linux") throw new Error("ACTIVITY_SAFE_SOURCE_UNSUPPORTED");
  let directory = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const parts = suffix.split(sep);
    for (const component of parts.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    return await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } finally { await directory.close(); }
}
