import type { FleetLifecycleWatermark } from "./fleet-preferences.js";

/** Merge observation and acknowledgement independently across Fleet clients and stale writes. */
export function mergeLifecycleWatermark(previous: FleetLifecycleWatermark | undefined, next: FleetLifecycleWatermark): FleetLifecycleWatermark {
  const generation = Math.max(previous?.generation ?? 0, next.generation);
  const acknowledgedGeneration = Math.max(previous?.acknowledgedGeneration ?? 0, next.acknowledgedGeneration);
  const baselineGeneration = Math.max(previous?.baselineGeneration ?? 0, next.baselineGeneration ?? 0);
  const candidate = (previous?.notice?.generation ?? 0) >= (next.notice?.generation ?? 0)
    ? previous?.notice : next.notice;
  const presence = previous !== undefined && (previous.generation > next.generation
    || previous.generation === next.generation && previous.presence === "absent") ? previous.presence : next.presence;
  return { generation, acknowledgedGeneration, baselineGeneration,
    ...(presence === undefined ? {} : { presence }),
    ...(candidate !== undefined && candidate.generation > acknowledgedGeneration ? { notice: candidate } : {}) };
}
