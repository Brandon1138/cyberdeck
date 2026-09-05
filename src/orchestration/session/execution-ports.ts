import type { SessionRuntime } from "../../domain/session-runtime.js";
import type { SessionRecord } from "../../domain/session.js";
import type { ExecutionIdentity, ExecutionInspection, ExecutionRecord, ExecutionRef, WorkerExecutionRequest } from "../../domain/worker-execution.js";
import type { ProviderLaunchSpec } from "./provider-ports.js";

export interface PreparedExecution { ref: ExecutionRef; launch: ProviderLaunchSpec }
export interface ExecutionLaunchInput {
  record: SessionRecord; request: WorkerExecutionRequest;
  identity: ExecutionIdentity; launch: ProviderLaunchSpec;
}
export interface CollectedExecution { manifestRef: string; complete: boolean }
export interface WorkerExecutionPort {
  prepare(input: ExecutionLaunchInput): Promise<PreparedExecution>;
  start(prepared: PreparedExecution, replayBytes: number): Promise<SessionRuntime>;
  inspect(ref: ExecutionRef): Promise<ExecutionInspection>;
  stop(ref: ExecutionRef, force: boolean): Promise<ExecutionInspection>;
  collect(ref: ExecutionRef): Promise<CollectedExecution>;
  destroy(ref: ExecutionRef): Promise<void>;
}
export interface ExecutionStorePort {
  brokerId: string;
  get(sessionId: string): ExecutionRecord | undefined;
  put(record: ExecutionRecord): Promise<void>;
  list(): ExecutionRecord[];
}
export interface SessionExecutionPort {
  start(record: SessionRecord, launch: ProviderLaunchSpec, replayBytes: number): Promise<SessionRuntime>;
  retire?(sessionId: string): Promise<void>;
}
