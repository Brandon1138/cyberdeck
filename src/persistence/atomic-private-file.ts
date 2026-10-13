import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { ensurePrivateDirectory } from "./private-files.js";

/** Make an existing append and its directory entry durable before deleting dependent state. */
export async function syncPrivateFile(path: string): Promise<void> {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
  const parent = await open(dirname(path), "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

/** Host-owned state only. Readers see the previous or the fsynced replacement, never a prefix. */
export async function writeAtomicPrivateFile(path: string, body: string): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = `${path}.${randomUUID()}.pending`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}
