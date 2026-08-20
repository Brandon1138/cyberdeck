import type { SessionRecord } from "../domain/session.js";
import {
  selectExpiredThreads,
  type ThreadRetentionPolicy,
} from "../domain/thread-retention.js";

export interface StartupSessionCatalog {
  load(): Promise<SessionRecord[]>;
  compact(records: readonly SessionRecord[]): Promise<void>;
}

export interface StartupScoutReportCleanup {
  remove(sessionId: string): Promise<void>;
}

export interface StartupClaudeBindingCleanup {
  dropClaudeBinding(sessionId: string): Promise<void>;
}

export interface StartupThreadRetentionPorts {
  catalog: StartupSessionCatalog;
  scoutReports: StartupScoutReportCleanup;
  claudeBindings: StartupClaudeBindingCleanup;
}

export async function retainStartupThreads(
  ports: StartupThreadRetentionPorts,
  policy: ThreadRetentionPolicy,
  now: number = Date.now(),
): Promise<SessionRecord[]> {
  const loaded = await ports.catalog.load();
  const expired = new Set(selectExpiredThreads(loaded, policy, now));
  if (expired.size === 0) return loaded;

  await Promise.allSettled(
    loaded
      .filter((record) => expired.has(record.id))
      .map(async (record) => {
        if (record.profile === "scout") await ports.scoutReports.remove(record.id);
        await ports.claudeBindings.dropClaudeBinding(record.id);
      }),
  );

  const retained = loaded.filter((record) => !expired.has(record.id));
  await ports.catalog.compact(retained);
  return retained;
}
