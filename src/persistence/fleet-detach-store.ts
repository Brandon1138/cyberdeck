import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { openPrivateAppendFile } from "./private-files.js";

export const FleetDetachIdentitySchema = z.string().trim().min(1).max(200);

const FleetDetachRecordSchema = z.object({
  recordType: z.literal("fleet.detach"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  identity: FleetDetachIdentitySchema,
  sessionId: z.uuid(),
});

const FleetDetachClearRecordSchema = z.object({
  recordType: z.literal("fleet.detach.clear"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  identity: FleetDetachIdentitySchema,
  sessionId: z.uuid(),
});

export interface FleetDetachStoreOptions {
  now?: () => string;
  idFactory?: () => string;
}

/** Append-only explicit detach history, scoped to the operator or orchestrator that detached. */
export class FleetDetachStore {
  readonly path: string;
  private writeTail = Promise.resolve();

  constructor(
    stateDirectory: string,
    private readonly options: FleetDetachStoreOptions = {},
  ) {
    this.path = join(stateDirectory, "ui", "fleet-detaches.jsonl");
  }

  async record(identity: string, sessionId: string): Promise<void> {
    await this.append(FleetDetachRecordSchema.parse({
      recordType: "fleet.detach",
      eventId: this.options.idFactory?.() ?? randomUUID(),
      persistedAt: this.options.now?.() ?? new Date().toISOString(),
      identity,
      sessionId,
    }));
  }

  /**
   * Clear only the stale target that was observed. If a newer detach wins the append race, replaying
   * this tombstone leaves that newer target intact.
   */
  async clear(identity: string, sessionId: string): Promise<void> {
    await this.append(FleetDetachClearRecordSchema.parse({
      recordType: "fleet.detach.clear",
      eventId: this.options.idFactory?.() ?? randomUUID(),
      persistedAt: this.options.now?.() ?? new Date().toISOString(),
      identity,
      sessionId,
    }));
  }

  async latestSessionId(identity: string): Promise<string | undefined> {
    const parsedIdentity = FleetDetachIdentitySchema.parse(identity);
    return (await this.load()).get(parsedIdentity);
  }

  private async append(
    entry: z.infer<typeof FleetDetachRecordSchema> | z.infer<typeof FleetDetachClearRecordSchema>,
  ): Promise<void> {
    this.writeTail = this.writeTail.then(async () => {
      const handle = await openPrivateAppendFile(this.path);
      try {
        await handle.write(`${JSON.stringify(entry)}\n`, undefined, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    await this.writeTail;
  }

  private async load(): Promise<Map<string, string>> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    const latest = new Map<string, string>();
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      try {
        const value: unknown = JSON.parse(line);
        const clear = FleetDetachClearRecordSchema.safeParse(value);
        if (clear.success) {
          if (latest.get(clear.data.identity) === clear.data.sessionId) {
            latest.delete(clear.data.identity);
          }
          continue;
        }
        const entry = FleetDetachRecordSchema.parse(value);
        latest.set(entry.identity, entry.sessionId);
      } catch (error) {
        throw new Error(`Invalid Fleet detach record at line ${index + 1}`, { cause: error });
      }
    }
    return latest;
  }
}
