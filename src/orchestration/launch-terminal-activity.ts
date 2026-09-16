import { createHash } from "node:crypto";
import { AgentActivitySchema, type ActivityInput } from "../domain/agent-activity.js";
import { SessionLaunchIntentSchema, type SessionLaunchIntent, type SessionLaunchIntentPort } from "../domain/session-launch-intent.js";
import type { AgentActivityPort } from "./agent-activity-port.js";
import type { EvaluationReplayStorePort } from "./task-evaluation-ports.js";
import type { EvaluationCoverageAudit } from "./task-evaluation-reconciliation.js";

const ActivityInputSchema = AgentActivitySchema.omit({ sequence: true });
/** A submitted launch prompt is a task boundary even when no provider ever starts.
 * Successful launch is not task completion: its native turn remains the result authority. */
export function projectLaunchTerminalActivity(input: SessionLaunchIntent): ActivityInput | null {
  const checked = SessionLaunchIntentSchema.safeParse(input);
  if (!checked.success) throw new Error("EVALUATION_LAUNCH_HISTORY_INVALID");
  const intent = checked.data;
  if (intent.phase !== "terminal") return null;
  if (!intent.terminalAt || !intent.terminalFromPhase || !intent.outcome
    || Date.parse(intent.terminalAt) < Date.parse(intent.record.createdAt))
    throw new Error("EVALUATION_LAUNCH_HISTORY_INVALID");
  if (intent.outcome === "launched" || intent.initialPrompt === undefined) return null;
  const generation = intent.record.generation;
  if (!generation) throw new Error("EVALUATION_LAUNCH_HISTORY_INVALID");
  const sourceKey = `launch:${intent.requestId}:${intent.outcome}:${intent.terminalAt}`;
  const digest = createHash("sha256").update(sourceKey).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x80; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  const eventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const outcome = intent.outcome === "cancelled" ? "cancelled"
    : intent.outcome === "failed" && intent.terminalFromPhase !== "launching" ? "failed" : "unknown";
  return ActivityInputSchema.parse({ schemaVersion: 1, eventId, sourceKey,
    runId: intent.requestId, causationId: intent.requestId, sessionId: intent.record.id,
    workerId: intent.record.id, generation, observedAt: intent.terminalAt, occurredAt: intent.terminalAt,
    kind: "launch.settled", provenance: "broker", coverage: "complete-for-source",
    operation: "lifecycle", outcome, origin: "initial-prompt", provider: intent.record.provider,
    // The input stays in the private source until the outbox owns this immutable hash.
    sourceHash: createHash("sha256").update(intent.initialPrompt).digest("hex") });
}

function projectBounded(intents: Iterable<SessionLaunchIntent>, maxRecords: number): { intent: SessionLaunchIntent; event: ActivityInput | null }[] {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 10000)
    throw new Error("EVALUATION_LAUNCH_AUDIT_LIMIT_INVALID");
  const rows: { intent: SessionLaunchIntent; event: ActivityInput | null }[] = [], seen = new Set<string>();
  for (const intent of intents) {
    if (rows.length >= maxRecords) throw new Error("EVALUATION_LAUNCH_AUDIT_LIMIT");
    if (seen.has(intent.record.id)) throw new Error("EVALUATION_LAUNCH_HISTORY_INVALID");
    seen.add(intent.record.id); rows.push({ intent, event: projectLaunchTerminalActivity(intent) });
  }
  return rows;
}
export async function repairTerminalLaunchProjections(outbox: Pick<EvaluationReplayStorePort, "hasTerminalSource">,
  activity: Pick<AgentActivityPort, "append">, intents: Iterable<SessionLaunchIntent>, maxRecords = 384): Promise<void> {
  for (const { event } of projectBounded(intents, maxRecords))
    if (event && !outbox.hasTerminalSource(event.sourceKey)) await activity.append(event);
}
export function auditTerminalLaunches(outbox: Pick<EvaluationReplayStorePort, "hasTerminalSource">,
  intents: Iterable<SessionLaunchIntent>, maxRecords = 384): EvaluationCoverageAudit {
  try {
    return projectBounded(intents, maxRecords).some(({ event }) => event && !outbox.hasTerminalSource(event.sourceKey))
      ? { state: "gap", reason: "canonical-launch-projection-missing" } : { state: "complete" };
  } catch (error) {
    return { state: "gap", reason: error instanceof Error && /^EVALUATION_LAUNCH_[A-Z_]+$/.test(error.message)
      ? error.message : "EVALUATION_LAUNCH_HISTORY_INVALID" };
  }
}
/** Only terminal sources already owned by the outbox can be retired. An acknowledged
 * launched intent instead belongs to its durable session/native task capture path. */
export async function retireCapturedLaunches(outbox: Pick<EvaluationReplayStorePort, "hasTerminalSource">,
  launches: Pick<SessionLaunchIntentPort, "list" | "ackTerminal">): Promise<void> {
  for (const { intent, event } of projectBounded(launches.list(), 384)) {
    if (intent.phase !== "terminal" || !intent.terminalProjectionCommitted || event && !outbox.hasTerminalSource(event.sourceKey)) continue;
    await launches.ackTerminal(intent.record.id, intent.requestId, intent.terminalAt!);
  }
}
