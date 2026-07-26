import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { SessionRecordSchema, type SessionRecord } from "../domain/session.js";
import { ensurePrivateDirectory, openPrivateAppendFile } from "./private-files.js";

const SessionSnapshotSchema = z.object({
  recordType: z.literal("session.snapshot"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  record: SessionRecordSchema,
});

const SessionDeletedSchema = z.object({
  recordType: z.literal("session.deleted"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  sessionId: z.uuid(),
});

const SessionStoreEnvelopeSchema = z.union([SessionSnapshotSchema, SessionDeletedSchema]);

export interface SessionStoreOptions {
  now?: () => string;
  idFactory?: () => string;
}

/** Append-only, fsynced latest-state catalog for durable interactive conversations. */
export class SessionStore {
  readonly path: string;
  private writeTail = Promise.resolve();

  constructor(
    stateDirectory: string,
    private readonly options: SessionStoreOptions = {},
  ) {
    this.path = join(stateDirectory, "sessions", "catalog.jsonl");
  }

  async put(record: SessionRecord): Promise<void> {
    const envelope = SessionSnapshotSchema.parse({
      recordType: "session.snapshot",
      eventId: this.options.idFactory?.() ?? randomUUID(),
      persistedAt: this.options.now?.() ?? new Date().toISOString(),
      record,
    });
    await this.enqueue(envelope);
  }

  async delete(sessionId: string): Promise<void> {
    const envelope = SessionDeletedSchema.parse({
      recordType: "session.deleted",
      eventId: this.options.idFactory?.() ?? randomUUID(),
      persistedAt: this.options.now?.() ?? new Date().toISOString(),
      sessionId,
    });
    await this.enqueue(envelope);
  }

  async load(): Promise<SessionRecord[]> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    const latest = new Map<string, SessionRecord>();
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      let parsed: z.infer<typeof SessionStoreEnvelopeSchema>;
      try {
        parsed = SessionStoreEnvelopeSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid session catalog record at line ${index + 1}`, { cause: error });
      }
      if (parsed.recordType === "session.deleted") latest.delete(parsed.sessionId);
      else latest.set(parsed.record.id, parsed.record);
    }
    return [...latest.values()];
  }

  /**
   * Rewrite the catalog so it holds exactly `records`, one snapshot each.
   *
   * Retention retires threads by appending tombstones, so without compaction the file grows even
   * as the retained set shrinks. The rewrite goes through a private temporary file and an atomic
   * rename: an interrupted compaction leaves the previous catalog intact rather than a partial one.
   */
  async compact(records: readonly SessionRecord[]): Promise<void> {
    const body = records
      .map((record) => `${JSON.stringify(SessionSnapshotSchema.parse({
        recordType: "session.snapshot",
        eventId: this.options.idFactory?.() ?? randomUUID(),
        persistedAt: this.options.now?.() ?? new Date().toISOString(),
        record,
      }))}\n`)
      .join("");

    this.writeTail = this.writeTail.then(async () => {
      await ensurePrivateDirectory(dirname(this.path));
      const temporary = `${this.path}.compact-${process.pid}`;
      const handle = await open(temporary, "w", 0o600);
      try {
        await handle.chmod(0o600);
        await handle.write(body, undefined, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, this.path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
    await this.writeTail;
  }

  private async enqueue(record: z.infer<typeof SessionStoreEnvelopeSchema>): Promise<void> {
    this.writeTail = this.writeTail.then(async () => {
      const handle = await openPrivateAppendFile(this.path);
      try {
        await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    await this.writeTail;
  }
}
