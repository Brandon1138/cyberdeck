import type { BrokerRuntimeConfig } from "../../config.js";
import type { BrokerEvent } from "../../domain/events.js";
import type { StartPolicyCode } from "../../domain/policy.js";
import type { SessionRuntime, SessionRuntimeFactory } from "../../domain/session-runtime.js";
import type { SessionRecord } from "../../domain/session.js";
import type { WorktreeProvisioner } from "../../domain/worker-workspace.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "./provider-ports.js";
import type { ScoutSessionSupervisor } from "./scout-session-supervisor.js";
import type { ScoutReportPort } from "./scout-supervision-ports.js";
import type { WorkspaceStateReader } from "./session-workspace-ports.js";
import type { WorkerTurnEngine } from "./worker-turn-engine.js";
import type {
  AppendWorkerTurnTranscriptEvent,
  CaptureWorkerTurns,
  WorkerTurnObservation,
  WorkerTurnObservationPort,
  WorkerTurnPreviewPort,
  WorkerTurnTranscript,
  WorkerTurnTranscriptMessage,
} from "./worker-turn-ports.js";

/**
 * Every contract `SessionRegistry` is composed from: the durable collaborators it is handed, the
 * runtime state it keeps per session, and the one error type its callers catch. The registry itself
 * re-exports the public half of this module, so this is where a contract is *declared* and
 * `session-registry.ts` remains where it is offered.
 */
export type AttachmentMode = "control" | "watch";
export type OutputSink = (chunk: Buffer) => void;
export type ExitSink = (exitCode: number) => void;
export type FailureSink = (failure: { code: string; message: string }) => void;

/** Broker-owned gate installed by worker-budget enforcement after composition. */
export interface WorkerBudgetGate {
  assertMayConsume(sessionId: string): void;
}

/** Generation-local inputs for durable, explicitly approximate worker-budget accounting. */
export interface WorkerBudgetObservation {
  generation: number;
  canonicalTurns: number;
  tokenCount?: number;
}

export interface JournalLike {
  append(event: BrokerEvent): Promise<void>;
}

export interface SessionStoreLike {
  put(record: SessionRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface TranscriptLike {
  append(event: AppendWorkerTurnTranscriptEvent): Promise<unknown>;
  dropClaudeBinding?(sessionId: string): Promise<void>;
  observeProviderTurns?(input: CaptureWorkerTurns): Promise<WorkerTurnObservation>;
  commitProviderTurns?(observation: WorkerTurnObservation): Promise<WorkerTurnTranscript[]>;
  /** Compatibility only; WorkerTurnEngine requires the explicit observation/commit pair. */
  captureProviderTurns?(input: CaptureWorkerTurns): Promise<WorkerTurnTranscript[]>;
  readTranscriptMessages?(input: CaptureWorkerTurns): Promise<WorkerTurnTranscriptMessage[]>;
  readObservedModel?(input: CaptureWorkerTurns): Promise<SessionRecord["observedModel"] | undefined>;
}

export interface Controller {
  clientId: string;
  output: OutputSink;
  ended: ExitSink;
  failed: FailureSink;
}

export interface Watcher {
  output: OutputSink;
  ended: ExitSink;
  failed: FailureSink;
}

export interface RuntimeSession {
  record: SessionRecord;
  sessionRuntime?: SessionRuntime;
  turns: WorkerTurnEngine;
  controller?: Controller;
  watchers: Map<string, Watcher>;
  stopRequested: boolean;
  stopRequestedAt?: string;
  /** The stop that killed this session was a broker shutdown of an already-finished thread. */
  outcomePreserved?: boolean;
  /** Serializes provider launch-artifact work so a pending cleanup cannot delete a fresh resume. */
  launchTail: Promise<void>;
  /**
   * Everything that is true of a Scout and of nothing else: trace and capture tails, the wall-clock
   * cutoff, card promotion, canary verification, and finalization. Present only on a Scout — an
   * ordinary session instantiates no supervisor and therefore carries no Scout runtime state.
   */
  scout?: ScoutSessionSupervisor;
  /** The exact exiting runtime is settling its last durable turn before terminal publication. */
  terminalFinalizing?: boolean;
  /** Serializes resume ownership before the first asynchronous turn-settlement boundary. */
  resuming?: boolean;
}

/**
 * How long an output-driven session update may sit before it is announced.
 *
 * One frame at 60 Hz. Below the threshold where an operator can see a Fleet row lag, and far above
 * the rate a streaming provider redraws its screen at — which is the point: the announcement is
 * bounded by the clock instead of by how fast a model is emitting tokens.
 */
export const SESSION_UPDATE_FLUSH_MS = 16;
export const PREVIEW_STORAGE_LIMIT = 600;

export interface SessionTreeProgress {
  rootSessionId: string;
  rootKind: "worker" | "orchestrator";
  childCount: number;
  total: number;
  active: number;
  stopping: number;
  terminal: number;
}

export type ReattachTarget =
  | { status: "ready"; record: SessionRecord; requiresResume: boolean }
  | { status: "unavailable"; record: SessionRecord }
  | { status: "stale" };

export interface SessionRegistryOptions {
  adapters: Record<string, ProviderAdapter>;
  sessionRuntimeFactory: SessionRuntimeFactory<ProviderLaunchSpec>;
  journal: JournalLike;
  transcripts?: TranscriptLike;
  workerTurnObservation: WorkerTurnObservationPort & WorkerTurnPreviewPort;
  store?: SessionStoreLike;
  recoveredSessions?: readonly SessionRecord[];
  validateCwd?: ((cwd: string) => Promise<void>) | undefined;
  config: BrokerRuntimeConfig;
  /** Injected monotonic-enough wall clock for stalled-worker tests. */
  now?: () => number;
  scoutReports?: ScoutReportPort;
  scoutWorkspaceState?: WorkspaceStateReader;
  /**
   * Creates the worktree for a `cyberdeck-provisioned` workspace. Absent means the broker cannot
   * provision, and a start that asks it to is refused rather than quietly downgraded to running in
   * whatever checkout the caller happened to name — silently sharing the operator's working copy is
   * the failure the mode exists to prevent.
   */
  worktreeProvisioner?: WorktreeProvisioner;
}

export class RegistryError extends Error {
  constructor(
    readonly code:
      | StartPolicyCode
      | "PROVIDER_NOT_REGISTERED"
      | "SESSION_NOT_FOUND"
      | "SESSION_ALREADY_CONTROLLED"
      | "SESSION_NOT_ACTIVE"
      | "SESSION_ALREADY_ACTIVE"
      | "NOT_SESSION_CONTROLLER"
      | "SESSION_BUSY"
      | "SESSION_STILL_ACTIVE"
      | "PARENT_SESSION_NOT_ACTIVE"
      | "INVALID_SESSION_CWD"
      | "INVALID_WORKER_PROFILE"
      | "PROVIDER_NO_IMAGE_INPUT"
      | "SCOUT_REPORT_STORE_UNAVAILABLE"
      | "SCOUT_LAUNCH_FAILED"
      | "WORKSPACE_PROVISIONER_UNAVAILABLE"
      | "WORKSPACE_PROVISION_FAILED",
    message: string,
    readonly sessionId?: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}
