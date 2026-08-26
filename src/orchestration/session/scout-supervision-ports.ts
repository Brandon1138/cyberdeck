import type { BrokerEventType } from "../../domain/events.js";
import type { ScoutDecisionCard } from "../../domain/scout-output.js";
import type {
  ScoutArtifactKind,
  ScoutReport,
  ScoutRuntimeState,
} from "../../domain/worker-profile.js";
import type { ScoutArtifactRead } from "./session-ports.js";
import type { ScoutWorkspaceVerdict } from "./session-workspace-ports.js";

/**
 * What one reading of a Scout's drop box found.
 *
 * Declared here rather than imported from the store that produces it: the supervisor is an
 * application component, and a store is one implementation of the port below. The persistence
 * module re-exports this name, so the durable format and the port cannot drift apart silently.
 */
export type ScoutReportCapture =
  | { state: "missing" }
  | { state: "partial"; text: string }
  | { state: "invalid"; text: string; reason: string }
  | {
      state: "complete";
      text: string;
      card: ScoutDecisionCard;
      evidenceText?: string;
    }
  | { state: "complete"; text: string; report: ScoutReport };

/**
 * The broker-owned drop box a Scout writes its one framed report into, as the supervisor needs it.
 *
 * Every method is a function of a `ScoutRuntimeState` — the durable paths the record already
 * carries — so nothing here names a directory, a file, or a filesystem.
 */
export interface ScoutReportPort {
  initialize(sessionId: string, cwd: string): Promise<ScoutRuntimeState>;
  capture(runtime: ScoutRuntimeState, replay: string): Promise<ScoutReportCapture>;
  collect(runtime: ScoutRuntimeState): Promise<ScoutReportCapture>;
  appendTrace(runtime: ScoutRuntimeState, chunk: Buffer): Promise<void>;
  readArtifact(
    runtime: ScoutRuntimeState,
    artifact: ScoutArtifactKind,
    afterByte?: number,
    maxBytes?: number,
  ): Promise<ScoutArtifactRead>;
  remove(sessionId: string): Promise<void>;
}

/**
 * The canary half of the workspace coordinator, named as the one question the supervisor asks it:
 * did this Scout leave the repository as it found it. `SessionWorkspaceCoordinator` satisfies it.
 */
export interface ScoutWorkspaceVerificationPort {
  verifyScoutWorkspace(
    baseline: string | undefined,
    cwd: string,
  ): Promise<ScoutWorkspaceVerdict>;
}

/**
 * Everything the supervisor may cause outside its own state, expressed without naming a process
 * handle, an attachment, or a store. The registry binds these to one runtime session.
 */
export interface ScoutSupervisionEffects {
  persist(): Promise<void>;
  appendEvent(type: BrokerEventType, data: Record<string, unknown>): Promise<void>;
  /**
   * Record a Scout lifecycle entry in the thread transcript.
   *
   * Kind and source are not parameters because a supervisor writes exactly one kind of entry: a
   * broker-authored lifecycle note about the probe it is supervising.
   */
  appendTranscript(text: string, data: Record<string, unknown>): Promise<void>;
  notifySessionUpdate(): void;
  /** Publish the text a wait would hand back for this Scout. */
  setLatestResult(text: string): void;
  /** Publish that text only when nothing has claimed the slot yet. */
  setLatestResultIfAbsent(text: string): void;
  /** Bank the Scout's single semantic turn against its completion target. */
  recordCompletion(turns: number, text: string): void;
  /** Signal the provider process, if this session still owns one. */
  kill(signal?: string): void;
  /** Whether an operator stop is already in flight for this session. */
  stopRequested(): boolean;
}

/**
 * What a finished Scout's supervision decided, and the registry's authority to publish the exit.
 *
 * The registry owns the canonical lifecycle exit either way; this only says whether *this* call is
 * the one that reached the end of supervision. A provider that reports its close on more than one
 * path would otherwise publish two exits for one process.
 */
export type ScoutFinalizationOutcome =
  /** Scout truth is settled. The registry may now publish the canonical lifecycle exit. */
  | { status: "settled" }
  /** Another finalization already owns this exit; this caller must publish nothing. */
  | { status: "duplicate" };
