import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ResourceLedgerSchema, type ResourceLedger, type ResourceLedgerPort } from "../domain/resource-budget.js";
import { ensurePrivateDirectory } from "./private-files.js";

/** One installation owner. Unknown/stale ownership fails closed; never silently remove a lock. */
export class ResourceReservationStore implements ResourceLedgerPort {
  private poisoned = false;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private readonly directory: string, private readonly lock: FileHandle, private ledger: ResourceLedger) {}
  static async open(directory: string, installationId: string): Promise<ResourceReservationStore> {
    await ensurePrivateDirectory(directory);
    const lock = await open(join(directory, "resource-owner.lock"), "wx", 0o600);
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await lock.sync();
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
    } catch (error) { await lock.close(); await unlink(join(directory, "resource-owner.lock")); throw error; }
  }
  read(): ResourceLedger { return structuredClone(this.ledger); }
  save(input: ResourceLedger, expectedRevision: number): Promise<void> {
    const next = ResourceLedgerSchema.parse(input);
    const result = this.tail.then(async () => {
      if (this.closed || this.poisoned) throw new Error("RESOURCE_STORE_UNAVAILABLE");
      if (expectedRevision !== this.ledger.revision || next.revision !== expectedRevision + 1
        || next.installationId !== this.ledger.installationId) throw new Error("RESOURCE_LEDGER_CONFLICT");
      const path = join(this.directory, `resource-write-${randomUUID()}.tmp`);
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(next)); await handle.sync();
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
    this.closed = true; await this.tail; await this.lock.close();
    await unlink(join(this.directory, "resource-owner.lock"));
  }
}
