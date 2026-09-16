import type { JobDispatchAdapter } from "../domain/dispatch.js";
import { resolveWorkerExecution, type WorkerExecutionPolicy } from "../domain/worker-execution.js";

/** Job attempts have no execution binding yet. Refuse isolation before any provider dispatch. */
export function enforceJobExecutionPolicy(adapter: JobDispatchAdapter, policy?: WorkerExecutionPolicy, resourceManaged = false): JobDispatchAdapter {
  return {
    provider: adapter.provider,
    dispatch: async (input) => {
      // Job adapters have no durable PID/cgroup identity yet. Never bypass the shared budget.
      if (resourceManaged) throw new Error("RESOURCE_JOB_EXECUTION_UNSUPPORTED");
      if (resolveWorkerExecution(input.request, policy).executor !== "host") throw new Error("JOB_EXECUTOR_UNSUPPORTED");
      return adapter.dispatch(input);
    },
    cancel: (input) => adapter.cancel(input),
    onReport: (listener) => adapter.onReport(listener),
  };
}
