import { DatabaseSync } from "node:sqlite";
import { chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { ensurePrivateDirectory } from "./private-files.js";

/** SQLite's OS-backed writer lock survives neither crashes nor process death. Unlike a PID file,
 * it needs no stale-owner deletion that could itself race another owner's acquisition. */
export async function withJournalExclusivity<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock.sqlite`;
  await ensurePrivateDirectory(dirname(lockPath));
  const deadline = Date.now() + 120_000;
  for (;;) {
    const lock = new DatabaseSync(lockPath);
    let acquired = false;
    try {
      // Only SQLite opens/closes this inode: closing a separate POSIX descriptor could release
      // an existing connection's process-level advisory locks. chmod does not open a descriptor.
      await chmod(lockPath, 0o600);
      try {
        lock.exec("BEGIN IMMEDIATE");
        acquired = true;
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (code !== 5 && code !== 6) throw error;
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring journal exclusivity for ${path}`, { cause: error });
      }
      if (acquired) return await operation();
    } finally {
      // No data is stored here: this transaction exists solely to hold the cross-process lock.
      try { if (acquired) lock.exec("ROLLBACK"); }
      finally { lock.close(); }
    }
    // Never use a synchronous busy timeout: the owner may be awaiting I/O in this process.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
