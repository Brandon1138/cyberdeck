import type { AgentActivity } from "../../domain/agent-activity.js";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";

/** Freeze only the retained startup history, before replay/admission. Missing prior history
 * remains a replay gap; this bounded read never invents coverage for pruned events. */
export async function legacyEvaluationActivitySnapshot(activity: AgentActivityPort, limit = 10000) {
  if (!activity.readGlobal || !activity.replayBounds) throw new Error("EVALUATION_LEGACY_ACTIVITY_UNAVAILABLE");
  const before = activity.replayBounds();
  if (before.uncertain || before.captureGaps) throw new Error("EVALUATION_LEGACY_ACTIVITY_UNAVAILABLE");
  let sequence = before.firstSequence === null ? before.sequence : before.firstSequence - 1;
  if (before.sequence - sequence > limit) throw new Error("EVALUATION_LEGACY_ACTIVITY_LIMIT");
  const events: AgentActivity[] = [];
  while (sequence < before.sequence) {
    const page = await activity.readGlobal(sequence, Math.min(1000, before.sequence - sequence));
    if (!page.length || page.length > 1000) throw new Error("EVALUATION_LEGACY_ACTIVITY_GAP");
    for (const event of page) {
      if (event.sequence !== sequence + 1 || event.sequence > before.sequence) throw new Error("EVALUATION_LEGACY_ACTIVITY_GAP");
      events.push(event); sequence = event.sequence;
    }
  }
  const after = activity.replayBounds();
  if (after.sourceId !== before.sourceId || after.sequence < before.sequence || after.uncertain || after.captureGaps)
    throw new Error("EVALUATION_LEGACY_ACTIVITY_CHANGED");
  return { sourceId: before.sourceId, throughSequence: before.sequence, events };
}
