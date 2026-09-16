import type { JobRecord } from "../domain/job.js";
import type { AdmissionScheduler } from "./admission-scheduler.js";

/** Count/repository admission precedes asynchronous resource admission; each owns its release. */
export async function pumpAdmittedJobs<T extends { record: JobRecord; holdsSlot?: boolean }>(
  scheduler: AdmissionScheduler, lookup: (id: string) => T | undefined, dispatch: (entry: T) => Promise<void>,
): Promise<void> {
  for (;;) {
    const reservation = scheduler.admitNext();
    if (!reservation) return;
    const entry = lookup(reservation.jobId);
    if (!entry || entry.record.lifecycle.status !== "queued") { scheduler.release(reservation.jobId); continue; }
    entry.holdsSlot = true;
    await dispatch(entry);
  }
}
