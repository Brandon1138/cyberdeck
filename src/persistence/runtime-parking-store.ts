import { constants, lstatSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { ParkingRecord, ParkingStore } from "../orchestration/runtime-parking-service.js";

const nonempty = (max: number) => z.string().min(1).max(max);
const RecordSchema = z.object({
  sessionId: nonempty(128),
  identity: z.object({ generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    executionId: nonempty(128), workspaceId: nonempty(8192), conversationId: nonempty(4096).nullable(),
    authorityEpoch: nonempty(2048) }).strict(),
  phase: z.enum(["parking", "parked", "waking", "active", "intervention"]),
  wakeAttempts: z.number().int().min(0).max(3), reason: nonempty(128).nullable(),
}).strict().superRefine((record, context) => {
  if (record.phase === "waking" && record.wakeAttempts === 0
    || record.phase === "parking" && record.wakeAttempts !== 0
    || record.phase === "intervention" && record.reason === null
    || ["parking", "parked", "active"].includes(record.phase) && record.reason !== null
    || record.phase !== "intervention" && record.identity.conversationId === null)
    context.addIssue({ code: "custom", message: "invalid-parking-state" });
});
const BodySchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  records: z.array(RecordSchema).max(10000) }).strict();
const SnapshotSchema = z.object({ body: BodySchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Body = z.infer<typeof BodySchema>;
const digest = (body: Body) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
const snapshotName = "runtime-parking.json";
const temporaryName = /^runtime-parking-write-[a-f0-9-]{36}\.pending$/;

export interface RuntimeParkingStoreOptions {
  maxRecords?: number;
  /** Snapshot plus old/new transaction files and preserved crash remnants; minimum 64 KiB. */
  maxBytes?: number;
  /** Canonical retirement proof, not merely a provider exit or an absent UI row. */
  isRetired?: (sessionId: string) => boolean;
}

/** One installation owner, borrowed from common resource accounting. Unknown/corrupt state is
 * never reset. Failed I/O poisons reads AND writes until reopen reconciles the durable snapshot. */
export class RuntimeParkingStore implements ParkingStore {
  private static readonly writers = new Map<string, Promise<unknown>>();
  private poisoned = false;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private constructor(private readonly directory: string, private readonly assertOwner: () => void,
    private readonly directoryIdentity: { dev: number; ino: number }, private body: Body,
    private readonly options: RuntimeParkingStoreOptions) {
    this.maxRecords = options.maxRecords ?? 10000; this.maxBytes = options.maxBytes ?? 8 * 1024 ** 2;
  }
  static async open(directory: string, assertOwner: () => void, options: RuntimeParkingStoreOptions = {}): Promise<RuntimeParkingStore> {
    assertOwner();
    const maxRecords = options.maxRecords ?? 10000, maxBytes = options.maxBytes ?? 8 * 1024 ** 2;
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 10000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 65536 || maxBytes > 64 * 1024 ** 2) throw new Error("PARKING_STORE_LIMIT_INVALID");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("PARKING_DIRECTORY_UNSAFE");
    await chmod(directory, 0o700);
    const canonical = await realpath(directory);
    let body: Body = { schemaVersion: 1, revision: 0, records: [] };
    try {
      const file = await open(join(canonical, snapshotName), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > Math.floor(maxBytes / 2)) throw new Error("PARKING_SNAPSHOT_TOO_LARGE_OR_UNSAFE");
        const snapshot = SnapshotSchema.parse(JSON.parse(await file.readFile("utf8")));
        if (snapshot.sha256 !== digest(snapshot.body)) throw new Error("PARKING_SNAPSHOT_CHECKSUM");
        body = snapshot.body;
        if (body.records.length > maxRecords) throw new Error("PARKING_RECORD_CAPACITY");
        if (new Set(body.records.map(record => record.sessionId)).size !== body.records.length) throw new Error("PARKING_RECORD_DUPLICATE");
        await file.chmod(0o600);
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const store = new RuntimeParkingStore(canonical, assertOwner, { dev: stat.dev, ino: stat.ino }, body, options);
    store.assertAvailable(); await store.diskBytes();
    return store;
  }
  get(sessionId: string): ParkingRecord | undefined {
    this.assertAvailable();
    return structuredClone(this.body.records.find(record => record.sessionId === sessionId));
  }
  list(): ParkingRecord[] { this.assertAvailable(); return structuredClone(this.body.records); }
  put(input: ParkingRecord): Promise<void> {
    const parsed = RecordSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new Error("PARKING_RECORD_INVALID"));
    const record = parsed.data;
    return this.serialize(async () => {
      this.assertAvailable();
      const prior = this.body.records.find(item => item.sessionId === record.sessionId);
      if (prior && JSON.stringify(prior) === JSON.stringify(record)) return;
      if (prior && record.identity.generation < prior.identity.generation) throw new Error("PARKING_GENERATION_REGRESSION");
      if (prior && record.identity.generation === prior.identity.generation
        && (prior.identity.executionId !== record.identity.executionId || prior.identity.workspaceId !== record.identity.workspaceId
          || prior.identity.conversationId !== record.identity.conversationId)) throw new Error("PARKING_IDENTITY_CONFLICT");
      const records = [...this.body.records.filter(item => item.sessionId !== record.sessionId), record]
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
      if (records.length > this.maxRecords) throw new Error("PARKING_RECORD_CAPACITY");
      await this.commit(records);
    });
  }
  /** No automatic eviction. Unresolved records remain pinned even when the caller says retired. */
  retire(sessionId: string, expectedGeneration: number): Promise<boolean> {
    return this.serialize(async () => {
      this.assertAvailable();
      const record = this.body.records.find(item => item.sessionId === sessionId);
      if (!record) return false;
      if (record.phase !== "active" || record.identity.generation !== expectedGeneration
        || this.options.isRetired?.(sessionId) !== true) throw new Error("PARKING_RETIREMENT_UNPROVEN");
      await this.commit(this.body.records.filter(item => item.sessionId !== sessionId)); return true;
    });
  }
  private assertAvailable(): void {
    if (this.poisoned) throw new Error("PARKING_STORE_UNAVAILABLE");
    this.assertOwner();
    const current = lstatSync(this.directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== this.directoryIdentity.dev
      || current.ino !== this.directoryIdentity.ino || (current.mode & 0o077) !== 0) throw new Error("PARKING_DIRECTORY_CHANGED");
  }
  private async diskBytes(): Promise<number> {
    let bytes = 0;
    for (const name of await readdir(this.directory)) {
      if (name !== snapshotName && !temporaryName.test(name)) continue;
      const stat = await lstat(join(this.directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PARKING_STATE_FILE_UNSAFE");
      bytes += stat.size;
      if (bytes > this.maxBytes) throw new Error("PARKING_DISK_CAPACITY");
    }
    return bytes;
  }
  private async commit(records: ParkingRecord[]): Promise<void> {
    try { await this.verifyBase(); } catch (error) { this.poisoned = true; throw error; }
    const body = BodySchema.parse({ schemaVersion: 1, revision: this.body.revision + 1, records });
    const serialized = JSON.stringify({ body, sha256: digest(body) });
    const bytes = Buffer.byteLength(serialized);
    if (bytes > Math.floor(this.maxBytes / 2) || await this.diskBytes() + bytes > this.maxBytes) throw new Error("PARKING_DISK_CAPACITY");
    const temporary = join(this.directory, `runtime-parking-write-${randomUUID()}.pending`);
    try {
      this.assertAvailable();
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
      this.assertAvailable();
      await rename(temporary, join(this.directory, snapshotName));
      const parent = await open(this.directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
      this.assertAvailable();
      this.body = body;
    } catch (error) { this.poisoned = true; throw error; }
    finally {
      // A real process crash may leave a pending file. Reopen preserves it, counts it against
      // the disk cap, and never promotes it over the last committed snapshot.
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") { this.poisoned = true; throw error; }
      });
    }
  }
  private async verifyBase(): Promise<void> {
    this.assertAvailable();
    let file;
    try { file = await open(join(this.directory, snapshotName), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && this.body.revision === 0 && this.body.records.length === 0) return;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > Math.floor(this.maxBytes / 2)) throw new Error("PARKING_SNAPSHOT_TOO_LARGE_OR_UNSAFE");
      const current = SnapshotSchema.parse(JSON.parse(await file.readFile("utf8")));
      if (current.sha256 !== digest(current.body) || current.sha256 !== digest(this.body)) throw new Error("PARKING_SNAPSHOT_CHANGED");
    } finally { await file.close(); }
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    // A second facade sharing the same installation owner cannot overwrite a stale cache.
    const next = (RuntimeParkingStore.writers.get(this.directory) ?? Promise.resolve()).catch(() => undefined).then(action);
    RuntimeParkingStore.writers.set(this.directory, next);
    return next.finally(() => {
      if (RuntimeParkingStore.writers.get(this.directory) === next) RuntimeParkingStore.writers.delete(this.directory);
    });
  }
}
