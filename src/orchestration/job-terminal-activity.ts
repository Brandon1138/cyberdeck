import { createHash } from "node:crypto";
import { z } from "zod";
import type { PersistedJobState } from "../control-plane/job-control-plane.js";
import { AgentActivitySchema, type ActivityInput } from "../domain/agent-activity.js";
import { JobRecordSchema } from "../domain/job.js";
import type { AgentActivityPort } from "./agent-activity-port.js";
import type { EvaluationReplayStorePort } from "./task-evaluation-ports.js";
import type { EvaluationCoverageAudit } from "./task-evaluation-reconciliation.js";

const StateSchema = z.object({ record: JobRecordSchema, parentSessionId: z.uuid().optional() });
const ActivityInputSchema = AgentActivitySchema.omit({ sequence: true });

/** Historical job source only. No runtime lookup, launch-model claim, or report-back timestamp. */
export function projectJobTerminalActivity(input: PersistedJobState): ActivityInput | null {
  const parsed = StateSchema.safeParse(input);
  if (!parsed.success) throw new Error("EVALUATION_JOB_HISTORY_INVALID");
  const { record, parentSessionId } = parsed.data, lifecycle = record.lifecycle;
  if (record.schemaVersion !== 1 || record.request.schemaVersion !== 1) throw new Error("EVALUATION_JOB_HISTORY_INVALID");
  if (lifecycle.status !== "settled" && lifecycle.status !== "interrupted") return null;
  // For this kind only, a standalone job uses its canonical scheduling subject as the
  // activity subject alias. This does not create a provider session, process, or controller.
  const sessionId = record.sessionId ?? parentSessionId ?? record.id;
  const endedAt = lifecycle.status === "settled" ? lifecycle.finishedAt : lifecycle.interruptedAt;
  if (Date.parse(endedAt) < Date.parse(record.createdAt)) throw new Error("EVALUATION_JOB_HISTORY_INVALID");
  const sourceKey = `job:${record.id}:${lifecycle.status}:${endedAt}`;
  // RFC 9562 UUIDv8: a deterministic opaque event identity, not a fabricated runtime identity.
  const digest = createHash("sha256").update(sourceKey).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x80; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  const eventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const outcome = lifecycle.status === "interrupted" ? "unknown" : lifecycle.result.outcome === "cancelled" ? "cancelled"
    : lifecycle.result.outcome === "completed" ? "succeeded" : "failed";
  return ActivityInputSchema.parse({ schemaVersion: 1, eventId, sourceKey, runId: record.id, jobId: record.id,
    sessionId, workerId: sessionId, generation: 1, causationId: record.id,
    observedAt: endedAt, occurredAt: endedAt, kind: "job.settled", provenance: "broker",
    coverage: "complete-for-source", operation: "lifecycle", outcome, origin: "unattributed",
    provider: record.request.provider });
}

function projectBounded(states: Iterable<PersistedJobState>, maxRecords: number): ActivityInput[] {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100000)
    throw new Error("EVALUATION_JOB_AUDIT_LIMIT_INVALID");
  const events: ActivityInput[] = [], seen = new Set<string>();
  let count = 0;
  for (const state of states) {
    if (++count > maxRecords) throw new Error("EVALUATION_JOB_AUDIT_LIMIT");
    const event = projectJobTerminalActivity(state);
    if (seen.has(state.record.id)) throw new Error("EVALUATION_JOB_HISTORY_INVALID");
    seen.add(state.record.id);
    if (event) events.push(event);
  }
  return events;
}

/** Await acknowledged activity append before the ordinary evaluator can advance its checkpoint.
 * Validate the whole bounded snapshot first; a legacy gap never creates a partial repaired batch. */
export async function repairTerminalJobProjections(
  outbox: Pick<EvaluationReplayStorePort, "hasTerminalSource">,
  activity: Pick<AgentActivityPort, "append">,
  states: Iterable<PersistedJobState>, maxRecords = 10000,
): Promise<void> {
  for (const event of projectBounded(states, maxRecords))
    if (!outbox.hasTerminalSource(event.sourceKey)) await activity.append(event);
}

/** An append is not evaluation capture: coverage requires the durable outbox's source index. */
export async function auditTerminalJobs(
  outbox: Pick<EvaluationReplayStorePort, "hasTerminalSource">,
  states: Iterable<PersistedJobState>, maxRecords = 10000,
): Promise<EvaluationCoverageAudit> {
  let events: ActivityInput[];
  try { events = projectBounded(states, maxRecords); }
  catch (error) {
    return { state: "gap", reason: error instanceof Error && /^EVALUATION_JOB_[A-Z_]+$/.test(error.message)
      ? error.message : "EVALUATION_JOB_HISTORY_INVALID" };
  }
  return events.some(event => !outbox.hasTerminalSource(event.sourceKey))
    ? { state: "gap", reason: "canonical-job-projection-missing" } : { state: "complete" };
}
