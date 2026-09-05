import type { CreateOrchestratorRequest } from "../../domain/orchestrator.js";
import type { ProviderId, ReasoningEffort, SessionRecord } from "../../domain/session.js";
import type { OrchestratorCatalogEntry } from "../../orchestration/orchestrator-catalog.js";
import { type ResolvedWorkerCapability } from "../../orchestration/worker-capabilities.js";
import { type PasteboardImageAttachment } from "../clipboard-image.js";
import { type PullRequestStatusPort, type PullRequestSummary } from "../pr-status.js";
import { type TerminalBackground } from "../terminal-background.js";

interface ShellCommandResult {
  exitStatus: number;
  cwd?: string | undefined;
}

export interface ProviderPermissionPreferences {
  [provider: string]: import("../permission-policy.js").ProviderPermissionPolicy | undefined;
}

export interface ProviderPermissionPreferencePort {
  list(): Promise<ProviderPermissionPreferences>;
  set(provider: import("../../domain/session.js").ProviderId, policy: import("../permission-policy.js").ProviderPermissionPolicy): Promise<void>;
}

export interface ResolvedFleetRenderOptions {
  color: boolean;
  width: number;
  height: number;
  now: number;
  home: string;
  pullRequests: ReadonlyMap<string, PullRequestSummary>;
  background: TerminalBackground | undefined;
}

export interface WorkerModelChoice {
  provider: ProviderId;
  model: string;
  label: string;
  efforts: readonly (ReasoningEffort | "provider-managed")[];
  /** Whether the provider itself listed this model, or the stored catalog stood in for it. */
  source: ResolvedWorkerCapability["source"];
}

/**
 * What Fleet may offer to launch, and which providers it could not ask.
 *
 * The choices come from the same `worker.capabilities` answer the launch boundary validates
 * against, so the composer cannot offer a model the broker would then refuse. A provider that could
 * not be queried keeps its stored models and appears in `fallbacks`, because a list nobody could
 * verify has to say so on screen rather than pass for the present tense.
 */
export interface WorkerModelCatalog {
  choices: readonly WorkerModelChoice[];
  orchestratorChoices: readonly OrchestratorModelChoice[];
  fallbacks: readonly { provider: ProviderId; reason: string; }[];
}

export interface OrchestratorModelChoice {
  provider: OrchestratorCatalogEntry;
  model: string;
  label: string;
}

export type SlashCommandName =
  | "/model"
  | "/permissions"
  | "/fable-workers"
  | "/caveman-workers"
  | "/nvim-settings"
  | "/worktree"
  | "/handoff";

export interface SlashCommandDefinition {
  name: SlashCommandName;
  description: string;
  values?: readonly SlashCommandValue[] | undefined;
}

export interface SlashCommandValue {
  value: string;
  description: string;
}

export interface FleetRuntimeOptions {
  changeDirectory?: ((cwd: string) => Promise<string | undefined>) | undefined;
  /** Runs one `!` line. Output arrives through `onOutput` as the shell writes it. */
  runShellCommand?: ((request: {
    command: string;
    cwd: string;
    onOutput: (chunk: string) => void;
    /** Aborted when the operator leaves the shell while the line is still running. */
    signal?: AbortSignal | undefined;
  }) => Promise<ShellCommandResult>) | undefined;
  detachIdentity?: string | undefined;
  openOrchestrator?: ((target: OrchestratorCockpitTarget) => Promise<SessionRecord>) | undefined;
  /** Opens a worker's worktree in the nvim already running in Fleet's tmux window. */
  openWorktree?: ((
    session: SessionRecord,
    layout: { enabled: boolean; orchestratorSessionIds: readonly string[]; },
  ) => Promise<string>) | undefined;
  /**
   * Opens a project's primary checkout in that same nvim. No worker owns the checkout, but one can
   * be running in it, so the threads this client is holding travel with the request: an occupied
   * checkout has to land locked even when that worker's own row was never opened.
   */
  openCheckout?: ((
    cwd: string,
    layout: { enabled: boolean; orchestratorSessionIds: readonly string[]; },
    sessions: readonly SessionRecord[],
  ) => Promise<string>) | undefined;
  nvimLayoutHooks?: {
    install(orchestratorSessionIds: readonly string[]): void | Promise<void>;
    rebalance(orchestratorSessionIds: readonly string[]): unknown | Promise<unknown>;
    remove(): void | Promise<void>;
  } | undefined;
  pasteboardImage?: PasteboardImageAttachment | undefined;
  permissionPreferences?: ProviderPermissionPreferencePort | undefined;
  pullRequestStatus?: PullRequestStatusPort | undefined;
}

export type OrchestratorCockpitTarget =
  | {
    type: "existing";
    session: SessionRecord;
    cockpitCwd: string;
    requiresResume: boolean;
  }
  | {
    type: "create";
    request: CreateOrchestratorRequest;
    cockpitCwd: string;
  };
