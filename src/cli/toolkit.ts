import type { SessionRecord } from "../domain/session.js";

export type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: { stdio?: "ignore" | "inherit"; encoding?: "utf8"; },
) => { status: number | null; stdout?: string; };

export interface CockpitPreflight {
  tmuxVersion: string;
  presentationCommand: "attach-session" | "switch-client";
  hostPaneId?: string;
}

export interface CockpitOptions {
  cliPath: string;
  cwd: string;
  orchestratorSessionId: string;
  nodePath?: string;
  spawnSync?: SpawnSyncLike;
  preflight?: CockpitPreflight;
}

export interface FleetNvimLayoutHooks {
  install(orchestratorSessionIds: readonly string[]): void;
  rebalance(orchestratorSessionIds: readonly string[]): unknown;
  remove(): void;
}

export interface NvimOpenResult {
  paneId: string;
  address: string;
  entries: number;
  live: boolean;
  baseline: { label: string; };
}

export interface WorktreeOpenResult extends NvimOpenResult {
  sessionId: string;
}

export type ClaudeTranscriptRebindOutcome =
  | { recorded: true; binding: unknown; }
  | { recorded: false; reason: "unreadable-payload"; };

export interface ScoutEgressStatus {
  root: string;
  enabled: boolean;
}

export interface CliToolkit {
  runBroker(): Promise<unknown>;
  preflightCockpit(): CockpitPreflight;
  launchCockpit(options: CockpitOptions): void;
  detachCockpit(options: { returnMode?: "detach" | "switch"; }): void;
  selectSession(records: readonly SessionRecord[], query: string): SessionRecord;
  worktreeSubject(record: Pick<SessionRecord, "id" | "name">): string;
  openWorktreeInNvim(options: {
    session: SessionRecord;
    hostPaneId: string;
    layout: { enabled: boolean; orchestratorSessionIds: readonly string[]; };
  }): Promise<WorktreeOpenResult>;
  openCheckoutInNvim(options: {
    checkout: string;
    hostPaneId: string;
    layout: { enabled: boolean; orchestratorSessionIds: readonly string[]; };
    sessions: readonly SessionRecord[];
  }): Promise<NvimOpenResult>;
  createFleetNvimLayoutHooks(options: {
    spawnSync: SpawnSyncLike;
    preflight: () => CockpitPreflight;
    nodePath: string;
    cliPath: string;
    hookPath?: string;
  }): FleetNvimLayoutHooks;
  rebalanceNvimLayoutFromHook(options: {
    spawnSync: SpawnSyncLike;
    windowId: string;
    cliPath: string;
  }): unknown;
  openInteractiveShell(cwd: string): Promise<string | undefined>;
  pruneLegacyTranscript(
    stateDirectory: string,
    remove: boolean,
  ): Promise<{ path: string; removed: boolean; }>;
  rebindClaudeTranscript(request: {
    sessionId: string;
    stateDirectory: string;
    payload: string;
  }): Promise<ClaudeTranscriptRebindOutcome>;
}
