import type { JobDispatchAdapter } from "../domain/dispatch.js";
import { resolveWorkerExecution, type WorkerExecutionPolicy } from "../domain/worker-execution.js";

/** Job attempts have no execution binding yet. Refuse isolation before any provider dispatch. */
export function enforceJobExecutionPolicy(adapter: JobDispatchAdapter, policy?: WorkerExecutionPolicy, resourceManaged = false, resourceAdmitted = false): JobDispatchAdapter {
  return {
    provider: adapter.provider,
    dispatch: async (input) => {
      // Composition must wire the shared durable gate into every concrete adapter.
      if (resourceManaged && !resourceAdmitted) throw new Error("RESOURCE_JOB_EXECUTION_UNSUPPORTED");
      if (resolveWorkerExecution(input.request, policy).executor !== "host") throw new Error("JOB_EXECUTOR_UNSUPPORTED");
      return adapter.dispatch(input);
    },
    cancel: (input) => adapter.cancel(input),
    onReport: (listener) => adapter.onReport(listener),
  };
}
