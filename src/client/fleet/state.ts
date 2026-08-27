import type { FleetWorkerCoordinationView } from "../../broker/worker-coordination-view.js";
import type { CavemanWorkersRequest, CreateOrchestratorRequest, FableWorkersRequest } from "../../domain/orchestrator.js";
import type { ProviderId, ReasoningEffort, SessionRecord, StartSessionRequest } from "../../domain/session.js";
import { type AttachTransport } from "../attach.js";
import { type ConfigurablePermissionProvider, type ProviderPermissionPolicy, type ProviderPermissionResolution } from "../permission-policy.js";
import { type PullRequestSummary } from "../pr-status.js";
import { type TerminalBackground } from "../terminal-background.js";
import { FOLDER_THREAD_CAP } from "./constants.js";
import { ProviderPermissionPreferences, SlashCommandName, WorkerModelCatalog } from "./runtime-options.js";

export interface FleetTransport {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

export interface InteractiveFleetTransport extends FleetTransport, AttachTransport { }

export interface FleetInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(raw: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface FleetOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string | Uint8Array): unknown;
}

export interface FleetSignals {
  on(event: "SIGINT" | "SIGTERM" | "SIGWINCH", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM" | "SIGWINCH", listener: () => void): unknown;
}

export interface FleetThread {
  record: SessionRecord;
  coordination?: FleetWorkerCoordinationView;
  /**
   * The durable controller family this orchestrator row speaks for, from its binding. Absent on
   * worker rows, which name their owner through `coordination.currentController` instead — the
   * lease, not the roster, is what says who owns a worker.
   */
  controllerId?: string;
}

export interface FleetSnapshot {
  threads: FleetThread[];
  /**
   * The operator's registered project roots, or `undefined` when this Fleet has no registry to
   * group by — an older broker, or a presentation test. The two are deliberately distinct: an
   * empty registry means every thread is unregistered, while no registry at all means the list
   * falls back to one folder per working directory.
   */
  projects?: readonly string[] | undefined;
}

export interface DeleteConfirmation {
  sessionId: string;
  expiresAt: number;
}

export interface QuitConfirmation {
  expiresAt: number;
}

export interface StopAcknowledgement {
  sessionId: string;
}

/**
 * Which row of the target step holds focus, by durable identity rather than by row number.
 *
 * The ctrl+x ladder needs three presses against one orchestrator, and the snapshot is refreshed
 * between them: stopping a row rewrites its state and its `updatedAt`, so the list it sits in is
 * re-labelled and re-ordered under the operator's hand. A row number would silently follow
 * whatever slid into the slot; a session id cannot.
 */
export type OrchestratorPickerFocus =
  | { kind: "existing"; sessionId: string; }
  | { kind: "profile"; modelIndex: number; };

export type OrchestratorPickerState =
  | {
    step: "target";
    focus: OrchestratorPickerFocus;
    /** Mirrors the fleet list's ctrl+x ladder, scoped to the picker's own selection. */
    stopAcknowledgement?: StopAcknowledgement | undefined;
    deleteConfirmation?: DeleteConfirmation | undefined;
  }
  | { step: "effort"; modelIndex: number; effortIndex: number; };

/**
 * The directed handoff, in the two answers it needs: which orchestrator receives the marked
 * workers, and what it is told to do with them.
 *
 * The batch is held here rather than re-read from the marks at the moment of dispatch, so a worker
 * finishing or a snapshot arriving while the operator is typing cannot quietly change what they
 * are about to hand over. Both the recipient and the members are ids for the same reason the
 * orchestrator picker's focus is: the list underneath re-sorts.
 */
export type HandoffPickerState =
  | { step: "recipient"; workerIds: readonly string[]; focusSessionId?: string | undefined; }
  | {
    step: "directive";
    workerIds: readonly string[];
    recipientSessionId: string;
    draft: string;
    mutationId: string;
  };

export interface LaunchProfile {
  provider: ProviderId;
  model: string;
  effort?: ReasoningEffort;
  /**
   * Whether a worker started from this folder gets its own worktree. Absent means `shared`, which
   * is what every profile written before the choice existed meant: run in the checkout named.
   */
  isolation?: WorkerIsolation;
}

/**
 * `worktree` asks Cyberdeck to cut a fresh worktree for each worker started here; `shared` runs the
 * worker in the folder itself, which is the right answer for a checkout the operator has already
 * put on the branch they want.
 */
export type WorkerIsolation = "shared" | "worktree";

/** How one folder key sits in the list: folded away, and whether its thread cap is lifted. */
export interface FolderDisposition {
  collapsed: boolean;
  expanded: boolean;
}

export interface WorkerPickerState {
  step: "model" | "effort";
  modelIndex: number;
  effortIndex: number;
  cwd: string;
  returnDraft: string;
  /** Typed substring narrowing the model list. A provider listing runs to hundreds of slugs. */
  filter: string;
}

export interface CommandPaletteState {
  level: "commands" | "values";
  command?: SlashCommandName | undefined;
  selectedIndex: number;
  scrollOffset: number;
}

export interface PermissionPickerState {
  step: "provider" | "policy";
  providerIndex: number;
  policyIndex: number;
}

export interface RenameState {
  sessionId: string;
  draft: string;
}

export interface ProjectPromptState {
  draft: string;
  /**
   * A repository the broker offered after the draft resolved to one of its worktrees. While this is
   * set, Enter registers the repository rather than re-sending the path the operator typed.
   */
  parentOffer?: { root: string; toplevel: string; } | undefined;
}

/**
 * The composer running the operator's own shell rather than dispatching work.
 *
 * Lines run through `$SHELL -lc` in Fleet's spawn cwd, with the operator's full privileges and no
 * allowlist between them and it — that is the point of the mode, not an oversight. `cd` persists
 * because each line reports where the shell ended up and Fleet adopts it.
 */
export interface ShellModeState {
  draft: string;
  /**
   * Rendered output, oldest first. The last element is the line the shell has not finished writing
   * yet, so a chunk that arrives mid-line extends it rather than starting a new row.
   */
  transcript: readonly string[];
  /** Set while a line is in flight. Nothing may be typed into a shell that is still answering. */
  running?: boolean | undefined;
}

export type FleetNoticeTone = "neutral" | "warning" | "error" | "confirmation";

export interface FleetState {
  selectedSessionId?: string | undefined;
  /** First rendered row in the independently scrolling thread-list body. */
  threadListScrollOffset: number;
  /**
   * Set while a folder header row holds focus. Thread-scoped keys are inert in
   * that case; `selectedSessionId` is retained so focus returns to the thread
   * the operator left when they move off the header.
   */
  focusedFolderCwd?: string | undefined;
  /**
   * Set while a folder's show-more row holds focus. Inert for thread keys exactly as a
   * focused folder header is, and cleared the moment the row itself stops existing.
   */
  focusedShowMoreCwd?: string | undefined;
  /** Folders whose threads are hidden. Membership survives snapshot churn. */
  collapsedCwds?: readonly string[] | undefined;
  /** Folders showing every worker rather than the first {@link FOLDER_THREAD_CAP}. */
  expandedCwds?: readonly string[] | undefined;
  fallbackCwd: string;
  workingDirectory?: string | undefined;
  draft: string;
  stopAcknowledgement?: StopAcknowledgement | undefined;
  deleteConfirmation?: DeleteConfirmation | undefined;
  quitConfirmation?: QuitConfirmation | undefined;
  orchestratorPicker?: OrchestratorPickerState | undefined;
  /**
   * Workers marked for a directed handoff, by session id. Membership survives snapshot churn and
   * is dropped only when the session itself does, so a mark never names a worker the broker would
   * have to refuse.
   */
  handoffMarks?: readonly string[] | undefined;
  handoffPicker?: HandoffPickerState | undefined;
  workerPicker?: WorkerPickerState | undefined;
  commandPalette?: CommandPaletteState | undefined;
  permissionPicker?: PermissionPickerState | undefined;
  launchProfiles: Record<string, LaunchProfile>;
  /** What the providers currently advertise, as last read from the broker. */
  workerModels: WorkerModelCatalog;
  permissionPolicies: ProviderPermissionPreferences;
  nvimLayoutEnabled: boolean;
  view: "fleet" | "diagnostics";
  helpOpen?: boolean | undefined;
  /**
   * Set while the operator is debugging lease custody. Worker rows then carry the full
   * broker projection on a second line; at rest a single badge says the same thing.
   */
  leaseDetail?: boolean | undefined;
  rename?: RenameState | undefined;
  /** Set while the operator is naming a repository to register as a project. */
  projectPrompt?: ProjectPromptState | undefined;
  /** Set while the composer is a shell rather than a task line. Entered with `!`, left with esc. */
  shellMode?: ShellModeState | undefined;
  notice?: string | undefined;
  noticeTone?: FleetNoticeTone | undefined;
}

export type FleetAction =
  | { type: "stop"; sessionId: string; }
  | { type: "delete"; sessionId: string; }
  | { type: "attach"; sessionId: string; }
  | { type: "resume"; sessionId: string; }
  | {
    type: "start";
    request: StartSessionRequest & { initialPrompt: string; };
    permissionLaunch?: ProviderPermissionResolution | undefined;
  }
  | {
    type: "open-orchestrator";
    sessionId: string;
    cockpitCwd: string;
    requiresResume: boolean;
  }
  | {
    type: "create-orchestrator";
    request: CreateOrchestratorRequest;
    cockpitCwd: string;
  }
  | { type: "fable-workers"; request: FableWorkersRequest; }
  | { type: "caveman-workers"; request: CavemanWorkersRequest; }
  | { type: "nvim-layout"; enabled: boolean; }
  | { type: "open-worktree"; sessionId: string; }
  | { type: "open-checkout"; cwd: string; }
  | { type: "rename"; sessionId: string; name: string; }
  | { type: "pin"; sessionId: string; }
  | { type: "reorder"; sessionId: string; direction: "up" | "down"; }
  | { type: "profile"; cwd: string; profile: LaunchProfile; }
  | { type: "worker-capabilities"; }
  | {
    type: "handoff";
    workerIds: readonly string[];
    recipientSessionId: string;
    directive: string;
    mutationId: string;
  }
  | { type: "folder-disposition"; cwd: string; disposition: FolderDisposition; }
  | {
    type: "permission-policy";
    provider: ConfigurablePermissionProvider;
    policy: ProviderPermissionPolicy;
    previousPolicy: ProviderPermissionPolicy;
  }
  | { type: "change-directory"; cwd: string; }
  | { type: "shell-run"; command: string; cwd: string; }
  | { type: "project-add"; path: string; acceptParent?: boolean | undefined; }
  | { type: "project-remove"; root: string; }
  | { type: "project-complete"; draft: string; }
  | { type: "attach-clipboard-image"; }
  | { type: "quit"; };

export interface FleetTransition {
  state: FleetState;
  action?: FleetAction;
}

export type StartFleetAction = Extract<FleetAction, { type: "start"; }>;

export type ThreadStatus = "Working" | "Needs input" | "Done" | "Stopping" | "Stopped" | "Interrupted" | "Failed";

export interface FleetRenderOptions {
  color?: boolean | undefined;
  width?: number | undefined;
  height?: number | undefined;
  now?: number | undefined;
  home?: string | undefined;
  /**
   * Pull request per thread id — never per worktree. A thread's pull request is
   * the one on the branch its own work lands on, so threads that happen to share
   * a checkout no longer inherit each other's.
   */
  pullRequests?: ReadonlyMap<string, PullRequestSummary> | undefined;
  /**
   * The terminal's own background, when it answered the OSC 11 query at startup. The octopus is
   * one ink on any ground, so this picks nothing: it softens the silhouette's edge and that is
   * all. Absent means unknown, which costs a slightly harder edge and nothing else.
   */
  background?: TerminalBackground | undefined;
}
