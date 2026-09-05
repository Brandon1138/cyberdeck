import type { ExecutionStorePort, WorkerExecutionPort } from "./session/execution-ports.js";
import type { WorkerExecutor } from "../domain/worker-execution.js";

/** Startup closes admission until known guest writers are stopped and durable state agrees. */
export async function reconcileExecutions(store: ExecutionStorePort,
  backends: Partial<Record<WorkerExecutor, WorkerExecutionPort>>,
): Promise<{ stopped: string[]; unreachable: string[]; absent: string[] }> {
  const result = { stopped: [] as string[], unreachable: [] as string[], absent: [] as string[] };
  for (const record of store.list()) {
    if (record.ref.executor === "host" || record.phase === "destroyed") continue;
    const backend = backends[record.ref.executor];
    let state = backend === undefined ? undefined : await backend.inspect(record.ref);
    if (state?.state === "running") {
      await store.put({ ...record, phase: "stopping", updatedAt: new Date().toISOString() });
      try { state = await backend!.stop(record.ref, false); }
      catch { state = undefined; }
    }
    if (state === undefined || state.state === "unreachable" || state.state === "running") {
      result.unreachable.push(record.ref.executionId);
      continue; // No claim of stopped/destroyed, no deletion, no replacement generation.
    }
    if (state.state === "absent") {
      result.absent.push(record.ref.executionId);
      await store.put({ ...record, phase: "failed", failure: "recovery", updatedAt: new Date().toISOString() });
    } else {
      result.stopped.push(record.ref.executionId);
      await store.put({ ...record, phase: "stopped", updatedAt: new Date().toISOString() });
    }
  }
  return result;
}
