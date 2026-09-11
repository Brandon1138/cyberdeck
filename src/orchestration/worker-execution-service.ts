import { randomUUID } from "node:crypto";
import type { SessionRecord } from "../domain/session.js";
import type { SessionRuntime } from "../domain/session-runtime.js";
import { ExecutionError, resolveWorkerExecution, type ExecutionRecord, type WorkerExecutor, type WorkerExecutionPolicy } from "../domain/worker-execution.js";
import type { ExecutionStorePort, SessionExecutionPort, WorkerExecutionPort } from "./session/execution-ports.js";
import type { ProviderLaunchSpec } from "./session/provider-ports.js";

/** Execution belongs to the existing session worker subject; controllers/lease tokens never key it. */
export class WorkerExecutionService implements SessionExecutionPort {
  private readonly starting = new Set<string>();
  private closed = false;
  private readonly settlements = new Set<Promise<void>>();
  private readonly pendingStarts = new Map<string, AbortController>();
  constructor(private readonly store: ExecutionStorePort, private readonly backends: Partial<Record<WorkerExecutor, WorkerExecutionPort>>, private readonly policy?: WorkerExecutionPolicy, private readonly attemptTimeoutMs = 3600000) {}

  async start(record: SessionRecord, launch: ProviderLaunchSpec, replayBytes: number): Promise<SessionRuntime> {
    if (this.closed) throw new ExecutionError("EXECUTION_ADMISSION_CLOSED");
    if (this.starting.has(record.id)) throw new ExecutionError("EXECUTION_BUSY");
    this.starting.add(record.id);
    let settled!: () => void;
    const completion = new Promise<void>((resolve) => { settled = resolve; }); this.settlements.add(completion);
    const controller = new AbortController(); this.pendingStarts.set(record.id, controller);
    try { return await this.startExclusive(record, launch, replayBytes, controller.signal); }
    finally { this.starting.delete(record.id); this.pendingStarts.delete(record.id); this.settlements.delete(completion); settled(); }
  }
  cancelStart(sessionId: string): boolean {
    const controller = this.pendingStarts.get(sessionId);
    if (!controller) return false;
    controller.abort(new ExecutionError("EXECUTION_QUEUE_CANCELLED")); return true;
  }
  async closeAdmission(): Promise<void> {
    this.closed = true;
    for (const controller of this.pendingStarts.values()) controller.abort(new ExecutionError("EXECUTION_ADMISSION_CLOSED"));
    await Promise.all(this.settlements);
  }
  /** Called only after canonical lease renewal acknowledged authority; never by worker input. */
  async renewAttempt(sessionId: string, leaseExpiresAt: string): Promise<"renewed" | "not-running"> {
    if (this.starting.has(sessionId)) return "not-running";
    this.starting.add(sessionId);
    try {
      const current = this.store.get(sessionId);
      if (!current || current.phase !== "running" || current.ref.executor !== "orbstack-container") return "not-running";
      if (!Number.isFinite(Date.parse(leaseExpiresAt)) || Date.parse(leaseExpiresAt) <= Date.parse(current.renewedLeaseExpiresAt ?? "1970-01-01")) return "not-running";
      await this.store.put({ ...current, renewedLeaseExpiresAt: leaseExpiresAt, attemptDeadline: new Date(Date.now() + this.attemptTimeoutMs).toISOString(), updatedAt: new Date().toISOString() });
      return "renewed";
    } finally { this.starting.delete(sessionId); }
  }
  async expireAttempts(now = Date.now()): Promise<void> {
    for (const candidate of this.store.list()) {
      if (this.starting.has(candidate.ref.sessionId)) continue;
      if (candidate.ref.executor !== "orbstack-container" || !candidate.attemptDeadline || Date.parse(candidate.attemptDeadline) > now
        || !(candidate.phase === "running" || candidate.failure === "timeout" && candidate.cleanupFailed)) continue;
      const id = candidate.ref.sessionId; this.starting.add(id);
      try {
        const backend = this.backends[candidate.ref.executor];
        await this.store.put({ ...candidate, phase: "stopping", failure: "timeout", updatedAt: new Date().toISOString() });
        if (!backend) throw new ExecutionError("EXECUTOR_UNAVAILABLE");
        const stopped = await backend.stop(candidate.ref, false);
        if (stopped.state !== "stopped") throw new ExecutionError("EXECUTION_NOT_QUIESCENT");
        await this.store.put({ ...candidate, phase: "stopped", failure: "timeout", cleanupFailed: false, updatedAt: new Date().toISOString(),
          ...(stopped.guestExitCode === undefined || stopped.oomKilled === undefined ? {} : { guestOutcome: { exitCode: stopped.guestExitCode, oomKilled: stopped.oomKilled } }),
        });
      } catch {
        await this.store.put({ ...candidate, phase: "failed", failure: "timeout", cleanupFailed: true, updatedAt: new Date().toISOString() });
      } finally { this.starting.delete(id); }
    }
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
      if (stopped.state !== "stopped" && stopped.state !== "absent") throw new ExecutionError("EXECUTION_NOT_QUIESCENT");
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
      await this.store.put({ ...current, phase: "destroyed", cleanupFailed: false, updatedAt: new Date().toISOString() });
    } catch (error) {
      if (current) await this.store.put({ ...current, phase: "failed", failure: "recovery", cleanupFailed: true, updatedAt: new Date().toISOString() }).catch(() => undefined);
      throw error;
    } finally { this.starting.delete(sessionId); }
  }
  private async startExclusive(record: SessionRecord, launch: ProviderLaunchSpec, replayBytes: number, signal: AbortSignal): Promise<SessionRuntime> {
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
      signal.throwIfAborted();
      const prepared = await backend.prepare({ record, request, identity: intent.ref, launch, signal });
      signal.throwIfAborted();
      if (prepared.ref.executionId !== intent.ref.executionId || prepared.ref.workerId !== record.id
        || prepared.ref.sessionId !== record.id || prepared.ref.brokerId !== this.store.brokerId
        || prepared.ref.generation !== intent.ref.generation || prepared.ref.executor !== request.executor) {
        throw new ExecutionError("EXECUTION_BINDING_CONFLICT");
      }
      intent = { ...intent, ref: prepared.ref, phase: "ready", updatedAt: new Date().toISOString() };
      await this.store.put(intent);
      record.execution = prepared.ref;
      const runtime = await backend.start(prepared, replayBytes);
      signal.throwIfAborted();
      await this.store.put({ ...intent, phase: "running", updatedAt: new Date().toISOString(),
        ...(request.executor === "orbstack-container" ? { attemptDeadline: new Date(Date.now() + this.attemptTimeoutMs).toISOString() } : {}),
      });
      signal.throwIfAborted();
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
        cleanupEligibleAt: new Date(Date.now() + 24 * 3600000).toISOString(), cleanupFailed, updatedAt: new Date().toISOString() }).catch(() => undefined);
      throw error;
    }
  }
}
