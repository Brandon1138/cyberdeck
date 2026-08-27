import type { FleetFolderDisposition, FleetLaunchProfile } from "../../domain/fleet-preferences.js";
import type { OrchestratorBinding } from "../../domain/orchestrator.js";
import type { ScoutEgressGrant, ScoutEgressStatus } from "../../domain/scout-egress.js";
import type { ThreadReadResult } from "../../domain/thread.js";
import type { WorkerPreferences } from "../../domain/worker-preferences.js";

/**
 * What the RPC surface needs from the broker's durable stores, and nothing more.
 *
 * Each port lists exactly the methods some handler calls. The concrete stores composed in
 * `main.ts` satisfy them structurally, so nothing there changes — but the server can no longer
 * reach past a read into the append path that produced it, and a store can grow a method without
 * widening what a client can ask for.
 */

export interface ThreadTranscriptReadPort {
  read(sessionId: string, afterCursor?: number, limit?: number): Promise<ThreadReadResult>;
  changes(afterCursor?: number, limit?: number): Promise<ThreadReadResult>;
}

export interface FleetPreferenceReadPort {
  list(): Promise<Record<string, FleetLaunchProfile>>;
  listFolderDispositions(): Promise<Record<string, FleetFolderDisposition>>;
  nvimLayoutEnabled(): Promise<boolean>;
  set(cwd: string, profile: FleetLaunchProfile): Promise<void>;
  setFolderDisposition(key: string, disposition: FleetFolderDisposition): Promise<void>;
  setNvimLayout(enabled: boolean): Promise<void>;
}

/**
 * The detach ledger as reattachment uses it: record one, find the latest, retire a stale one.
 *
 * `clear` names the session it retires so a newer detach that won the append race survives it.
 */
export interface FleetDetachRecordPort {
  record(identity: string, sessionId: string): Promise<void>;
  latestSessionId(identity: string): Promise<string | undefined>;
  clear(identity: string, sessionId: string): Promise<void>;
}

export interface WorkerPreferenceReadPort {
  get(): Promise<WorkerPreferences>;
}

export interface ScoutEgressPort {
  set(root: string, enabled: boolean): Promise<ScoutEgressGrant | undefined>;
  status(root: string): Promise<ScoutEgressStatus>;
}

/** Fleet's ownership view reads every binding; nothing on this surface writes one. */
export interface OrchestratorBindingListPort {
  list(): Promise<OrchestratorBinding[]>;
}
