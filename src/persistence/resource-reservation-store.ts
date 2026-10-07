import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceOwnerLockPort } from "../domain/resource-runtime.js";
import { ResourceLedgerSchema, type ResourceLedger, type ResourceLedgerPort } from "../domain/resource-budget.js";
import { ensurePrivateDirectory } from "./private-files.js";

/** One installation owner. Unknown/stale ownership fails closed; never silently remove a lock. */
export class ResourceReservationStore implements ResourceLedgerPort {
  private poisoned = false;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private readonly directory: string, private readonly lock: ResourceOwnerLockPort, private ledger: ResourceLedger) {}
  static async open(directory: string, installationId: string,
    options: { acquireOwner?: (path: string) => Promise<ResourceOwnerLockPort> } = {}): Promise<ResourceReservationStore> {
    await ensurePrivateDirectory(directory);
    const path = join(directory, "resource-owner.lock");
    // A persistent mode marker prevents legacy wx and kernel-lock participants sharing an
    // inode while obeying different exclusion protocols. Mode migration is deliberately explicit.
    await this.assertLockMode(directory, options.acquireOwner ? "kernel-v1" : "legacy-wx-v1");
    const lock = options.acquireOwner ? await options.acquireOwner(path) : await this.legacyLock(path);
    try {
      lock.assertHeld();
      let ledger: ResourceLedger = { schemaVersion: 1, installationId, revision: 0, nextSequence: 0, lastFamily: null, entries: [] };
      try {
        const handle = await open(join(directory, "resource-ledger.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if ((await handle.stat()).size > 16 * 1024 ** 2) throw new Error("RESOURCE_LEDGER_TOO_LARGE");
          ledger = ResourceLedgerSchema.parse(JSON.parse(await handle.readFile("utf8")));
        } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (ledger.installationId !== installationId) throw new Error("RESOURCE_INSTALLATION_MISMATCH");
      return new ResourceReservationStore(directory, lock, ledger);
    } catch (error) { await lock.release(); throw error; }
  }
  private static async assertLockMode(directory: string, mode: string): Promise<void> {
    const path = join(directory, "resource-owner-mode");
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(mode); await handle.sync(); } finally { await handle.close(); }
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await handle.stat()).size > 32 || await handle.readFile("utf8") !== mode) throw new Error("RESOURCE_OWNER_MODE_CONFLICT");
      } finally { await handle.close(); }
    }
  }
  private static async legacyLock(path: string): Promise<ResourceOwnerLockPort> {
    const handle = await open(path, "wx", 0o600);
    let held = true;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await handle.sync();
    } catch (error) { await handle.close(); await unlink(path); throw error; }
    return {
      assertHeld: () => { if (!held) throw new Error("RESOURCE_OWNER_LOST"); },
      release: async () => { if (!held) return; held = false; await handle.close(); await unlink(path); },
    };
  }
  assertOwner(): void {
    if (this.closed || this.poisoned) throw new Error("RESOURCE_STORE_UNAVAILABLE");
    this.lock.assertHeld();
  }
  read(): ResourceLedger { this.assertOwner(); return structuredClone(this.ledger); }
  save(input: ResourceLedger, expectedRevision: number): Promise<void> {
    const next = ResourceLedgerSchema.parse(input);
    const result = this.tail.then(async () => {
      this.assertOwner();
      if (expectedRevision !== this.ledger.revision || next.revision !== expectedRevision + 1
        || next.installationId !== this.ledger.installationId) throw new Error("RESOURCE_LEDGER_CONFLICT");
      const path = join(this.directory, `resource-write-${randomUUID()}.tmp`);
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(next)); await handle.sync();
        this.assertOwner();
        await rename(path, join(this.directory, "resource-ledger.json"));
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
        this.ledger = next;
      } catch (error) { this.poisoned = true; throw error; }
      finally { await handle.close(); }
    });
    this.tail = result.catch(() => undefined); return result;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; await this.tail; await this.lock.release();
  }
}
