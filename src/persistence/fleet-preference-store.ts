import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ProviderIdSchema } from "../domain/provider-registration.js";
import { ReasoningEffortSchema } from "../domain/session.js";
import { openPrivateAppendFile } from "./private-files.js";

export const FleetLaunchProfileSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  effort: ReasoningEffortSchema.optional(),
});

const FleetPreferenceRecordSchema = z.object({
  recordType: z.literal("fleet.launch-profile"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  cwd: z.string().startsWith("/"),
  profile: FleetLaunchProfileSchema,
});

export type FleetLaunchProfile = z.infer<typeof FleetLaunchProfileSchema>;

/** Append-only per-project explicit worker launch selections. */
export class FleetPreferenceStore {
  readonly path: string;
  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "ui", "fleet-preferences.jsonl");
  }

  async set(cwd: string, profile: FleetLaunchProfile): Promise<void> {
    const record = FleetPreferenceRecordSchema.parse({
      recordType: "fleet.launch-profile",
      eventId: randomUUID(),
      persistedAt: new Date().toISOString(),
      cwd,
      profile,
    });
    const handle = await openPrivateAppendFile(this.path);
    try {
      await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async list(): Promise<Record<string, FleetLaunchProfile>> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    const profiles: Record<string, FleetLaunchProfile> = {};
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      try {
        const record = FleetPreferenceRecordSchema.parse(JSON.parse(line));
        profiles[record.cwd] = record.profile;
      } catch (error) {
        throw new Error(`Invalid Fleet preference at line ${index + 1}`, { cause: error });
      }
    }
    return profiles;
  }
}
