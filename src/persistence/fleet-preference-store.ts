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

export const FleetFolderDispositionSchema = z.object({
  collapsed: z.boolean(),
  expanded: z.boolean(),
});

export const FLEET_NVIM_LAYOUT_KEY = "/@nvim-layout";

const FleetLaunchProfileRecordSchema = z.object({
  recordType: z.literal("fleet.launch-profile"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  cwd: z.string().startsWith("/"),
  profile: FleetLaunchProfileSchema,
});

/**
 * Folder folds live beside launch profiles because both are per-key operator intent for the same
 * list. The key is only required to look like an absolute path, never to exist on disk: the Orcs
 * roster folds under a sentinel key that no directory can ever occupy.
 */
const FleetFolderDispositionRecordSchema = z.object({
  recordType: z.literal("fleet.folder-collapse"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  key: z.string().startsWith("/"),
  disposition: FleetFolderDispositionSchema,
});

/**
 * Automatic geometry is one machine-local Fleet preference, not an orchestrator policy.
 *
 * The sentinel follows the Orc roster's impossible-path convention so this third record kind can
 * share the append-only file without colliding with a real project. Absence means on: automatic
 * layout is the normal cockpit behavior, while an explicit false record is the durable opt-out.
 * Old files therefore need no migration.
 */
const FleetNvimLayoutRecordSchema = z.object({
  recordType: z.literal("fleet.nvim-layout"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  key: z.literal(FLEET_NVIM_LAYOUT_KEY),
  enabled: z.boolean(),
});

const FleetPreferenceRecordSchema = z.discriminatedUnion("recordType", [
  FleetLaunchProfileRecordSchema,
  FleetFolderDispositionRecordSchema,
  FleetNvimLayoutRecordSchema,
]);

type FleetPreferenceRecord = z.infer<typeof FleetPreferenceRecordSchema>;

export type FleetLaunchProfile = z.infer<typeof FleetLaunchProfileSchema>;
export type FleetFolderDisposition = z.infer<typeof FleetFolderDispositionSchema>;

/** Append-only per-project explicit worker launch selections. */
export class FleetPreferenceStore {
  readonly path: string;
  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "ui", "fleet-preferences.jsonl");
  }

  async set(cwd: string, profile: FleetLaunchProfile): Promise<void> {
    await this.append(FleetPreferenceRecordSchema.parse({
      recordType: "fleet.launch-profile",
      eventId: randomUUID(),
      persistedAt: new Date().toISOString(),
      cwd,
      profile,
    }));
  }

  async setFolderDisposition(key: string, disposition: FleetFolderDisposition): Promise<void> {
    await this.append(FleetPreferenceRecordSchema.parse({
      recordType: "fleet.folder-collapse",
      eventId: randomUUID(),
      persistedAt: new Date().toISOString(),
      key,
      disposition,
    }));
  }

  async setNvimLayout(enabled: boolean): Promise<void> {
    await this.append(FleetPreferenceRecordSchema.parse({
      recordType: "fleet.nvim-layout",
      eventId: randomUUID(),
      persistedAt: new Date().toISOString(),
      key: FLEET_NVIM_LAYOUT_KEY,
      enabled,
    }));
  }

  async list(): Promise<Record<string, FleetLaunchProfile>> {
    const profiles: Record<string, FleetLaunchProfile> = {};
    for (const record of await this.load()) {
      if (record.recordType === "fleet.launch-profile") profiles[record.cwd] = record.profile;
    }
    return profiles;
  }

  async listFolderDispositions(): Promise<Record<string, FleetFolderDisposition>> {
    const dispositions: Record<string, FleetFolderDisposition> = {};
    for (const record of await this.load()) {
      if (record.recordType === "fleet.folder-collapse") dispositions[record.key] = record.disposition;
    }
    return dispositions;
  }

  async nvimLayoutEnabled(): Promise<boolean> {
    let enabled = true;
    for (const record of await this.load()) {
      if (record.recordType === "fleet.nvim-layout") enabled = record.enabled;
    }
    return enabled;
  }

  private async append(record: FleetPreferenceRecord): Promise<void> {
    const handle = await openPrivateAppendFile(this.path);
    try {
      await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async load(): Promise<readonly FleetPreferenceRecord[]> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    const records: FleetPreferenceRecord[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      try {
        records.push(FleetPreferenceRecordSchema.parse(JSON.parse(line)));
      } catch (error) {
        throw new Error(`Invalid Fleet preference at line ${index + 1}`, { cause: error });
      }
    }
    return records;
  }
}
