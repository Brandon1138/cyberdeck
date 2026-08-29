import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ProviderPermissionPolicySchema,
  type ProviderPermissionPolicy,
} from "../orchestration/permission-policy.js";
import { ProviderIdSchema, type ProviderId } from "../domain/session.js";
import { openPrivateAppendFile } from "./private-files.js";

const ProviderPermissionPreferenceRecordSchema = z.object({
  recordType: z.literal("provider.permission-policy"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  provider: ProviderIdSchema,
  policy: ProviderPermissionPolicySchema,
});

export type ProviderPermissionPreferences =
  Partial<Record<ProviderId, ProviderPermissionPolicy>>;

export interface ProviderPermissionPreferencePort {
  list(): Promise<ProviderPermissionPreferences>;
  set(provider: ProviderId, policy: ProviderPermissionPolicy): Promise<void>;
}

/** Append-only user preferences for provider-neutral permission policy selections. */
export class ProviderPermissionPreferenceStore
implements ProviderPermissionPreferencePort {
  readonly path: string;

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "preferences", "provider-permissions.jsonl");
  }

  async list(): Promise<ProviderPermissionPreferences> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    const preferences: ProviderPermissionPreferences = {};
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      try {
        const record = ProviderPermissionPreferenceRecordSchema.parse(JSON.parse(line));
        preferences[record.provider] = record.policy;
      } catch (error) {
        throw new Error(`Invalid provider permission preference at line ${index + 1}`, {
          cause: error,
        });
      }
    }
    return preferences;
  }

  async set(provider: ProviderId, policy: ProviderPermissionPolicy): Promise<void> {
    const record = ProviderPermissionPreferenceRecordSchema.parse({
      recordType: "provider.permission-policy",
      eventId: randomUUID(),
      persistedAt: new Date().toISOString(),
      provider,
      policy,
    });
    const handle = await openPrivateAppendFile(this.path);
    try {
      await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
