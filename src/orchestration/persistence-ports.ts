import type { OrchestratorBinding } from "../domain/orchestrator.js";
import type { ProviderId } from "../domain/session.js";
import type { ThreadReadResult } from "../domain/thread.js";
import type { WorkflowMessage, WorkflowRun } from "../domain/workflow.js";
import type { ProviderPermissionPolicy } from "./permission-policy.js";

export interface OrchestratorBindingLookup {
  findBySessionId(sessionId: string): Promise<OrchestratorBinding | undefined>;
}

export interface OrchestratorBindingReader extends OrchestratorBindingLookup {
  get(key: string): Promise<OrchestratorBinding | undefined>;
}

export interface OrchestratorBindingRepository extends OrchestratorBindingReader {
  put(binding: OrchestratorBinding): Promise<void>;
  reset(key: string): Promise<void>;
}

export interface WorkerPreferenceReader {
  get(): Promise<{ caveman: boolean }>;
}

export interface WorkerPreferenceRepository extends WorkerPreferenceReader {
  set(preferences: { caveman: boolean }): Promise<{ caveman: boolean }>;
}

export interface ProviderPermissionPreferenceReader {
  list(): Promise<Partial<Record<ProviderId, ProviderPermissionPolicy>>>;
  set?(provider: ProviderId, policy: ProviderPermissionPolicy): Promise<void>;
}

export interface ThreadTranscriptReader {
  read(sessionId: string, afterCursor?: number, limit?: number): Promise<ThreadReadResult>;
}

export interface WorkflowRepository {
  putRun(run: WorkflowRun): Promise<void>;
  listRuns(): Promise<WorkflowRun[]>;
  getRun(runId: string): Promise<WorkflowRun | undefined>;
  putMessage(message: WorkflowMessage): Promise<void>;
  listMessages(runId: string): Promise<WorkflowMessage[]>;
}
