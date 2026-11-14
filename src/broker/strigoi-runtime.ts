import { StrigoiLifecycle, type StrigoiLifecycleOptions } from "../orchestration/strigoi-lifecycle.js";
import type { StrigoiContinuity } from "../orchestration/strigoi-continuity.js";
import type { SessionRegistry } from "./session-registry.js";
import { StrigoiSuccession, type StrigoiSuccessionOptions } from "../orchestration/strigoi-succession.js";

/** Composition adapter: core startup never waits on provider discovery, preparation or launch. */
export async function composeStrigoiRuntime(options: StrigoiLifecycleOptions & { registry: SessionRegistry; beforeDelete?: (id: string) => Promise<void>; withDeletion?: <T>(id: string, commit: () => Promise<T>) => Promise<T>; continuity?: StrigoiContinuity;
  workers?: import("../orchestration/strigoi-ports.js").StrigoiReconciliationParticipant;
  succession?: Pick<StrigoiSuccessionOptions, "packets" | "sources" | "turns" | "workers" | "delivery" | "activity" | "now"> }) {
  const lifecycle = new StrigoiLifecycle(options);
  if (options.succession && !options.continuity) throw new Error("STRIGOI_CONTINUITY_REQUIRED");
  const workers = options.succession?.workers ?? options.workers;
  const succession = options.succession ? new StrigoiSuccession({ ...options, ...options.succession, ...(workers ? { workers } : {}), lifecycle, continuity: options.continuity! }) : undefined;
  const report = (error: unknown) => options.onError?.(error);
  // Corrupt resident state closes resident work but cannot prevent unrelated Fleet from booting.
  await lifecycle.quiesce().catch(report);
  options.registry.setResidentLifecycle({
    validateReservation: (reservation) => lifecycle.validateReservation(reservation),
    beforeStop: (id) => lifecycle.beforeStop(id),
    beforeResume: (id) => lifecycle.beforeResume(id),
    ...(options.withDeletion ? { withDeletion: options.withDeletion } : {}),
    ...(options.beforeDelete ? { beforeDelete: options.beforeDelete } : {}),
  });
  let unsubscribe: (() => void) | undefined;
  return {
    lifecycle, continuity: options.continuity, succession, workers,
    // Task 8 must supply delivery and the native succession composition before production release.
    integration: succession && workers && options.succession?.delivery ? "composed" as const : "awaiting-task8-delivery" as const,
    start: () => {
      unsubscribe ??= options.registry.onSessionUpdate(() => { void lifecycle.reconcile().catch(report); });
      void lifecycle.reconcile().catch(report);
    },
    dispose: () => { unsubscribe?.(); lifecycle.dispose(); },
  };
}
