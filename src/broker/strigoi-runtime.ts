import { StrigoiLifecycle, type StrigoiLifecycleOptions } from "../orchestration/strigoi-lifecycle.js";
import type { StrigoiContinuity } from "../orchestration/strigoi-continuity.js";
import type { SessionRegistry } from "./session-registry.js";

/** Composition adapter: core startup never waits on provider discovery, preparation or launch. */
export async function composeStrigoiRuntime(options: StrigoiLifecycleOptions & { registry: SessionRegistry; beforeDelete?: (id: string) => Promise<void>; withDeletion?: <T>(id: string, commit: () => Promise<T>) => Promise<T>; continuity?: StrigoiContinuity }) {
  const lifecycle = new StrigoiLifecycle(options);
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
    lifecycle, continuity: options.continuity,
    start: () => {
      unsubscribe ??= options.registry.onSessionUpdate(() => { void lifecycle.reconcile().catch(report); });
      void lifecycle.reconcile().catch(report);
    },
    dispose: () => { unsubscribe?.(); lifecycle.dispose(); },
  };
}
