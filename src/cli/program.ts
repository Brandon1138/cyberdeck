import type { FleetProjectAddResult, FleetProjectRemoveResult } from "../broker/fleet-project-service.js";
import type { WorkerEventSubmitParams } from "../broker/worker-event-channel.js";
import type { FleetRuntimeDeps } from "../client/fleet/deps.js";
import type { CavemanWorkersRequest, CavemanWorkersResult, EnsureOrchestratorRequest, FableWorkersRequest, FableWorkersResult, ResetOrchestratorRequest } from "../domain/orchestrator.js";
import type { EventAck } from "../domain/worker-coordination.js";
import type { OrchestratorManagerResult, OrchestratorResetResult } from "../orchestration/orchestrator-manager.js";
import type {
  ClaudeTranscriptRebindOutcome,
  CliToolkit,
  CockpitOptions,
  CockpitPreflight,
  ScoutEgressStatus,
} from "./toolkit.js";

export interface CreateProgramOptions {
  runDefault?: () => Promise<void>;
  restartBroker?: () => Promise<void>;
  preflightCockpit?: () => CockpitPreflight;
  launchCockpit?: (options: CockpitOptions) => void;
  ensureOrchestrator?: (request: EnsureOrchestratorRequest) => Promise<OrchestratorManagerResult>;
  stopSession?: (sessionId: string) => Promise<void>;
  resetOrchestrator?: (request: ResetOrchestratorRequest) => Promise<OrchestratorResetResult>;
  fableWorkers?: (request: FableWorkersRequest) => Promise<FableWorkersResult>;
  cavemanWorkers?: (request: CavemanWorkersRequest) => Promise<CavemanWorkersResult>;
  pruneLegacyTranscript?: () => Promise<{ path: string; removed: boolean }>;
  /** Reads the SessionStart payload itself, so the command has no stdin of its own to stub. */
  rebindClaudeTranscript?: (
    request: { sessionId: string; stateDirectory: string },
  ) => Promise<ClaudeTranscriptRebindOutcome>;
  submitWorkerEvent?: (request: WorkerEventSubmitParams) => Promise<EventAck>;
  scoutEgress?: (request: { root: string; enabled?: boolean }) => Promise<ScoutEgressStatus>;
  rebalanceNvimLayout?: (windowId: string) => void | Promise<void>;
  listProjects?: () => Promise<string[]>;
  addProject?: (request: { path: string; acceptParent?: boolean }) => Promise<FleetProjectAddResult>;
  removeProject?: (request: { path: string }) => Promise<FleetProjectRemoveResult>;
}

export type CliProgramContext = Omit<
  Required<CreateProgramOptions>,
  "preflightCockpit" | "launchCockpit"
> & {
  runCockpitPreflight: NonNullable<CreateProgramOptions["preflightCockpit"]>;
  presentCockpit: NonNullable<CreateProgramOptions["launchCockpit"]>;
  toolkit: CliToolkit;
  fleetRuntimeDeps: FleetRuntimeDeps;
};
