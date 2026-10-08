import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  FleetFolderDispositionSchema,
  FleetLaunchProfileSchema,
  type FleetFolderDisposition,
  type FleetLaunchProfile,
} from "../domain/fleet-preferences.js";
import { ValidatedJournal } from "./validated-journal.js";

export {
  FleetFolderDispositionSchema,
  FleetLaunchProfileSchema,
  type FleetFolderDisposition,
  type FleetLaunchProfile,
} from "../domain/fleet-preferences.js";

export const FLEET_NVIM_LAYOUT_KEY = "/@nvim-layout";
export const FLEET_PROJECT_MIGRATION_KEY = "/@project-migration";

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

/**
 * A repository the operator calls a project of their own.
 *
 * The registry is what the Fleet list groups by, so it has to remember removals as loudly as it
 * remembers additions: a root that only ever appeared as an absence would be re-added by the next
 * seeding pass. `registered: false` is therefore a record in its own right rather than a deletion.
 */
const FleetProjectRecordSchema = z.object({
  recordType: z.literal("fleet.project"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  root: z.string().startsWith("/"),
  registered: z.boolean(),
});

/**
 * The seeding pass has run. It is a record rather than a computed condition because "the registry
 * is empty" and "the registry has never been seeded" are different states with different answers,
 * and only the second one may scan.
 */
const FleetProjectMigrationRecordSchema = z.object({
  recordType: z.literal("fleet.project-migration"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  key: z.literal(FLEET_PROJECT_MIGRATION_KEY),
});

const FleetPreferenceRecordSchema = z.discriminatedUnion("recordType", [
  FleetLaunchProfileRecordSchema,
  FleetFolderDispositionRecordSchema,
  FleetNvimLayoutRecordSchema,
  FleetProjectRecordSchema,
  FleetProjectMigrationRecordSchema,
]);

type FleetPreferenceRecord = z.infer<typeof FleetPreferenceRecordSchema>;


/** Append-only per-project explicit worker launch selections. */
export class FleetPreferenceStore {
  readonly path: string;
  private readonly journal: ValidatedJournal<PreferenceProjection>;
  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "ui", "fleet-preferences.jsonl");
    this.journal = new ValidatedJournal(this.path, projectPreferences);
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

  async setProject(root: string, registered: boolean): Promise<void> {
    await this.append(FleetPreferenceRecordSchema.parse({
      recordType: "fleet.project",
      eventId: randomUUID(),
      persistedAt: new Date().toISOString(),
      root,
      registered,
    }));
  }

  async completeProjectMigration(): Promise<void> {
    await this.append(FleetPreferenceRecordSchema.parse({
      recordType: "fleet.project-migration",
      eventId: randomUUID(),
      persistedAt: new Date().toISOString(),
      key: FLEET_PROJECT_MIGRATION_KEY,
    }));
  }

  /** Registered roots, alphabetically — the order the Fleet list renders its sections in. */
  async listProjects(): Promise<string[]> {
    return [...(await this.projectDispositions()).entries()]
      .filter(([, registered]) => registered)
      .map(([root]) => root)
      .sort((left, right) => left.localeCompare(right));
  }

  /** Every root the registry has an opinion about, registered or explicitly removed. */
  async projectDispositions(): Promise<Map<string, boolean>> {
    return new Map((await this.journal.read()).projects);
  }

  async projectMigrationCompleted(): Promise<boolean> { return (await this.journal.read()).migrated; }
  async list(): Promise<Record<string, FleetLaunchProfile>> { return structuredClone((await this.journal.read()).profiles); }
  async listFolderDispositions(): Promise<Record<string, FleetFolderDisposition>> { return structuredClone((await this.journal.read()).folders); }
  async nvimLayoutEnabled(): Promise<boolean> { return (await this.journal.read()).enabled; }
  private append(record: FleetPreferenceRecord): Promise<void> { return this.journal.append(record); }
}

interface PreferenceProjection {
  projects: Map<string, boolean>;
  profiles: Record<string, FleetLaunchProfile>;
  folders: Record<string, FleetFolderDisposition>;
  enabled: boolean;
  migrated: boolean;
}

function projectPreferences(content: string): PreferenceProjection {
  const result: PreferenceProjection = { projects: new Map(), profiles: {}, folders: {}, enabled: true, migrated: false };
  const lines = content.split("\n");
  if (!content.endsWith("\n")) lines.pop();
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      const record = FleetPreferenceRecordSchema.parse(JSON.parse(line));
      switch (record.recordType) {
        case "fleet.project": result.projects.set(record.root, record.registered); break;
        case "fleet.launch-profile": result.profiles[record.cwd] = record.profile; break;
        case "fleet.folder-collapse": result.folders[record.key] = record.disposition; break;
        case "fleet.nvim-layout": result.enabled = record.enabled; break;
        case "fleet.project-migration": result.migrated = true; break;
      }
    } catch (error) { throw new Error(`Invalid Fleet preference at line ${index + 1}`, { cause: error }); }
  }
  return result;
}
