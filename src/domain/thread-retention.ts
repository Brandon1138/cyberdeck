import { z } from "zod";
import type { SessionRecord } from "./session.js";

/** Finished threads older than this are retired automatically. `null` disables the age bound. */
export const DEFAULT_THREAD_RETENTION_DAYS = 7;
/** Newest-first ceiling on retained finished threads. `null` disables the count bound. */
export const DEFAULT_THREAD_RETENTION_COUNT = 200;

/**
 * Retention exists so the fleet view can accumulate history without the operator stopping and
 * deleting each finished thread by hand. Both bounds are deliberately generous: the catalog is a
 * work log, and the cost of keeping a finished record is one JSONL line, not a process.
 */
export const ThreadRetentionPolicySchema = z.object({
  maxAgeDays: z.number().positive().nullable().default(DEFAULT_THREAD_RETENTION_DAYS),
  maxThreads: z.number().int().positive().nullable().default(DEFAULT_THREAD_RETENTION_COUNT),
  /** A pinned thread is an explicit operator decision to keep it; retention never overrides that. */
  keepPinned: z.boolean().default(true),
});

export type ThreadRetentionPolicy = z.infer<typeof ThreadRetentionPolicySchema>;

/**
 * A thread the broker is free to retire: it holds no process, so removing its record removes
 * nothing but history. `errored` is excluded on purpose — its OS process is still running and must
 * be stopped before the record can go.
 */
export function isRetirableThread(record: SessionRecord): boolean {
  if (record.exitCode === null) return false;
  return record.executionState === "exited"
    || record.executionState === "failed"
    || record.executionState === "cancelled";
}

function retirementTimestamp(record: SessionRecord): string {
  return record.meaningfulUpdatedAt ?? record.updatedAt;
}

/**
 * Select the thread ids that have fallen out of retention, newest kept first.
 *
 * A parent is never selected while any of its children survive, so the caller can delete the
 * returned ids in any order without orphaning a record or tripping the registry's child guard.
 */
export function selectExpiredThreads(
  records: readonly SessionRecord[],
  policy: ThreadRetentionPolicy,
  now: number = Date.now(),
): string[] {
  const retirable = records
    .filter((record) => isRetirableThread(record))
    .filter((record) => !(policy.keepPinned && record.pinned === true))
    .sort((left, right) => retirementTimestamp(right).localeCompare(retirementTimestamp(left)));

  const expired = new Set<string>();
  if (policy.maxAgeDays !== null) {
    const cutoff = now - policy.maxAgeDays * 24 * 60 * 60 * 1_000;
    for (const record of retirable) {
      if (Date.parse(retirementTimestamp(record)) < cutoff) expired.add(record.id);
    }
  }
  if (policy.maxThreads !== null) {
    for (const record of retirable.slice(policy.maxThreads)) expired.add(record.id);
  }

  // Retiring a parent while a child survives would leave the survivor unreachable in the fleet
  // tree, so a retained descendant pins its whole ancestry. One pass per removal converges because
  // every pass either removes an id or ends.
  const byId = new Map(records.map((record) => [record.id, record]));
  for (;;) {
    const rescued = [...expired].filter((id) =>
      (byId.get(id)?.childIds ?? []).some((childId) => byId.has(childId) && !expired.has(childId)));
    if (rescued.length === 0) break;
    for (const id of rescued) expired.delete(id);
  }

  return [...expired];
}
