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
  let pending: Promise<void> | undefined, dirty = false, disposed = false;
  const reconcile = (): void => {
    if (disposed) return;
    dirty = true;
    if (pending) return;
    // Coalesce the complete background pass. Sharing only lifecycle.reconcile() gives every
    // screen-update waiter its own delivery flush when that shared lifecycle promise settles.
    pending = Promise.resolve().then(async () => {
      while (dirty && !disposed) {
        dirty = false;
        try {
          await lifecycle.reconcile();
          if (!disposed) await options.succession?.delivery?.flush?.();
        } catch (error) { report(error); }
      }
    }).finally(() => {
      pending = undefined;
      if (dirty && !disposed) reconcile();
    });
  };
  return {
    lifecycle, continuity: options.continuity, succession, workers, delivery: options.succession?.delivery,
    // Partial composition remains available only to isolated lifecycle embeddings.
    integration: succession && workers && options.succession?.delivery ? "composed" as const : "incomplete" as const,
    start: () => {
      if (disposed) return;
      unsubscribe ??= options.registry.onSessionUpdate(reconcile);
      reconcile();
    },
    dispose: () => { disposed = true; dirty = false; unsubscribe?.(); lifecycle.dispose(); },
  };
}
