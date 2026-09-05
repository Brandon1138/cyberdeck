import { randomUUID } from "node:crypto";
import type { SessionRecord } from "../domain/session.js";
import type { SessionRuntime } from "../domain/session-runtime.js";
import { ExecutionError, resolveWorkerExecution, type ExecutionRecord, type WorkerExecutor, type WorkerExecutionPolicy } from "../domain/worker-execution.js";
import type { ExecutionStorePort, SessionExecutionPort, WorkerExecutionPort } from "./session/execution-ports.js";
import type { ProviderLaunchSpec } from "./session/provider-ports.js";

/** Execution belongs to the existing session worker subject; controllers/lease tokens never key it. */
export class WorkerExecutionService implements SessionExecutionPort {
  private readonly starting = new Set<string>();
  constructor(private readonly store: ExecutionStorePort, private readonly backends: Partial<Record<WorkerExecutor, WorkerExecutionPort>>, private readonly policy?: WorkerExecutionPolicy) {}

  async start(record: SessionRecord, launch: ProviderLaunchSpec, replayBytes: number): Promise<SessionRuntime> {
    if (this.starting.has(record.id)) throw new ExecutionError("EXECUTION_BUSY");
    this.starting.add(record.id);
    try { return await this.startExclusive(record, launch, replayBytes); }
    finally { this.starting.delete(record.id); }
  }
  private async startExclusive(record: SessionRecord, launch: ProviderLaunchSpec, replayBytes: number): Promise<SessionRuntime> {
    const request = resolveWorkerExecution(record, this.policy);
    const previous = this.store.get(record.id);
    if (previous !== undefined && (previous.request.executor !== request.executor || previous.request.profile !== request.profile)) {
      throw new ExecutionError("EXECUTION_BINDING_CONFLICT");
    }
    const backend = this.backends[request.executor];
    if (previous !== undefined && backend !== undefined) {
      const inspection = await backend.inspect(previous.ref);
      if (inspection.state === "running" || inspection.state === "unreachable") throw new ExecutionError("EXECUTION_NOT_QUIESCENT");
      if (previous.phase === "destroyed") throw new ExecutionError("EXECUTION_RETIRED");
    }
    let intent: ExecutionRecord = {
      schemaVersion: 1,
      ref: { brokerId: this.store.brokerId, executionId: previous?.ref.executionId ?? randomUUID(),
        workerId: record.id, sessionId: record.id, generation: record.generation ?? 1,
        executor: request.executor, workspaceId: previous?.ref.workspaceId ?? record.cwd,
        ...(previous?.ref.backendId === undefined ? {} : { backendId: previous.ref.backendId }),
      },
      request, phase: "preparing", updatedAt: new Date().toISOString(),
    };
    await this.store.put(intent); // Intent exists even if the backend cannot prepare.
    record.execution = intent.ref;
    let runtime: SessionRuntime | undefined;
    try {
      if (backend === undefined) throw new ExecutionError("EXECUTOR_UNAVAILABLE");
      const prepared = await backend.prepare({ record, request, identity: intent.ref, launch });
      if (prepared.ref.executionId !== intent.ref.executionId || prepared.ref.workerId !== record.id
        || prepared.ref.sessionId !== record.id || prepared.ref.brokerId !== this.store.brokerId
        || prepared.ref.generation !== intent.ref.generation || prepared.ref.executor !== request.executor) {
        throw new ExecutionError("EXECUTION_BINDING_CONFLICT");
      }
      intent = { ...intent, ref: prepared.ref, phase: "ready", updatedAt: new Date().toISOString() };
      await this.store.put(intent);
      record.execution = prepared.ref;
      runtime = await backend.start(prepared, replayBytes);
      await this.store.put({ ...intent, phase: "running", updatedAt: new Date().toISOString() });
      return runtime;
    } catch (error) {
      let cleanupFailed = false;
      if (runtime !== undefined) {
        try { await backend!.stop(intent.ref, true); } catch { cleanupFailed = true; }
      }
      await this.store.put({ ...intent, phase: "failed", failure: intent.phase === "preparing" ? "prepare" : "start",
        cleanupFailed, updatedAt: new Date().toISOString() }).catch(() => undefined);
      throw error;
    }
  }
}
