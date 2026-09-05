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
  async retire(sessionId: string): Promise<void> {
    if (this.starting.has(sessionId)) throw new ExecutionError("EXECUTION_BUSY");
    this.starting.add(sessionId);
    let current = this.store.get(sessionId);
    try {
      if (!current || current.ref.executor === "host" || current.phase === "destroyed") return;
      const backend = this.backends[current.ref.executor];
      if (!backend) throw new ExecutionError("EXECUTOR_UNAVAILABLE");
      current = { ...current, phase: "stopping", updatedAt: new Date().toISOString() };
      await this.store.put(current);
      const stopped = await backend.stop(current.ref, false);
      if (stopped.state !== "stopped" && !(stopped.state === "absent" && current.manifestRef)) throw new ExecutionError("EXECUTION_NOT_QUIESCENT");
      if (!current.manifestRef) {
        current = { ...current, phase: "collecting", updatedAt: new Date().toISOString() }; await this.store.put(current);
        const collection = await backend.collect(current.ref);
        if (!collection.complete) throw new ExecutionError("EXECUTION_COLLECTION_INCOMPLETE");
        current = { ...current, manifestRef: collection.manifestRef };
      }
      current = { ...current, phase: "retained", updatedAt: new Date().toISOString() }; await this.store.put(current);
      // The backend re-verifies the saved manifest and refuses live/foreign resources.
      // A crash after removal retries this same identity and verified collection.
      await backend.destroy(current.ref);
      await this.store.put({ ...current, phase: "destroyed", updatedAt: new Date().toISOString() });
    } catch (error) {
      if (current) await this.store.put({ ...current, phase: "failed", failure: "recovery", cleanupFailed: true, updatedAt: new Date().toISOString() }).catch(() => undefined);
      throw error;
    } finally { this.starting.delete(sessionId); }
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
      const runtime = await backend.start(prepared, replayBytes);
      await this.store.put({ ...intent, phase: "running", updatedAt: new Date().toISOString() });
      runtime.onExit(() => {
        void (async () => {
          const inspection = await backend.inspect(intent.ref);
          // A previous generation's delayed observer must never overwrite a resumed binding.
          const current = this.store.get(record.id);
          if (current?.ref.generation !== intent.ref.generation || current.phase !== "running" || inspection.state !== "stopped") return;
          await this.store.put({ ...current, phase: "stopped", updatedAt: new Date().toISOString(),
            ...(inspection.guestExitCode === undefined || inspection.oomKilled === undefined ? {} : {
              guestOutcome: { exitCode: inspection.guestExitCode, oomKilled: inspection.oomKilled },
            }),
          });
        })().catch(() => undefined);
      });
      return runtime;
    } catch (error) {
      let cleanupFailed = false;
      if (backend !== undefined) {
        // Preparation may already own a slot/container even when start or its journal write
        // never returns. Stop by the durable identity, including partial create failures.
        try {
          const stopped = await backend.stop(intent.ref, true);
          cleanupFailed = stopped.state !== "stopped" && stopped.state !== "absent";
        } catch { cleanupFailed = true; }
      }
      await this.store.put({ ...intent, phase: "failed", failure: intent.phase === "preparing" ? "prepare" : "start",
        cleanupFailed, updatedAt: new Date().toISOString() }).catch(() => undefined);
      throw error;
    }
  }
}
