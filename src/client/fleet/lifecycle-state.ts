import type { FleetLifecycleWatermark } from "../../domain/fleet-preferences.js";
import type { FleetSnapshot, FleetState, FleetThread } from "./state.js";
import { threadRuntimePresence } from "./runtime-presence.js";
import { threadStatus } from "./transport.js";

export function lifecycleNoticeKind(thread: FleetThread): NonNullable<FleetLifecycleWatermark["notice"]>["kind"] | undefined {
  if (threadRuntimePresence(thread) !== "absent") return undefined;
  const status = threadStatus(thread);
  if (status === "Interrupted") return "interrupted";
  if (status === "Failed") return "failed";
  if (status === "Provider limit") return "provider-limit";
  return undefined;
}

/** First use baselines old history. Subsequent losses are identified by durable process generation. */
export function reconcileLifecycleWatermarks(state: FleetState, snapshot: FleetSnapshot): FleetState {
  let watermarks = state.lifecycleWatermarks ?? {};
  const baseline = state.lifecycleInitialized !== true;
  let changed = baseline;
  for (const thread of snapshot.threads) {
    const id = thread.record.id;
    const generation = thread.record.generation ?? 1;
    const previous = watermarks[id];
    if (previous !== undefined && generation < previous.generation) continue;
    const absent = threadRuntimePresence(thread) === "absent";
    const acknowledgedGeneration = previous?.acknowledgedGeneration ?? 0;
    const baselineGeneration = previous?.baselineGeneration ?? (baseline && absent ? generation : 0);
    const kind = baseline ? undefined : lifecycleNoticeKind(thread);
    const notice = kind !== undefined && generation > acknowledgedGeneration && generation > baselineGeneration
      && generation > (previous?.notice?.generation ?? 0)
      ? { generation, kind, occurredAt: thread.record.meaningfulUpdatedAt ?? thread.record.updatedAt }
      : previous?.notice;
    const next: FleetLifecycleWatermark = { generation, acknowledgedGeneration, baselineGeneration, presence: threadRuntimePresence(thread),
      ...(notice === undefined ? {} : { notice }) };
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    if (!changed || watermarks === state.lifecycleWatermarks) watermarks = { ...watermarks };
    changed = true;
    (watermarks as Record<string, FleetLifecycleWatermark>)[id] = next;
  }
  return changed ? { ...state, lifecycleWatermarks: watermarks, lifecycleInitialized: true } : state;
}

export function pendingLifecycleThreads(threads: readonly FleetThread[], state: FleetState): FleetThread[] {
  return threads.filter(({ record }) => state.lifecycleWatermarks?.[record.id]?.notice !== undefined);
}

/** Capture occurrence generations so later events cannot be consumed by an old acknowledgement. */
export function acknowledgeLifecycleNotices(state: FleetState, occurrences: Readonly<Record<string, number>>): FleetState {
  const watermarks = { ...state.lifecycleWatermarks };
  for (const [id, generation] of Object.entries(occurrences)) {
    const previous = watermarks[id];
    if (previous === undefined) continue;
    const acknowledgedGeneration = Math.max(previous.acknowledgedGeneration, generation);
    const { notice, ...rest } = previous;
    watermarks[id] = { ...rest, acknowledgedGeneration,
      ...(notice !== undefined && notice.generation > acknowledgedGeneration ? { notice } : {}) };
  }
  return { ...state, lifecycleWatermarks: watermarks };
}
