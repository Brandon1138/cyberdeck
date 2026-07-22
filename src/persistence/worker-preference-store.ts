import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { openPrivateAppendFile } from "./private-files.js";

export const WorkerPreferencesSchema = z.object({
  caveman: z.boolean().default(false),
});

const WorkerPreferenceRecordSchema = z.object({
  recordType: z.literal("worker.preferences"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  preferences: WorkerPreferencesSchema,
});

export type WorkerPreferences = z.infer<typeof WorkerPreferencesSchema>;

/** Append-only, box-level defaults snapshotted into subsequently started Cyberdeck workers. */
export class WorkerPreferenceStore {
  readonly path: string;

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "preferences", "workers.jsonl");
  }

  async get(): Promise<WorkerPreferences> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    let latest = WorkerPreferencesSchema.parse({});
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      try {
        latest = WorkerPreferenceRecordSchema.parse(JSON.parse(line)).preferences;
      } catch (error) {
        throw new Error(`Invalid worker preference at line ${index + 1}`, { cause: error });
      }
    }
    return latest;
  }

  async set(preferences: WorkerPreferences): Promise<WorkerPreferences> {
    const parsed = WorkerPreferencesSchema.parse(preferences);
    const record = WorkerPreferenceRecordSchema.parse({
      recordType: "worker.preferences",
      eventId: randomUUID(),
      persistedAt: new Date().toISOString(),
      preferences: parsed,
    });
    const handle = await openPrivateAppendFile(this.path);
    try {
      await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return parsed;
  }
}
