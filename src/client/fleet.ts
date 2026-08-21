import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  CavemanWorkersRequest,
  CavemanWorkersResult,
  CreateOrchestratorRequest,
  FableWorkersRequest,
  FableWorkersResult,
  OrchestratorGrantToggleResult,
} from "../domain/orchestrator.js";
import type {
  FleetOrchestratorOwnershipView,
  FleetWorkerCoordinationView,
} from "../broker/worker-coordination-view.js";
import type {
  FleetProjectAddResult,
  FleetProjectRemoveResult,
} from "../broker/fleet-project-service.js";
import type { ProviderId, ReasoningEffort, SessionRecord, StartSessionRequest } from "../domain/session.js";
import { HANDOFF_LIMITS } from "../domain/worker-handoff.js";
import type { WorkerHandoffResult } from "../orchestration/worker-handoff-service.js";
import { provisionedWorktreeSlug } from "../domain/worker-workspace.js";
import { ORCHESTRATOR_CATALOG } from "../orchestration/orchestrator-catalog.js";
import {
  capabilityModelEfforts,
  fallbackWorkerCapabilities,
  type ResolvedWorkerCapability,
} from "../orchestration/worker-capabilities.js";
import { appStateDirectory } from "../paths.js";
import {
  ProviderPermissionPreferenceStore,
  type ProviderPermissionPreferencePort,
  type ProviderPermissionPreferences,
} from "../persistence/provider-permission-preference-store.js";
import {
  imageInputRefusal,
  providerAcceptsImages,
  providerAttachesImagesAtLaunch,
  providerImageMechanism,
} from "../providers/image-input.js";
import { conversationPreview } from "../runtime/conversation-preview.js";
import type { ShellCommandResult } from "../runtime/shell-command.js";
import { providerTerminalActivity, stripTerminalControl } from "../runtime/terminal-replay.js";
import { attachSession, type AttachTransport } from "./attach.js";
import {
  capturePasteboardImage,
  composerImageAttachments,
  draftWithImageReference,
  type PasteboardImageAttachment,
} from "./clipboard-image.js";
import { collectDashboardSnapshot, renderDashboard } from "./dashboard.js";
import { displayWidth, graphemeWidth, graphemes } from "./display-width.js";
import {
  OCTOPUS_MARK,
  OCTOPUS_SPLASH,
  pixelArtHeight,
  pixelArtWidth,
  renderPixelArt,
} from "./octopus.js";
import {
  leaseCustody,
  leaseCustodyBadge,
  leaseCustodySummary,
  uniformLeaseCustody,
  type LeaseCustody,
  type LeaseCustodyBadge,
} from "./lease-custody.js";
import {
  fleetOwnerSigils,
  workerOwner,
  workerOwnerSigil,
  type OwnerSigils,
} from "./owner-sigil.js";
import {
  CONFIGURABLE_PERMISSION_PROVIDERS,
  permissionProviderLabel,
  resolveProviderPermission,
  type ConfigurablePermissionProvider,
  type ProviderPermissionPolicy,
  type ProviderPermissionResolution,
} from "./permission-policy.js";
import { completeDirectoryPath, expandPath } from "./path-completion.js";
import {
  NO_PULL_REQUEST_STATUS,
  PullRequestStatusCache,
  pullRequestLabel,
  pullRequestTone,
  type PullRequestStatusPort,
  type PullRequestSummary,
} from "./pr-status.js";
import { RpcError } from "./rpc-client.js";
import { queryTerminalBackground, type TerminalBackground } from "./terminal-background.js";
import type { SessionSnapshotResult } from "../domain/session-snapshot.js";

export interface FleetTransport {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

interface InteractiveFleetTransport extends FleetTransport, AttachTransport {}

interface FleetInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(raw: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

interface FleetOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string | Uint8Array): unknown;
}

interface FleetSignals {
  on(event: "SIGINT" | "SIGTERM" | "SIGWINCH", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM" | "SIGWINCH", listener: () => void): unknown;
}

export interface FleetThread {
  record: SessionRecord;
  replay: string;
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

interface FleetReplayCacheEntry {
  replay: string;
  cursor?: number;
  /** True only once the session can no longer produce output: terminal state AND its process gone. */
  settled: boolean;
}

const fleetReplayCaches = new WeakMap<FleetTransport, Map<string, FleetReplayCacheEntry>>();

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
  | { kind: "existing"; sessionId: string }
  | { kind: "profile"; modelIndex: number };

export type OrchestratorPickerState =
  | {
    step: "target";
    focus: OrchestratorPickerFocus;
    /** Mirrors the fleet list's ctrl+x ladder, scoped to the picker's own selection. */
    stopAcknowledgement?: StopAcknowledgement | undefined;
    deleteConfirmation?: DeleteConfirmation | undefined;
  }
  | { step: "effort"; modelIndex: number; effortIndex: number };

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
  | { step: "recipient"; workerIds: readonly string[]; focusSessionId?: string | undefined }
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
  parentOffer?: { root: string; toplevel: string } | undefined;
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
  | { type: "stop"; sessionId: string }
  | { type: "delete"; sessionId: string }
  | { type: "attach"; sessionId: string }
  | { type: "resume"; sessionId: string }
  | {
    type: "start";
    request: StartSessionRequest & { initialPrompt: string };
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
  | { type: "fable-workers"; request: FableWorkersRequest }
  | { type: "caveman-workers"; request: CavemanWorkersRequest }
  | { type: "nvim-layout"; enabled: boolean }
  | { type: "open-worktree"; sessionId: string }
  | { type: "open-checkout"; cwd: string }
  | { type: "rename"; sessionId: string; name: string }
  | { type: "pin"; sessionId: string }
  | { type: "reorder"; sessionId: string; direction: "up" | "down" }
  | { type: "profile"; cwd: string; profile: LaunchProfile }
  | { type: "worker-capabilities" }
  | {
    type: "handoff";
    workerIds: readonly string[];
    recipientSessionId: string;
    directive: string;
    mutationId: string;
  }
  | { type: "folder-disposition"; cwd: string; disposition: FolderDisposition }
  | {
    type: "permission-policy";
    provider: ConfigurablePermissionProvider;
    policy: ProviderPermissionPolicy;
    previousPolicy: ProviderPermissionPolicy;
  }
  | { type: "change-directory"; cwd: string }
  | { type: "shell-run"; command: string; cwd: string }
  | { type: "project-add"; path: string; acceptParent?: boolean | undefined }
  | { type: "project-remove"; root: string }
  | { type: "project-complete"; draft: string }
  | { type: "attach-clipboard-image" }
  | { type: "quit" };

export interface FleetTransition {
  state: FleetState;
  action?: FleetAction;
}

export type StartFleetAction = Extract<FleetAction, { type: "start" }>;

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
   * The terminal's own background, when it answered the OSC 11 query at startup. It only tunes the
   * octopus — palette and edge softening — and absent means unknown, which renders exactly as
   * before anything asked.
   */
  background?: TerminalBackground | undefined;
}

interface ResolvedFleetRenderOptions {
  color: boolean;
  width: number;
  height: number;
  now: number;
  home: string;
  pullRequests: ReadonlyMap<string, PullRequestSummary>;
  background: TerminalBackground | undefined;
}

interface WorkerModelChoice {
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
  fallbacks: readonly { provider: ProviderId; reason: string }[];
}

interface OrchestratorModelChoice {
  provider: (typeof ORCHESTRATOR_CATALOG)[number];
  model: string;
  label: string;
}

type SlashCommandName =
  | "/model"
  | "/permissions"
  | "/fable-workers"
  | "/caveman-workers"
  | "/nvim-settings"
  | "/worktree"
  | "/handoff";

interface SlashCommandDefinition {
  name: SlashCommandName;
  description: string;
  values?: readonly SlashCommandValue[] | undefined;
}

interface SlashCommandValue {
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
    layout: { enabled: boolean; orchestratorSessionIds: readonly string[] },
  ) => Promise<string>) | undefined;
  /**
   * Opens a project's primary checkout in that same nvim. No worker owns the checkout, but one can
   * be running in it, so the threads this client is holding travel with the request: an occupied
   * checkout has to land locked even when that worker's own row was never opened.
   */
  openCheckout?: ((
    cwd: string,
    layout: { enabled: boolean; orchestratorSessionIds: readonly string[] },
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

const DELETE_CONFIRMATION_MS = 5_000;
const QUIT_CONFIRMATION_MS = 5_000;
const QUIT_CONFIRMATION_NOTICE = "Press ctrl+c again to exit";
const COMMAND_PALETTE_VISIBLE_ROWS = 3;
const ORCS_SECTION_LABEL = "Orcs";
/**
 * The Orcs roster folds and caps like a folder, so it answers to the same collapsed and expanded
 * arrays under a key of its own. It is shaped like an absolute path because that is what those
 * arrays hold, and no folder can ever be called this.
 */
const ORCS_SECTION_KEY = "/@orcs";
const UNREGISTERED_SECTION_LABEL = "Unregistered";
/**
 * Threads under no registered project. It folds under a sentinel of the same impossible shape as
 * the Orcs roster, and starts folded: it is where work goes to be found again, not a list the
 * operator reads every time they open the fleet.
 */
export const UNREGISTERED_SECTION_KEY = "/@unregistered";
const WORKERS_SECTION_LABEL = "Workers";
/** An older broker has no registry, so the list is still grouped one folder per directory. */
const PROJECTS_UNAVAILABLE_NOTICE = "Project registry unavailable on this broker";
/** How much of a worktree path a row spends naming itself before the name is trimmed. */
const WORKTREE_TAG_WIDTH = 22;
/** The state label's column. Fixed, because the state is one of a known set of words. */
const STATUS_CELL_WIDTH = 11;
/**
 * A row at this width or more can afford the full layout. Below it the row keeps every column it
 * can pay for and yields the rest, in the order `threadRowLayout` spends its width.
 */
const WIDE_ROW_WIDTH = 80;
/**
 * Model and effort in a narrow pane. Wide enough that the model name itself survives — the effort
 * after it is what a cut takes — because the model is the half of the cell an operator scans for.
 */
const NARROW_IDENTITY_CELL_WIDTH = 14;
/** The floors title and preview shrink to before the supplementary columns start dropping out. */
const MIN_TITLE_CELL_WIDTH = 8;
const MIN_PREVIEW_CELL_WIDTH = 6;
/**
 * The most a row will ever spend on a pull-request number: `#` plus six digits,
 * which is more than any repository this fleet dispatches into will reach. The
 * column is normally four or five cells wide, and only as wide as it must be.
 */
const PULL_REQUEST_CELL_WIDTH = 7;
/** Workers shown per folder before the rest go behind a show-more row. */
const FOLDER_THREAD_CAP = 5;
const DEFAULT_PERMISSION_POLICIES: Readonly<Record<ConfigurablePermissionProvider, ProviderPermissionPolicy>> = {
  codex: "permissioned",
  claude: "permissioned",
  cursor: "permissioned",
  antigravity: "permissioned",
};
const PERMISSION_POLICIES: readonly ProviderPermissionPolicy[] = [
  "permissioned",
  "automatic",
];
const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  {
    name: "/model",
    description: "Choose worker provider, model, and effort",
  },
  {
    name: "/permissions",
    description: "Inspect or configure provider launch permissions",
  },
  {
    name: "/fable-workers",
    description: "Inspect or toggle Fable workers",
    values: [
      { value: "status", description: "Show current Fable worker preference" },
      { value: "on", description: "Enable Fable workers" },
      { value: "off", description: "Disable Fable workers" },
    ],
  },
  {
    name: "/caveman-workers",
    description: "Inspect or toggle Caveman workers",
    values: [
      { value: "status", description: "Show current Caveman worker preference" },
      { value: "on", description: "Enable Caveman workers" },
      { value: "off", description: "Disable Caveman workers" },
    ],
  },
  {
    name: "/nvim-settings",
    description: "Inspect or toggle automatic nvim layout",
    values: [
      { value: "status", description: "Show current nvim layout preference" },
      { value: "on", description: "Enable automatic nvim layout" },
      { value: "off", description: "Disable automatic nvim layout" },
    ],
  },
  {
    name: "/handoff",
    description: "Hand the marked workers to an orchestrator with a directive",
  },
  {
    name: "/worktree",
    description: "Inspect or toggle per-worker worktrees for this folder",
    values: [
      { value: "status", description: "Show whether workers here get their own worktree" },
      { value: "on", description: "Cyberdeck cuts a worktree for each new worker" },
      { value: "off", description: "Workers run in this folder as-is" },
    ],
  },
];
/**
 * The composer's offer, built from what the providers answered.
 *
 * A model is offered exactly as the provider spells it — no id is composed here from a stem and an
 * effort, because a provider that encodes effort in the slug has already printed every combination
 * it supports, and inventing a further one produces a launch identifier nobody advertises. The
 * provider's own display name is preferred over Fleet's table, which is a courtesy for ids it
 * recognises and cannot possibly cover ids that did not exist when it was written.
 */
export function workerModelCatalog(
  capabilities: readonly ResolvedWorkerCapability[],
): WorkerModelCatalog {
  return {
    choices: capabilities.flatMap((capability) =>
      capability.models.map((model): WorkerModelChoice => {
        const efforts = capabilityModelEfforts(capability, model);
        return {
          provider: capability.provider,
          model,
          label: capability.modelLabels?.[model] ?? friendlyModel(capability.provider, model),
          efforts: efforts.length === 0 ? ["provider-managed"] : efforts,
          source: capability.source,
        };
      })),
    fallbacks: capabilities.flatMap((capability) =>
      capability.source === "fallback-catalog"
        ? [{
          provider: capability.provider,
          reason: capability.fallbackReason ?? "this provider could not be asked what it offers",
        }]
        : []),
  };
}

/**
 * What the composer offers before the broker has answered, and if it never does.
 *
 * Marked as a fallback for every provider, so a Fleet that started without a broker shows a stale
 * list labelled stale rather than a stale list labelled nothing.
 */
const UNQUERIED_WORKER_MODELS: WorkerModelCatalog = workerModelCatalog(
  fallbackWorkerCapabilities("Fleet has not read provider capabilities from the broker"),
);
const ORCHESTRATOR_MODEL_CHOICES: readonly OrchestratorModelChoice[] = ORCHESTRATOR_CATALOG.flatMap((provider) =>
  provider.models.map((model) => ({
    provider,
    model,
    label: friendlyModel(provider.provider, model),
  })),
);
const DISABLE_INHERITED_TERMINAL_INPUT_MODES = [
  "\u001b[?1000l", // basic mouse tracking
  "\u001b[?1002l", // button-event mouse tracking
  "\u001b[?1003l", // any-event mouse tracking
  "\u001b[?1004l", // focus events
  "\u001b[?1006l", // SGR mouse encoding
  "\u001b[?1015l", // urxvt mouse encoding
  "\u001b[?1016l", // SGR pixel mouse encoding
  "\u001b[?2004l", // bracketed paste
  "\u001b[<u", // pop any keyboard protocol a provider TUI pushed
].join("");
const ENTER_FLEET_SCREEN = `${DISABLE_INHERITED_TERMINAL_INPUT_MODES}\u001b[?1049h\u001b[?25l`;
const LEAVE_FLEET_SCREEN = `${DISABLE_INHERITED_TERMINAL_INPUT_MODES}\u001b[?25h\u001b[?1049l`;

/**
 * Tone table for `paint`.
 *
 * Two layers. The hue block is the raw ink; the semantic block below names what
 * a hue *means*, and rows paint with those names so a hue can move without a
 * render rewrite. Four states earn a hue: blocked, finished, failing, and the
 * one live thread. Everything else is greyscale and leans on weight and the
 * selection rule for hierarchy.
 *
 * `gray` sits one contrast step above its former 123;132;144: legible as body
 * text, still clearly recessed from the terminal foreground.
 */
const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",

  // Hues.
  blue: "\u001b[38;2;158;182;255m",
  purple: "\u001b[38;2;182;158;255m",
  violet: "\u001b[38;2;198;120;221m",
  cyan: "\u001b[38;2;102;194;208m",
  yellow: "\u001b[38;2;212;168;91m",
  green: "\u001b[38;2;120;198;121m",
  red: "\u001b[38;2;217;108;117m",
  gray: "\u001b[38;2;154;163;175m",
  ice: "\u001b[38;2;169;198;214m",

  // Semantic tokens.

  // The mark carries its own palette now — see `octopus.ts`, which holds the reservation the retired
  // `brand` token used to: no state may borrow the hues the octopus is drawn in.
  /** A thread is blocked and wants the operator: needs input, or a prompt awaiting an answer. */
  attention: "\u001b[38;2;212;168;91m",
  /** A thread finished successfully and is waiting to be read. */
  done: "\u001b[38;2;120;198;121m",
  /** The provider is generating right now: the one live state in the fleet. */
  working: "\u001b[38;2;169;198;214m",
  /** Something is wrong right now — a failed thread, a destructive confirmation. */
  alert: "\u001b[38;2;217;108;117m",
  /** Body text at rest: titles, paths, metadata. Subdued, never foreground. */
  muted: "\u001b[38;2;154;163;175m",
  /** Chrome that should recede entirely: rules, footers, shortcut hints. */
  subtle: "\u001b[2m",
  /** The left rule marking the focused row. */
  selection: "\u001b[38;2;154;163;175m",

  // Pull request states, for the per-thread indicator column.

  /** Open: live, reviewable work. */
  prOpen: "\u001b[38;2;120;198;121m",
  /** Draft: opened, not yet offered for review. */
  prDraft: "\u001b[2m",
  /** Merged. Deliberately not the brand purple, which the logo alone owns. */
  prMerged: "\u001b[38;2;198;120;221m",
  /** Closed unmerged: inert and terminal, but not a fault — so not red. */
  prClosed: "\u001b[38;2;154;163;175m",
  /** Checks failing: the one pull request state that demands action. */
  prFailing: "\u001b[38;2;217;108;117m",

  // Provenance takes no hue at all. Six custody hues shipped here, one per orchestrator, and
  // failed: a hue can say "these rows go together" but never *which* orchestrator, because the
  // only thing to match it against was the same hue again. Ownership is a shape now, and colour
  // is back to carrying state alone — see `owner-sigil.ts`.
} as const;

/** Gutter cell that prefixes every navigable row; carries the selection rule. */
const SELECTION_RULE = "▌";
/** One cell wide, so a marked row and an unmarked one still measure the same. */
const HANDOFF_MARK = "✓";
const ROW_GUTTER = "  ";

export async function collectFleetSnapshot(client: FleetTransport): Promise<FleetSnapshot> {
  const sessions = await client.request<SessionRecord[]>("session.list", {});
  let replayCache = fleetReplayCaches.get(client);
  if (replayCache === undefined) {
    replayCache = new Map();
    fleetReplayCaches.set(client, replayCache);
  }
  const listedSessionIds = new Set(sessions.map(({ id }) => id));
  for (const sessionId of replayCache.keys()) {
    if (!listedSessionIds.has(sessionId)) replayCache.delete(sessionId);
  }
  const coordination = await client.request<FleetWorkerCoordinationView[]>(
    "fleet.workerCoordination",
    {},
  ).catch(() => []);
  const coordinationBySession = new Map(
    coordination.map((entry) => [entry.sessionId, entry] as const),
  );
  // An orc's controller identity comes from its binding, which the coordination projection does
  // not carry. A broker too old to answer leaves every orc sigil-less rather than failing the
  // snapshot: no sigils at all is a legible fleet, half of them is not.
  const orchestratorOwnership = new Map(
    (await client.request<FleetOrchestratorOwnershipView[]>("fleet.orchestratorOwnership", {})
      .catch(() => []))
      .map((entry) => [entry.sessionId, entry.controllerId] as const),
  );
  // Undefined rather than empty when the broker has no registry: an empty list is an answer, and
  // grouping every thread under "Unregistered" is the wrong answer to a question nobody asked.
  const projects = await client.request<string[]>("fleet.projects", {})
    .then((roots) => roots as readonly string[] | undefined, () => undefined);
  const threads = await Promise.all(sessions.map(async (record): Promise<FleetThread | null> => {
    try {
      const cached = replayCache.get(record.id);
      const workerCoordination = coordinationBySession.get(record.id);
      const controllerId = orchestratorOwnership.get(record.id);
      // A terminal executionState alone is not enough to stop polling: session.stop marks a
      // session cancelled before signalling it, so the process can still be flushing output.
      // Only a settled session — terminal AND with no live process (exited, or never launched)
      // — is safe to freeze in the cache.
      const terminal = record.executionState !== "active" && record.executionState !== "starting";
      const settled = terminal && (record.exitCode !== null || record.pid === 0);
      if (settled && cached?.settled === true) {
        return {
          record,
          replay: cached.replay,
          ...(workerCoordination === undefined ? {} : { coordination: workerCoordination }),
          ...(controllerId === undefined ? {} : { controllerId }),
        };
      }
      const snapshot = await client.request<SessionSnapshotResult>("session.snapshot", {
        sessionId: record.id,
        cursor: cached?.cursor ?? 0,
      });
      const replay = "notModified" in snapshot
        ? cached?.replay
        : Buffer.from(snapshot.data, "base64").toString("utf8");
      if (replay === undefined) {
        throw new Error(`Broker returned not-modified before Fleet cached session ${record.id}`);
      }
      replayCache.set(record.id, {
        replay,
        ...(snapshot.cursor === undefined ? {} : { cursor: snapshot.cursor }),
        settled,
      });
      return {
        record,
        replay,
        ...(workerCoordination === undefined ? {} : { coordination: workerCoordination }),
        ...(controllerId === undefined ? {} : { controllerId }),
      };
    } catch (error) {
      if (error instanceof RpcError && error.code === "SESSION_NOT_FOUND") return null;
      throw error;
    }
  }));
  return {
    threads: threads.filter((thread): thread is FleetThread => thread !== null),
    ...(projects === undefined ? {} : { projects }),
  };
}

export function createFleetState(snapshot: FleetSnapshot, fallbackCwd = process.cwd()): FleetState {
  return {
    selectedSessionId: orderedThreads(snapshot)[0]?.record.id,
    threadListScrollOffset: 0,
    fallbackCwd,
    draft: "",
    launchProfiles: {},
    workerModels: UNQUERIED_WORKER_MODELS,
    permissionPolicies: { ...DEFAULT_PERMISSION_POLICIES },
    nvimLayoutEnabled: true,
    view: "fleet",
  };
}

export function threadStatus(thread: FleetThread): ThreadStatus {
  const persisted = thread.record.attentionState;
  if (persisted !== undefined) {
    return ({
      working: "Working",
      "needs-input": "Needs input",
      done: "Done",
      stopping: "Stopping",
      stopped: "Stopped",
      interrupted: "Interrupted",
      failed: "Failed",
    } as const)[persisted];
  }
  switch (thread.record.executionState) {
    case "starting": return "Working";
    case "exited": return "Done";
    case "failed": return "Failed";
    // A session that died inside a live process. It reads as Failed rather than as whatever its
    // last terminal frame happened to look like, so nobody is invited to type at it.
    case "errored": return "Failed";
    case "cancelled": return thread.record.exitCode === null ? "Stopping" : "Stopped";
    case "active": {
      const activity = providerTerminalActivity(thread.record.provider, thread.replay);
      if (activity === "working") return "Working";
      if (activity === "needs-input") return "Needs input";
      return "Done";
    }
  }
}

export async function startFleetSession(
  client: FleetTransport,
  action: StartFleetAction,
): Promise<SessionRecord> {
  if (action.permissionLaunch?.application.kind !== "post-launch-command") {
    return client.request<SessionRecord>("session.startWithPrompt", action.request);
  }
  return client.request<SessionRecord>("session.startWithPrompt", {
    ...action.request,
    approvalMode: "auto",
  });
}

export function transitionFleet(
  current: FleetState,
  snapshot: FleetSnapshot,
  key: string,
  now = Date.now(),
  threadListViewportHeight = Number.MAX_SAFE_INTEGER,
): FleetTransition {
  const normalized = normalizeState(current, snapshot, now);
  const threads = orderedThreads(snapshot);

  if (key === "ctrl+c") {
    if (normalized.quitConfirmation !== undefined) {
      return {
        state: { ...normalized, quitConfirmation: undefined, notice: undefined },
        action: { type: "quit" },
      };
    }
    return {
      state: {
        ...normalized,
        deleteConfirmation: undefined,
        quitConfirmation: { expiresAt: now + QUIT_CONFIRMATION_MS },
        notice: QUIT_CONFIRMATION_NOTICE,
        noticeTone: "confirmation",
      },
    };
  }

  const state = normalized.quitConfirmation === undefined
    ? normalized
    : {
        ...normalized,
        quitConfirmation: undefined,
        ...(normalized.notice === QUIT_CONFIRMATION_NOTICE ? { notice: undefined } : {}),
      };
  // A focused folder header or show-more row owns the row, so every thread-scoped key is
  // inert until focus moves back onto a thread.
  const focusedFolderCwd = state.focusedFolderCwd;
  const focusedShowMoreCwd = state.focusedShowMoreCwd;
  const selected = threadFocusInert(state)
    ? undefined
    : threads.find(({ record }) => record.id === state.selectedSessionId);

  if (key === "ctrl+w") {
    return {
      state: {
        ...state,
        view: state.view === "fleet" ? "diagnostics" : "fleet",
        helpOpen: false,
        notice: undefined,
      },
    };
  }

  if (state.view === "diagnostics") return { state };

  if (state.rename !== undefined) {
    if (key === "escape") return { state: { ...state, rename: undefined, notice: undefined } };
    if (key === "enter") {
      const name = state.rename.draft.trim();
      if (name === "") return { state: { ...state, notice: "Thread name cannot be empty", noticeTone: "error" } };
      return {
        state: { ...state, rename: undefined, notice: undefined },
        action: { type: "rename", sessionId: state.rename.sessionId, name },
      };
    }
    if (key === "backspace") {
      return {
        state: {
          ...state,
          rename: { ...state.rename, draft: [...state.rename.draft].slice(0, -1).join("") },
          notice: undefined,
        },
      };
    }
    if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
      return {
        state: { ...state, rename: { ...state.rename, draft: `${state.rename.draft}${key}` }, notice: undefined },
      };
    }
    return { state };
  }

  if (state.projectPrompt !== undefined) {
    return transitionProjectPrompt(state, snapshot, key);
  }

  if (state.shellMode !== undefined) {
    return transitionShellMode(state, snapshot, key);
  }

  if (state.workerPicker !== undefined) {
    return transitionWorkerPicker(state, key);
  }

  if (state.permissionPicker !== undefined) {
    return transitionPermissionPicker(state, snapshot, key);
  }

  if (state.commandPalette !== undefined) {
    return transitionCommandPalette(state, snapshot, key);
  }

  if (state.handoffPicker !== undefined) {
    return transitionHandoffPicker(state, snapshot, key);
  }

  if (key === "ctrl+o") {
    return {
      state: {
        ...state,
        draft: "",
        deleteConfirmation: undefined,
        notice: undefined,
        orchestratorPicker: initialOrchestratorPicker(snapshot, state.fallbackCwd),
      },
    };
  }

  if (state.orchestratorPicker !== undefined) {
    return transitionOrchestratorPicker(state, snapshot, key, now);
  }

  // Ctrl+S, not Ctrl+G: "s for shell" is the association the operator's hand actually makes, and it
  // leaves Ctrl+G doing one coherent job — getting out of the `!` shell line — instead of three.
  if (key === "ctrl+s") {
    return {
      state: { ...state, helpOpen: false, notice: undefined },
      action: { type: "change-directory", cwd: composerCwd(state, snapshot) },
    };
  }

  if (key === "ctrl+]") {
    // A collapsed Orcs section, or its show-more row, takes focus off the roster while the orc
    // the operator picked stays the selection. The cockpit chord answers to that selection, so
    // folding the roster never puts the selected orc out of reach.
    const cockpitTarget = selected
      ?? threads.find(({ record }) => record.id === state.selectedSessionId);
    if (cockpitTarget?.record.kind !== "orchestrator") {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: "Select a detached orchestrator to attach to the cockpit",
          noticeTone: "neutral",
        },
      };
    }
    if (cockpitTarget.record.attachmentState === "controlled") {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: "Selected orchestrator is controlled elsewhere",
          noticeTone: "warning",
        },
      };
    }
    return {
      state: { ...state, helpOpen: false, notice: undefined },
      action: {
        type: "open-orchestrator",
        sessionId: cockpitTarget.record.id,
        cockpitCwd: state.fallbackCwd,
        requiresResume: cockpitTarget.record.executionState !== "active"
          && cockpitTarget.record.executionState !== "starting",
      },
    };
  }

  if (key === "?" && state.draft === "") {
    return { state: { ...state, helpOpen: state.helpOpen !== true, notice: undefined } };
  }

  if (key === "ctrl+l") {
    return {
      state: {
        ...state,
        leaseDetail: state.leaseDetail !== true,
        helpOpen: false,
        notice: undefined,
      },
    };
  }

  // Ctrl+D, not the Ctrl+B a "batch" would suggest: Ctrl+B is tmux's own prefix, so a pane's
  // application never sees the byte. Marking is deliberately a toggle on the focused row rather
  // than a range gesture — the fleet list re-sorts under the operator, and a range would then mean
  // something different one frame later.
  if (key === "ctrl+d") {
    if (selected === undefined) {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: "Select a worker to mark it for handoff",
          noticeTone: "warning",
        },
      };
    }
    if (selected.record.kind === "orchestrator") {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: "An orchestrator receives a handoff; it is not marked for one",
          noticeTone: "warning",
        },
      };
    }
    if (isTerminalSession(selected.record)) {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: TERMINAL_HANDOFF_REFUSAL,
          noticeTone: "warning",
        },
      };
    }
    const marked = handoffMarks(state);
    const workerId = selected.record.id;
    if (!marked.includes(workerId) && marked.length >= HANDOFF_LIMITS.manifestEntries) {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: `A handoff can include at most ${HANDOFF_LIMITS.manifestEntries} workers`,
          noticeTone: "warning",
        },
      };
    }
    const next = marked.includes(workerId)
      ? marked.filter((id) => id !== workerId)
      : [...marked, workerId];
    return {
      state: {
        ...state,
        handoffMarks: next,
        helpOpen: false,
        notice: next.length === 0
          ? "No workers marked for handoff"
          : `${next.length} worker${next.length === 1 ? "" : "s"} marked · /handoff to send`,
        noticeTone: "neutral",
      },
    };
  }

  if (key === "ctrl+r" && selected !== undefined) {
    return {
      state: {
        ...state,
        rename: { sessionId: selected.record.id, draft: selected.record.name ?? "" },
        helpOpen: false,
        notice: undefined,
      },
    };
  }

  if (key === "ctrl+n") {
    // A folder header names the repository itself, so Ctrl+N there opens its primary checkout —
    // the one place in a project no worker's worktree reaches, and the reason the operator used to
    // have to leave Fleet for a one-line manual edit. The Orcs roster and the unregistered bucket
    // are sections rather than paths, so neither is a checkout to open.
    if (focusedFolderCwd !== undefined) {
      if (focusedFolderCwd.startsWith("/@")) {
        return {
          state: { ...state, helpOpen: false, notice: "Not a project folder", noticeTone: "warning" },
        };
      }
      return {
        state: { ...state, helpOpen: false, notice: undefined },
        action: { type: "open-checkout", cwd: focusedFolderCwd },
      };
    }
    // An Orc's cwd is the workspace it coordinates from, not a worktree an agent is rewriting, so
    // there is nothing there to land on and nothing to protect from co-editing.
    if (selected === undefined || selected.record.kind === "orchestrator") {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: "Select a worker to open its worktree in nvim",
          noticeTone: "neutral",
        },
      };
    }
    return {
      state: { ...state, helpOpen: false, notice: undefined },
      action: { type: "open-worktree", sessionId: selected.record.id },
    };
  }

  if (key === "ctrl+t" && selected !== undefined) {
    return { state: { ...state, helpOpen: false, notice: undefined }, action: { type: "pin", sessionId: selected.record.id } };
  }

  if ((key === "shift+up" || key === "shift+down") && selected !== undefined) {
    return {
      state: { ...state, helpOpen: false, notice: undefined },
      action: {
        type: "reorder",
        sessionId: selected.record.id,
        direction: key === "shift+up" ? "up" : "down",
      },
    };
  }

  if (/^alt\+[1-9]$/u.test(key)) {
    const index = Number(key.slice(-1)) - 1;
    const target = threads[index];
    return target === undefined
      ? { state }
      : {
          state: {
            ...state,
            selectedSessionId: target.record.id,
            focusedFolderCwd: undefined,
            focusedShowMoreCwd: undefined,
            deleteConfirmation: undefined,
            notice: undefined,
          },
          action: openAction(target.record),
        };
  }

  if (key === "ctrl+x" && selected !== undefined) {
    const terminal = isTerminalSession(selected.record);
    const stopAcknowledged = state.stopAcknowledgement?.sessionId === selected.record.id;
    if (!terminal || !stopAcknowledged) {
      return {
        state: {
          ...state,
          stopAcknowledgement: { sessionId: selected.record.id },
          deleteConfirmation: undefined,
          notice: `Stopping ${threadSubject(selected.record)}`,
          noticeTone: "warning",
        },
        action: { type: "stop", sessionId: selected.record.id },
      };
    }
    if (state.deleteConfirmation?.sessionId === selected.record.id) {
      return {
        state: { ...state, deleteConfirmation: undefined, notice: undefined },
        action: { type: "delete", sessionId: selected.record.id },
      };
    }
    return {
      state: {
        ...state,
        deleteConfirmation: {
          sessionId: selected.record.id,
          expiresAt: now + DELETE_CONFIRMATION_MS,
        },
        notice: `Delete ${threadSubject(selected.record)}? press ctrl+x again`,
        noticeTone: "confirmation",
      },
    };
  }

  // Registry keys are plain letters and therefore only reachable from a folder header with an empty
  // composer: on a thread row, or mid-draft, those letters are text the operator is typing.
  if (key === "a" && focusedFolderCwd !== undefined && state.draft === "") {
    if (snapshot.projects === undefined) {
      return { state: { ...state, notice: PROJECTS_UNAVAILABLE_NOTICE, noticeTone: "error" } };
    }
    return {
      state: { ...state, projectPrompt: { draft: "" }, helpOpen: false, notice: undefined },
    };
  }
  if (key === "d" && focusedFolderCwd !== undefined && state.draft === "") {
    if (snapshot.projects === undefined) {
      return { state: { ...state, notice: PROJECTS_UNAVAILABLE_NOTICE, noticeTone: "error" } };
    }
    // The Orc roster and the unregistered bucket are sections, not projects; neither is the
    // operator's to remove.
    if (focusedFolderCwd.startsWith("/@")) {
      return { state: { ...state, notice: "Not a project folder", noticeTone: "warning" } };
    }
    return {
      state: { ...state, notice: undefined },
      action: { type: "project-remove", root: focusedFolderCwd },
    };
  }
  if (focusedFolderCwd !== undefined && (key === "left" || key === "right")) {
    return foldTransition(state, setCollapsed(state, focusedFolderCwd, key === "left"), focusedFolderCwd);
  }
  if (key === "enter" && focusedFolderCwd !== undefined && state.draft.trim() === "") {
    return foldTransition(
      state,
      setCollapsed(state, focusedFolderCwd, !isCollapsed(state, focusedFolderCwd)),
      focusedFolderCwd,
    );
  }
  // The show-more row is the folder's cap in reverse: right opens it, left puts it back.
  if (focusedShowMoreCwd !== undefined && (key === "left" || key === "right")) {
    return foldTransition(state, setExpanded(state, focusedShowMoreCwd, key === "right"), focusedShowMoreCwd);
  }
  if (key === "enter" && focusedShowMoreCwd !== undefined && state.draft.trim() === "") {
    return foldTransition(
      state,
      setExpanded(state, focusedShowMoreCwd, !isExpanded(state, focusedShowMoreCwd)),
      focusedShowMoreCwd,
    );
  }
  if (key === "right" && selected !== undefined) {
    return {
      state: { ...state, draft: "", deleteConfirmation: undefined, notice: undefined },
      action: openAction(selected.record),
    };
  }
  if (key === " " && state.draft === "" && selected !== undefined) {
    return {
      state: { ...state, deleteConfirmation: undefined, helpOpen: false, notice: undefined },
      action: openAction(selected.record),
    };
  }
  if (key === "enter" && selected !== undefined) {
    const initialPrompt = state.draft.trim();
    const workerPolicy = workerPolicyTransition(state, snapshot, initialPrompt);
    if (workerPolicy !== undefined) return workerPolicy;
    if (initialPrompt === "/model") {
      return openWorkerPicker(state, snapshot, "");
    }
    if (initialPrompt === "/permissions") {
      return openPermissionPicker(state, snapshot);
    }
    if (initialPrompt === "/handoff") {
      return openHandoffPicker(state, snapshot);
    }
    if (initialPrompt === "") {
      return {
        state: { ...state, deleteConfirmation: undefined, notice: undefined },
        action: openAction(selected.record),
      };
    }
    return startTransition(state, selected.record, initialPrompt);
  }
  if (key === "enter" && selected === undefined && state.draft.trim() !== "") {
    const initialPrompt = state.draft.trim();
    const workerPolicy = workerPolicyTransition(state, snapshot, initialPrompt);
    if (workerPolicy !== undefined) return workerPolicy;
    if (initialPrompt === "/model") return openWorkerPicker(state, snapshot, "");
    if (initialPrompt === "/permissions") return openPermissionPicker(state, snapshot);
    if (initialPrompt === "/handoff") return openHandoffPicker(state, snapshot);
    return startTransition(state, undefined, initialPrompt);
  }
  if (
    key === "up"
    || key === "down"
    || key === "pageup"
    || key === "pagedown"
    || key === "alt+k"
    || key === "alt+j"
    || key === "home"
    || key === "end"
  ) {
    const rows = fleetListRows(snapshot, state);
    const currentIndex = focusedListRowIndex(rows, state);
    const pageDistance = Math.max(1, threadListViewportHeight - 1);
    const halfPageDistance = Math.max(1, Math.floor(threadListViewportHeight / 2));
    const targetIndex = key === "home"
      ? 0
      : key === "end"
        ? rows.length - 1
        : currentIndex + (
            key === "up"
              ? -1
              : key === "down"
                ? 1
                : key === "pageup"
                  ? -pageDistance
                  : key === "pagedown"
                    ? pageDistance
                    : key === "alt+k"
                      ? -halfPageDistance
                      : halfPageDistance
          );
    const nextIndex = navigableListRowIndex(
      rows,
      targetIndex,
      targetIndex < currentIndex ? -1 : 1,
    );
    const focused = focusRow(state, rows[nextIndex]);
    return {
      state: {
        ...scrollFocusedRowIntoView(
          focused,
          rows,
          threadListViewportHeight,
        ),
        deleteConfirmation: undefined,
        notice: undefined,
      },
    };
  }
  if (key === "backspace") {
    return { state: { ...state, draft: [...state.draft].slice(0, -1).join(""), notice: undefined } };
  }
  // Reading the pasteboard is I/O, so the reducer only asks for it and the draft grows once the
  // path exists. The state is returned untouched — not even the notice is cleared — so a chord
  // pressed over a text-only pasteboard leaves the frame byte-identical.
  if (key === "ctrl+v") {
    // The composer's target is known whenever the cwd has a launch profile, and a provider that
    // cannot be handed a path is told so before a PNG is written rather than after: an image
    // captured for a worker that will never open it is the silent drop, one step delayed. With no
    // profile chosen there is no provider yet to judge, so the paste proceeds and the same refusal
    // stands guard at the launch itself.
    const target = state.launchProfiles[composerCwd(state, snapshot)]?.provider;
    if (target !== undefined && !providerAcceptsImages(target)) {
      return {
        state: { ...state, notice: imageInputRefusal(target), noticeTone: "error" },
      };
    }
    return { state, action: { type: "attach-clipboard-image" } };
  }
  // Newline in the composer. Option+Enter is the convention operators arrive with, so it is bound
  // here and nowhere else: no fleet action may ever answer it, or a half-written task would launch.
  if (key === "ctrl+j" || key === "alt+enter" || key === "shift+enter") {
    return { state: { ...state, draft: `${state.draft}\n`, notice: undefined } };
  }
  if (key === "escape") {
    if (state.helpOpen === true) return { state: { ...state, helpOpen: false, notice: undefined } };
    if (state.draft !== "") return { state: { ...state, draft: "", notice: undefined } };
    return { state };
  }
  if (key === "@" && state.draft === "" && selected !== undefined) {
    const reference = (selected.record.name ?? selected.record.id.slice(0, 8)).replace(/\s+/gu, "-");
    return { state: { ...state, draft: `@${reference} `, notice: undefined } };
  }
  // `!` is a shell only on an empty composer, exactly as `/` is a command palette only there: mid
  // draft it is the character the operator typed, and a task line may well contain one.
  if (key === "!" && state.draft === "") {
    return {
      state: {
        ...state,
        shellMode: { draft: "", transcript: [] },
        helpOpen: false,
        notice: undefined,
      },
    };
  }
  if (key === "/" && state.draft === "") {
    return {
      state: {
        ...state,
        draft: "/",
        commandPalette: {
          level: "commands",
          selectedIndex: 0,
          scrollOffset: 0,
        },
        helpOpen: false,
        notice: undefined,
      },
    };
  }
  if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
    return { state: { ...state, draft: `${state.draft}${key}`, notice: undefined } };
  }
  return { state };
}

export function renderFleet(
  snapshot: FleetSnapshot,
  current: FleetState,
  options: FleetRenderOptions = {},
): string {
  // The renderer must use the physical pane width. Fleet can occupy a sub-50-column pane in the
  // automatic three-pane layout; pretending it is 50 columns lets logical rows soft-wrap and
  // invalidates the damage renderer's absolute row addresses.
  const width = Math.max(1, options.width ?? 120);
  const height = Math.max(1, options.height ?? 32);
  const now = options.now ?? Date.now();
  const color = options.color ?? true;
  const home = options.home ?? homedir();
  const pullRequests = options.pullRequests ?? new Map();
  const resolved = { width, height, now, color, home, pullRequests, background: options.background };
  const state = normalizeState(current, snapshot, now);
  if (state.workerPicker !== undefined) {
    return renderWorkerPicker(state, resolved);
  }
  if (state.permissionPicker !== undefined) {
    return renderPermissionPicker(snapshot, state, resolved);
  }
  if (state.commandPalette !== undefined) {
    return renderCommandPalette(state, resolved);
  }
  if (state.handoffPicker !== undefined) {
    return renderHandoffPicker(snapshot, state, resolved);
  }
  if (state.orchestratorPicker !== undefined) {
    return renderOrchestratorPicker(snapshot, state, resolved);
  }
  return renderFleetList(snapshot, state, resolved);
}

function threadListViewportHeight(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): number {
  const bodyHeight = Math.max(
    0,
    options.height - renderFleetFooter(snapshot, state, options).length,
  );
  return Math.max(
    0,
    bodyHeight - renderHeader(orderedThreads(snapshot), state, options).length - 1,
  );
}

function normalizeThreadListViewport(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): FleetState {
  return scrollFocusedRowIntoView(
    state,
    fleetListRows(snapshot, state),
    threadListViewportHeight(snapshot, state, options),
  );
}

function transitionCommandPalette(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const palette = state.commandPalette!;
  const candidates = commandPaletteCandidates(state);
  if (key === "escape") {
    return {
      state: {
        ...state,
        draft: "",
        commandPalette: undefined,
        notice: undefined,
      },
    };
  }
  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    const selectedIndex = boundedIndex(
      palette.selectedIndex + delta,
      candidates.length,
    );
    return {
      state: {
        ...state,
        commandPalette: {
          ...palette,
          selectedIndex,
          scrollOffset: paletteScrollOffset(selectedIndex, palette.scrollOffset),
        },
      },
    };
  }
  if (key === "backspace") {
    if (state.draft === "/") {
      return {
        state: {
          ...state,
          draft: "",
          commandPalette: undefined,
          notice: undefined,
        },
      };
    }
    const draft = [...state.draft].slice(0, -1).join("");
    const command = palette.command;
    const valuesOpen = command !== undefined && draft.startsWith(`${command} `);
    return {
      state: {
        ...state,
        draft,
        commandPalette: {
          level: valuesOpen ? "values" : "commands",
          ...(valuesOpen ? { command } : {}),
          selectedIndex: 0,
          scrollOffset: 0,
        },
        notice: undefined,
      },
    };
  }
  if (key === "enter") {
    const selected = candidates[palette.selectedIndex];
    if (selected === undefined) {
      return {
        state: {
          ...state,
          notice: "No matching slash commands",
          noticeTone: "error",
        },
      };
    }
    if (palette.level === "commands") {
      const command = selected as SlashCommandDefinition;
      if (command.values !== undefined) {
        return {
          state: {
            ...state,
            draft: `${command.name} `,
            commandPalette: {
              level: "values",
              command: command.name,
              selectedIndex: 0,
              scrollOffset: 0,
            },
            notice: undefined,
          },
        };
      }
      const closed = {
        ...state,
        draft: "",
        commandPalette: undefined,
        notice: undefined,
      };
      if (command.name === "/model") return openWorkerPicker(closed, snapshot, "");
      if (command.name === "/handoff") return openHandoffPicker(closed, snapshot);
      return openPermissionPicker(closed, snapshot);
    }
    const command = palette.command!;
    const value = (selected as SlashCommandValue).value;
    const completed = {
      ...state,
      draft: `${command} ${value}`,
      commandPalette: undefined,
      notice: undefined,
    };
    return workerPolicyTransition(completed, snapshot, completed.draft)
      ?? { state: completed };
  }
  if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
    if (palette.level === "commands" && key === " ") {
      const command = SLASH_COMMANDS.find((candidate) => candidate.name === state.draft);
      if (command?.values !== undefined) {
        return {
          state: {
            ...state,
            draft: `${state.draft} `,
            commandPalette: {
              level: "values",
              command: command.name,
              selectedIndex: 0,
              scrollOffset: 0,
            },
            notice: undefined,
          },
        };
      }
    }
    return {
      state: {
        ...state,
        draft: `${state.draft}${key}`,
        commandPalette: {
          ...palette,
          selectedIndex: 0,
          scrollOffset: 0,
        },
        notice: undefined,
      },
    };
  }
  return { state };
}

function commandPaletteCandidates(
  state: FleetState,
): readonly (SlashCommandDefinition | SlashCommandValue)[] {
  const palette = state.commandPalette!;
  if (palette.level === "commands") {
    const query = state.draft.slice(1).trim().toLowerCase();
    if (query === "") return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((command) =>
      command.name.slice(1).includes(query)
      || command.description.toLowerCase().includes(query));
  }
  const command = SLASH_COMMANDS.find((candidate) => candidate.name === palette.command);
  if (command?.values === undefined) return [];
  const prefix = `${command.name} `;
  const query = state.draft.startsWith(prefix)
    ? state.draft.slice(prefix.length).trim().toLowerCase()
    : "";
  if (query === "") return command.values;
  return command.values.filter((value) =>
    value.value.includes(query)
    || value.description.toLowerCase().includes(query));
}

function paletteScrollOffset(selectedIndex: number, current: number): number {
  if (selectedIndex < current) return selectedIndex;
  if (selectedIndex >= current + COMMAND_PALETTE_VISIBLE_ROWS) {
    return selectedIndex - COMMAND_PALETTE_VISIBLE_ROWS + 1;
  }
  return current;
}

function renderCommandPalette(
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const palette = state.commandPalette!;
  const candidates = commandPaletteCandidates(state);
  const visible = candidates.slice(
    palette.scrollOffset,
    palette.scrollOffset + COMMAND_PALETTE_VISIBLE_ROWS,
  );
  const lines = [
    ...renderHeader([], state, options),
    "",
    palette.level === "commands" ? "Slash commands" : `${palette.command} values`,
    "",
  ];
  if (visible.length === 0) {
    lines.push("No matching commands");
  } else {
    lines.push(...visible.map((candidate, visibleIndex) => {
      const absoluteIndex = palette.scrollOffset + visibleIndex;
      const label = "name" in candidate ? candidate.name : candidate.value;
      return pickerRow(
        fit(`${label}  ${candidate.description}`, options.width - 2),
        absoluteIndex === palette.selectedIndex,
        options.color,
      );
    }));
  }
  const range = candidates.length === 0
    ? "0 results"
    : `${palette.scrollOffset + 1}-${Math.min(
      candidates.length,
      palette.scrollOffset + COMMAND_PALETTE_VISIBLE_ROWS,
    )} of ${candidates.length}`;
  const footer = [
    paint("─".repeat(options.width), "dim", options.color),
    ...renderComposerLines(state.draft, "task", options),
    paint("─".repeat(options.width), "dim", options.color),
    paint(fit(`↑↓ select · enter complete · esc close · ${range}`, options.width), "dim", options.color),
  ];
  const body = lines.slice(0, Math.max(0, options.height - footer.length));
  while (body.length < options.height - footer.length) body.push("");
  return [...body, ...footer].join("\n");
}

function openPermissionPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
): FleetTransition {
  const provider = state.launchProfiles[composerCwd(state, snapshot)]?.provider;
  const providerIndex = Math.max(
    0,
    CONFIGURABLE_PERMISSION_PROVIDERS.indexOf(
      provider as ConfigurablePermissionProvider,
    ),
  );
  return {
    state: {
      ...state,
      draft: "",
      commandPalette: undefined,
      permissionPicker: {
        step: "provider",
        providerIndex,
        policyIndex: 0,
      },
      helpOpen: false,
      notice: undefined,
    },
  };
}

function transitionPermissionPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const picker = state.permissionPicker!;
  if (key === "escape") {
    if (picker.step === "policy") {
      return {
        state: {
          ...state,
          permissionPicker: { ...picker, step: "provider" },
          notice: undefined,
        },
      };
    }
    return {
      state: {
        ...state,
        permissionPicker: undefined,
        draft: "",
        notice: undefined,
      },
    };
  }
  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    return {
      state: {
        ...state,
        permissionPicker: picker.step === "provider"
          ? {
              ...picker,
              providerIndex: boundedIndex(
                picker.providerIndex + delta,
                CONFIGURABLE_PERMISSION_PROVIDERS.length,
              ),
            }
          : {
              ...picker,
              policyIndex: boundedIndex(
                picker.policyIndex + delta,
                PERMISSION_POLICIES.length,
              ),
            },
        notice: undefined,
      },
    };
  }
  if (key !== "enter") return { state };
  const provider = CONFIGURABLE_PERMISSION_PROVIDERS[picker.providerIndex]!;
  if (picker.step === "provider") {
    const currentPolicy = permissionPolicy(state, provider);
    return {
      state: {
        ...state,
        permissionPicker: {
          ...picker,
          step: "policy",
          policyIndex: PERMISSION_POLICIES.indexOf(currentPolicy),
        },
        notice: undefined,
      },
    };
  }
  const policy = PERMISSION_POLICIES[picker.policyIndex]!;
  const sandbox = permissionSandbox(state, snapshot);
  const resolved = resolveProviderPermission(provider, policy, sandbox);
  if (!resolved.ok) {
    return {
      state: {
        ...state,
        notice: resolved.message,
        noticeTone: "error",
      },
    };
  }
  const previousPolicy = permissionPolicy(state, provider);
  return {
    state: {
      ...state,
      permissionPicker: undefined,
      permissionPolicies: {
        ...state.permissionPolicies,
        [provider]: policy,
      },
      notice: `${permissionProviderLabel(provider)} permissions: ${resolved.value.nativeMode}`,
      noticeTone: "neutral",
    },
    action: {
      type: "permission-policy",
      provider,
      policy,
      previousPolicy,
    },
  };
}

function renderPermissionPicker(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const picker = state.permissionPicker!;
  const sandbox = permissionSandbox(state, snapshot);
  const provider = CONFIGURABLE_PERMISSION_PROVIDERS[picker.providerIndex]!;
  const lines = [...renderHeader([], state, options), ""];
  if (picker.step === "provider") {
    lines.push("Provider permissions", "");
    lines.push(...CONFIGURABLE_PERMISSION_PROVIDERS.map((candidate, index) => {
      const policy = permissionPolicy(state, candidate);
      const resolved = resolveProviderPermission(candidate, policy, sandbox);
      const nativeMode = resolved.ok ? resolved.value.nativeMode : "unsupported";
      return pickerRow(
        `${permissionProviderLabel(candidate)}  ${policy} · ${nativeMode}`,
        index === picker.providerIndex,
        options.color,
      );
    }));
  } else {
    lines.push(`${permissionProviderLabel(provider)} permission policy`, "");
    lines.push(...PERMISSION_POLICIES.map((policy, index) => {
      const resolved = resolveProviderPermission(provider, policy, sandbox);
      const description = resolved.ok
        ? `${resolved.value.nativeMode}${resolved.value.launchArguments.length === 0
            ? ""
            : ` · ${resolved.value.launchArguments.join(" ")}`}`
        : `unsupported · ${resolved.message}`;
      return pickerRow(
        `${policy}  ${description}`,
        index === picker.policyIndex,
        options.color,
      );
    }));
  }
  const footer = [
    ...(state.notice === undefined
      ? []
      : [renderNotice(state.notice, state.noticeTone, options.width, options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    paint(
      fit("↑↓ select · enter inspect/apply · esc back", options.width),
      "dim",
      options.color,
    ),
  ];
  return renderCursorlessPickerFrame(
    lines,
    footer,
    options.height,
    state.notice === undefined ? 0 : 1,
  );
}

function permissionPolicy(
  state: FleetState,
  provider: ConfigurablePermissionProvider,
): ProviderPermissionPolicy {
  return state.permissionPolicies[provider] ?? DEFAULT_PERMISSION_POLICIES[provider];
}

function permissionSandbox(
  state: FleetState,
  snapshot: FleetSnapshot,
): SessionRecord["sandbox"] {
  return snapshot.threads.find(({ record }) =>
    record.id === state.selectedSessionId)?.record.sandbox ?? "read-only";
}

function openWorkerPicker(state: FleetState, snapshot: FleetSnapshot, returnDraft: string): FleetTransition {
  const cwd = composerCwd(state, snapshot);
  return openWorkerPickerForCwd(state, cwd, returnDraft);
}

function openWorkerPickerForCwd(state: FleetState, cwd: string, returnDraft: string): FleetTransition {
  const current = state.launchProfiles[cwd];
  const choices = state.workerModels.choices;
  const modelIndex = current === undefined
    ? 0
    : Math.max(0, choices.findIndex((choice) =>
      choice.provider === current.provider && choice.model === current.model));
  const choice = choices[modelIndex];
  const effortIndex = current?.effort === undefined || choice === undefined
    ? 0
    : Math.max(0, choice.efforts.indexOf(current.effort));
  return {
    state: {
      ...state,
      draft: "",
      helpOpen: false,
      notice: undefined,
      workerPicker: { step: "model", modelIndex, effortIndex, cwd, returnDraft, filter: "" },
    },
    // Opening the picker is the moment the offer has to be current: Fleet outlives a provider's
    // release, so a list read once at startup is a list that goes stale while the pane stays open.
    action: { type: "worker-capabilities" },
  };
}

/**
 * The rows the picker is showing: every model the providers advertise, narrowed by what was typed.
 *
 * Matched against the slug and the label together, and case-insensitively, because the operator
 * knows the model by whichever of the two they last read.
 */
function pickerModelChoices(state: FleetState): readonly WorkerModelChoice[] {
  const filter = state.workerPicker?.filter.trim().toLowerCase() ?? "";
  if (filter === "") return state.workerModels.choices;
  return state.workerModels.choices.filter((choice) =>
    `${choice.model} ${choice.label} ${choice.provider}`.toLowerCase().includes(filter));
}

/**
 * Type a repository path into the composer row and register it.
 *
 * The draft is sent as typed rather than resolved here: only the broker runs beside the
 * repositories, and a path is not a project until git agrees it is one. Tab completes against the
 * filesystem, which is what makes a long worktree path bearable to type at all.
 *
 * An offered parent turns Enter into an answer: the operator named a worktree, the broker named the
 * repository above it, and pressing Enter takes that repository. Editing the draft withdraws the
 * offer, because the answer no longer belongs to the question.
 */
function transitionProjectPrompt(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const prompt = state.projectPrompt!;
  if (key === "escape") {
    return { state: { ...state, projectPrompt: undefined, notice: undefined } };
  }
  if (key === "enter") {
    if (prompt.parentOffer !== undefined) {
      return {
        state: { ...state, projectPrompt: undefined, notice: undefined },
        action: { type: "project-add", path: prompt.parentOffer.root, acceptParent: true },
      };
    }
    const draft = prompt.draft.trim();
    if (draft === "") {
      return { state: { ...state, notice: "Project path cannot be empty", noticeTone: "error" } };
    }
    return {
      state: { ...state, projectPrompt: undefined, notice: undefined },
      action: { type: "project-add", path: expandPath(draft, composerCwd(state, snapshot)) },
    };
  }
  if (key === "tab") {
    return {
      state: { ...state, projectPrompt: { draft: prompt.draft }, notice: undefined },
      action: { type: "project-complete", draft: prompt.draft },
    };
  }
  if (key === "backspace") {
    return {
      state: {
        ...state,
        projectPrompt: { draft: [...prompt.draft].slice(0, -1).join("") },
        notice: undefined,
      },
    };
  }
  if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
    return {
      state: { ...state, projectPrompt: { draft: `${prompt.draft}${key}` }, notice: undefined },
    };
  }
  return { state };
}

/**
 * The composer while it is a shell. Enter runs the line where Fleet would spawn an agent, esc puts
 * the composer back to dispatching work and drops the transcript with it.
 */
function transitionShellMode(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const shell = state.shellMode!;
  // Both leave, and both leave while a line is still running: the running guard below is about not
  // editing a draft mid-flight, not about trapping the operator inside a command that will not end.
  if (key === "escape" || key === "ctrl+g") {
    return { state: { ...state, shellMode: undefined, notice: undefined } };
  }
  // A line already in flight owns the shell. Typing into it would edit a draft the operator cannot
  // see the effect of, and Enter would race two commands into one cwd.
  if (shell.running === true) return { state };
  if (key === "enter") {
    const command = shell.draft.trim();
    if (command === "") return { state };
    return {
      state: {
        ...state,
        shellMode: {
          draft: "",
          running: true,
          // The echoed line, then the open row its output extends.
          transcript: [...capShellTranscript(shell.transcript), `! ${command}`, ""],
        },
        notice: undefined,
      },
      action: { type: "shell-run", command, cwd: composerCwd(state, snapshot) },
    };
  }
  if (key === "ctrl+j" || key === "alt+enter" || key === "shift+enter") {
    return { state: { ...state, shellMode: { ...shell, draft: `${shell.draft}\n` }, notice: undefined } };
  }
  if (key === "backspace") {
    return {
      state: {
        ...state,
        shellMode: { ...shell, draft: [...shell.draft].slice(0, -1).join("") },
        notice: undefined,
      },
    };
  }
  if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
    return {
      state: { ...state, shellMode: { ...shell, draft: `${shell.draft}${key}` }, notice: undefined },
    };
  }
  return { state };
}

/** How much shell output Fleet keeps. Older rows are dropped from the top, never from the tail. */
const SHELL_TRANSCRIPT_LINES = 500;

function capShellTranscript(transcript: readonly string[]): readonly string[] {
  return transcript.length <= SHELL_TRANSCRIPT_LINES
    ? transcript
    : transcript.slice(transcript.length - SHELL_TRANSCRIPT_LINES);
}

/**
 * Folds one chunk of shell output into the transcript. The last element is the row the shell has
 * left open, so a chunk that does not begin at a line boundary extends it rather than starting a
 * new one — output arrives in whatever sizes the pipe hands over, not in lines.
 */
export function appendShellOutput(
  transcript: readonly string[],
  chunk: string,
): readonly string[] {
  const text = stripTerminalControl(chunk)
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/\t/gu, "  ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  if (text === "") return transcript;
  const segments = text.split("\n");
  const lines = transcript.length === 0 ? [""] : [...transcript];
  lines[lines.length - 1] = `${lines[lines.length - 1] ?? ""}${segments[0] ?? ""}`;
  for (const segment of segments.slice(1)) lines.push(segment);
  return capShellTranscript(lines);
}

function transitionWorkerPicker(state: FleetState, key: string): FleetTransition {
  const picker = state.workerPicker!;
  const choices = pickerModelChoices(state);
  if (key === "escape") {
    if (picker.step === "effort") {
      return { state: { ...state, workerPicker: { ...picker, step: "model" }, notice: undefined } };
    }
    return { state: { ...state, workerPicker: undefined, draft: picker.returnDraft, notice: undefined } };
  }
  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    if (picker.step === "model") {
      return {
        state: {
          ...state,
          workerPicker: {
            ...picker,
            modelIndex: boundedIndex(picker.modelIndex + delta, choices.length),
            effortIndex: 0,
          },
        },
      };
    }
    const selected = choices[picker.modelIndex];
    if (selected === undefined) return { state };
    return {
      state: {
        ...state,
        workerPicker: {
          ...picker,
          effortIndex: boundedIndex(picker.effortIndex + delta, selected.efforts.length),
        },
      },
    };
  }
  if (picker.step === "model" && (key === "backspace" || ([...key].length === 1 && key.charCodeAt(0) >= 0x20))) {
    const filter = key === "backspace"
      ? [...picker.filter].slice(0, -1).join("")
      : `${picker.filter}${key}`;
    // The cursor returns to the top of whatever the narrowed list now is; keeping an index across
    // a changed list points it at a model the operator never selected.
    return { state: { ...state, workerPicker: { ...picker, filter, modelIndex: 0, effortIndex: 0 } } };
  }
  if (key !== "enter") return { state };
  const choice = choices[picker.modelIndex];
  if (choice === undefined) {
    return {
      state: {
        ...state,
        notice: picker.filter === "" ? "No models are advertised" : `No model matches ${picker.filter}`,
        noticeTone: "error",
      },
    };
  }
  if (picker.step === "model") {
    return { state: { ...state, workerPicker: { ...picker, step: "effort", effortIndex: 0 } } };
  }
  const effort = choice.efforts[picker.effortIndex]!;
  const isolation = state.launchProfiles[picker.cwd]?.isolation;
  const profile: LaunchProfile = {
    provider: choice.provider,
    model: choice.model,
    ...(effort === "provider-managed" ? {} : { effort }),
    // Choosing a model is not choosing to share the operator's checkout again. Isolation is a
    // property of the folder, so it survives every re-pick of what runs in it.
    ...(isolation === undefined ? {} : { isolation }),
  };
  return {
    state: {
      ...state,
      workerPicker: undefined,
      draft: picker.returnDraft,
      launchProfiles: { ...state.launchProfiles, [picker.cwd]: profile },
      notice: `Selected ${choice.label} · ${friendlyEffort(effort)}`,
      noticeTone: "neutral",
    },
    action: { type: "profile", cwd: picker.cwd, profile },
  };
}

/**
 * Adopt a freshly read model catalog without moving the operator's selection.
 *
 * The catalog can land while the picker is open — that is the point of refreshing on open — so the
 * row under the cursor is re-found by provider and slug rather than by position. A model that is no
 * longer advertised has no row to keep, and the cursor goes to the top of the list that does exist.
 */
export function adoptWorkerModels(state: FleetState, workerModels: WorkerModelCatalog): FleetState {
  const picker = state.workerPicker;
  if (picker === undefined) return { ...state, workerModels };
  const selected = pickerModelChoices(state)[picker.modelIndex];
  const next = { ...state, workerModels };
  if (selected === undefined) return next;
  const modelIndex = pickerModelChoices(next).findIndex((choice) =>
    choice.provider === selected.provider && choice.model === selected.model);
  return modelIndex === -1
    ? { ...next, workerPicker: { ...picker, step: "model", modelIndex: 0, effortIndex: 0 } }
    : { ...next, workerPicker: { ...picker, modelIndex } };
}

/**
 * Keep the selected row on screen. The model list is longer than a terminal — Cursor alone
 * contributes one entry per model-and-effort pair — so without a window the selection walks off the
 * bottom and the picker stops responding to the eye. Derived from the index rather than stored, so
 * there is no second cursor that can disagree with the selection.
 */
function pickerScrollOffset(selectedIndex: number, total: number, visibleRows: number): number {
  const centered = selectedIndex - Math.floor(visibleRows / 2);
  return Math.max(0, Math.min(centered, total - visibleRows));
}

function renderWorkerPicker(state: FleetState, options: ResolvedFleetRenderOptions): string {
  const picker = state.workerPicker!;
  const choices = pickerModelChoices(state);
  const choice = choices[picker.modelIndex];
  const lines = renderHeader([], state, options);
  lines.push("");
  let range = "";
  if (picker.step === "model") {
    lines.push(picker.filter === "" ? "Choose a model" : `Choose a model · ${picker.filter}`, "");
    // Named, not implied: a provider Fleet could not ask is showing a stored list, and the
    // operator has to be able to tell that from a list read a moment ago.
    for (const fallback of state.workerModels.fallbacks) {
      lines.push(paint(
        fit(`~ ${fallback.provider} models are a stored list — ${fallback.reason}`, options.width),
        "muted",
        options.color,
      ));
    }
    if (state.workerModels.fallbacks.length > 0) lines.push("");
    const total = choices.length;
    const visibleRows = Math.max(1, options.height - 3 - lines.length);
    const offset = pickerScrollOffset(picker.modelIndex, total, visibleRows);
    lines.push(...choices.slice(offset, offset + visibleRows).map((model, index) =>
      pickerRow(
        `${model.source === "fallback-catalog" ? "~ " : ""}${model.label}  ${paint(model.provider, "dim", options.color)}`,
        offset + index === picker.modelIndex,
        options.color,
      )));
    if (total === 0) lines.push(paint(`No model matches ${picker.filter}`, "muted", options.color));
    if (total > visibleRows) {
      range = ` · ${offset + 1}-${Math.min(total, offset + visibleRows)} of ${total}`;
    }
  } else if (choice !== undefined) {
    lines.push(`${choice.label} effort`, "");
    lines.push(...choice.efforts.map((effort, index) =>
      pickerRow(friendlyEffort(effort), index === picker.effortIndex, options.color)));
  }
  const heading = choice === undefined ? "No model selected" : choice.label;
  const footer = [
    paint("─".repeat(options.width), "dim", options.color),
    paint(fit(`${heading} · ${shortPath(picker.cwd, options.home)}`, options.width), "muted", options.color),
    paint(
      fit(
        `↑↓ select · enter apply/next · esc back${picker.step === "model" ? " · type to filter" : ""}${range}`,
        options.width,
      ),
      "dim",
      options.color,
    ),
  ];
  return renderCursorlessPickerFrame(lines, footer, options.height);
}

function renderFleetList(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const threads = orderedThreads(snapshot);
  const header = [...renderHeader(threads, state, options), ""];

  // The column only exists once some thread actually has a pull request, so a
  // fleet without `gh` — or without PRs — never pays for it, and it is only ever
  // as wide as the longest number on screen.
  const pullRequestWidth = threads.reduce((widest, { record }) => {
    const summary = options.pullRequests.get(record.id);
    return summary === undefined
      ? widest
      : Math.max(widest, Math.min(PULL_REQUEST_CELL_WIDTH, pullRequestLabel(summary).length));
  }, 0);
  const footer = renderFleetFooter(snapshot, state, options);
  const bodyHeight = Math.max(0, options.height - footer.length);
  const threadListViewportHeight = Math.max(0, bodyHeight - header.length);
  // Shell output takes the list's room while the mode is on. It is the only thing the operator is
  // reading, it is the one surface long enough to hold a `git log`, and esc gives the fleet back.
  if (state.shellMode !== undefined) {
    const transcript = renderShellTranscript(state.shellMode, threadListViewportHeight, options);
    const shellBody = [...header.slice(0, bodyHeight), ...transcript];
    while (shellBody.length < bodyHeight) shellBody.push("");
    return [...shellBody, ...footer].join("\n");
  }
  const rows = fleetListRows(snapshot, state);
  // Same bargain as the pull-request column: a fleet whose leases are all healthy — or whose
  // groups all rolled up — never pays for the column, and it is only as wide as it must be.
  const leaseBadgeWidth = rows.reduce(
    (widest, row) => row.kind === "thread" && row.leaseBadge !== undefined
      ? Math.max(widest, row.leaseBadge.label.length)
      : widest,
    0,
  );
  // Same bargain again: a fleet whose workers all sit at their project roots — no worktrees
  // folded in — never pays for the column at all.
  const worktreeWidth = rows.reduce(
    (widest, row) => row.kind === "thread" && row.worktree !== undefined
      ? Math.max(widest, Math.min(WORKTREE_TAG_WIDTH, row.worktree.length))
      : widest,
    0,
  );
  // And again: a fleet the operator dispatched entirely by hand has no sigil to show, so the
  // column is absent rather than a blank cell every row pays for. Measured with `displayWidth`
  // because the lettered fallback grows past one cell once the glyph alphabet is spent.
  const ownerSigilWidth = rows.reduce(
    (widest, row) => row.kind === "thread" && row.ownerSigil !== undefined
      ? Math.max(widest, displayWidth(row.ownerSigil))
      : widest,
    0,
  );
  const viewportState = scrollFocusedRowIntoView(
    state,
    rows,
    threadListViewportHeight,
  );
  const offset = viewportState.threadListScrollOffset;
  const truncated = rows.length > threadListViewportHeight;
  const visibleRows = rows.slice(offset, offset + threadListViewportHeight);
  const lastVisibleRow = visibleRows.at(-1);
  // A folder header on the last visible line whose contents start below the fold reads as an empty
  // project. Its role heading is part of those contents, so it counts as spilled content too.
  const nextRowKind = rows[offset + visibleRows.length]?.kind;
  const hideOrphanedFolder = lastVisibleRow?.kind === "folder"
    && (nextRowKind === "thread" || nextRowKind === "section")
    && viewportState.focusedFolderCwd !== lastVisibleRow.cwd;
  // Every composed row is clamped to the pane, because a row wider than the pane is soft-wrapped
  // by the terminal into an orphaned fragment line the viewport never counted.
  const listLines = rows.length === 0
    ? renderEmptyFleet(threadListViewportHeight, options)
    : visibleRows.map((row, visibleIndex) => {
        const indicator = truncated
          ? threadListScrollbar(
              visibleIndex,
              offset,
              rows.length,
              threadListViewportHeight,
            )
          : undefined;
        if (hideOrphanedFolder && visibleIndex === visibleRows.length - 1) {
          return indicator === undefined
            ? ""
            : rowGutter(false, options.color, indicator).trimEnd();
        }
        if (row.kind === "folder") {
          return renderFolderRow(
            row.cwd,
            row.threadCount,
            row.label,
            viewportState,
            options,
            indicator,
          );
        }
        if (row.kind === "thread") {
          return renderThreadRow(
            row.thread,
            viewportState,
            options,
            pullRequestWidth,
            leaseBadgeWidth,
            row.leaseBadge,
            worktreeWidth,
            row.worktree,
            indicator,
            ownerSigilWidth,
            row.ownerSigil,
            row.outsideLens ?? false,
          );
        }
        if (row.kind === "show-more") {
          return renderShowMoreRow(row.cwd, row.hiddenCount, viewportState, options, indicator);
        }
        if (row.kind === "section") {
          return `${rowGutter(false, options.color, indicator)}${paint(row.label, "dim", options.color)}`;
        }
        if (row.kind === "ownership") {
          return renderWorkerCoordinationRow(row.coordination, options, indicator);
        }
        return indicator === undefined
          ? ""
          : rowGutter(false, options.color, indicator).trimEnd();
      }).map((line) => clampRowWidth(line, options.width));
  const body = [...header.slice(0, bodyHeight), ...listLines];
  while (body.length < bodyHeight) body.push("");
  return [...body, ...footer].join("\n");
}

/**
 * The tail of the shell transcript, anchored to the bottom: the newest output is the output the
 * operator is waiting for, so a command that overruns the pane scrolls off the top, never the end.
 * An open final row that is still empty is not shown — it is the shell's cursor, not a blank line.
 */
function renderShellTranscript(
  shell: ShellModeState,
  viewportHeight: number,
  options: ResolvedFleetRenderOptions,
): string[] {
  if (viewportHeight <= 0) return [];
  const lines = shell.transcript.at(-1) === ""
    ? shell.transcript.slice(0, -1)
    : shell.transcript;
  if (lines.length === 0) {
    return [paint(fit("No output yet.", options.width), "dim", options.color)];
  }
  return lines
    .slice(Math.max(0, lines.length - viewportHeight))
    .map((line) => clampRowWidth(
      line.startsWith("! ")
        ? `${paint("!", "red", options.color)}${line.slice(1)}`
        : line,
      options.width,
    ));
}

/** The first transcript row visible in the bottom-anchored shell viewport. */
function shellTranscriptScrollOffset(shell: ShellModeState, viewportHeight: number): number {
  const lineCount = shell.transcript.length - (shell.transcript.at(-1) === "" ? 1 : 0);
  return Math.max(0, lineCount - Math.max(0, viewportHeight));
}

function renderFleetFooter(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string[] {
  const threads = orderedThreads(snapshot);
  const selected = threads.find(({ record }) => record.id === state.selectedSessionId);
  const terminal = selected !== undefined && isTerminalSession(selected.record);
  const stopAcknowledged = selected !== undefined
    && state.stopAcknowledgement?.sessionId === selected.record.id;
  const destructiveHint = terminal && stopAcknowledged ? "ctrl+x delete thread" : "ctrl+x stop agent";
  const cwd = composerCwd(state, snapshot);
  const profile = state.launchProfiles[cwd];
  const composerLines = renderComposerLines(
    state.rename?.draft ?? state.projectPrompt?.draft ?? state.shellMode?.draft ?? state.draft,
    state.rename !== undefined
      ? "rename"
      : state.projectPrompt !== undefined
        ? "project"
        : state.shellMode !== undefined ? "shell" : "task",
    options,
  );
  const launchContext = state.shellMode !== undefined
    ? contextLine(
      `▶ ${shellName()} -lc${state.shellMode.running === true ? " · running" : ""}`,
      shortPath(cwd, options.home),
      `enter runs · ${state.shellMode.running === true ? "ctrl+g stops and leaves" : "esc or ctrl+g leaves"}`,
      options.width,
    )
    : profile === undefined
    ? contextLine(
      `▶ /model required · ${selected?.record.sandbox ?? "read-only"}`,
      shortPath(cwd, options.home),
      "ctrl+s change",
      options.width,
    )
    : contextLine(
      `▶ ${friendlyModel(profile.provider, profile.model)} · ${friendlyEffort(profile.effort ?? "provider-managed")} · ${selected?.record.sandbox ?? "read-only"}`,
      shortPath(cwd, options.home),
      "ctrl+s change",
      options.width,
    );
  const helpLines = state.helpOpen === true
    ? shortcutHelp(options.width, terminal && stopAcknowledged ? "delete" : "stop")
    : [];
  const notice = state.notice === undefined
    ? undefined
    : renderNotice(state.notice, state.noticeTone, options.width, options.color);
  const footer = [
    ...(notice === undefined ? [] : [notice]),
    paint("─".repeat(options.width), "dim", options.color),
    ...composerLines,
    paint("─".repeat(options.width), "dim", options.color),
    ...helpLines.map((line) => paint(fit(line, options.width), "dim", options.color)),
    paint(fit(launchContext, options.width), "dim", options.color),
    paint(fit(`↑↓ · pgup/dn · alt+k/j half · home/end · enter open/start · ctrl+] detach/reattach · ctrl+n nvim · ? more · ${destructiveHint}`, options.width), "dim", options.color),
  ];
  if (footer.length <= options.height) return footer;

  // In a pane shorter than the fixed footer, interaction content outranks its chrome and hints.
  // The active composer always owns one row. A fresh notice owns the next row when one exists;
  // height one deliberately keeps the editor because hiding it would make typed interaction blind.
  const noticeRows = notice === undefined || options.height === 1 ? [] : [notice];
  const visibleComposerRows = composerLines.slice(
    -Math.max(1, options.height - noticeRows.length),
  );
  return [...noticeRows, ...visibleComposerRows].slice(-options.height);
}

/** What `!` mode runs the operator's lines through, named so the footer is never a guess. */
function shellName(): string {
  const shell = process.env.SHELL;
  return shell === undefined || shell === "" ? "shell" : basename(shell);
}

/**
 * The empty fleet: the octopus at full size, over the one line of copy that explains it.
 *
 * This is the only surface with room for the whole animal and the only moment nothing is competing
 * for that room, which is the entire argument for spending it here. A viewport too short or too
 * narrow drops the art whole and keeps the sentence — a cropped octopus reads as a rendering fault
 * rather than as art, so there is no partial version of this.
 */
function renderEmptyFleet(
  viewportHeight: number,
  options: ResolvedFleetRenderOptions,
): string[] {
  const caption = "No durable agent threads yet.";
  const width = pixelArtWidth(OCTOPUS_SPLASH);
  const height = pixelArtHeight(OCTOPUS_SPLASH);
  if (viewportHeight < height + 2 || options.width < width) {
    return [caption].slice(0, viewportHeight);
  }
  const center = (span: number) => " ".repeat(Math.max(0, Math.floor((options.width - span) / 2)));
  const indent = center(width);
  return [
    ...renderPixelArt(OCTOPUS_SPLASH, options.color, options.background).map((line) => `${indent}${line}`),
    "",
    `${center(caption.length)}${paint(caption, "dim", options.color)}`,
  ];
}

function renderHeader(
  threads: readonly FleetThread[],
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string[] {
  const statuses = threads.map(threadStatus);
  const count = (status: ThreadStatus) => statuses.filter((candidate) => candidate === status).length;
  // "agents" counts agents that are actually running. Finished threads stay listed as history and
  // that history is now durable across restarts, so counting them here would report a fleet far
  // busier than it is — done means an agent finished a task, not that one is consuming resources.
  const running = threads.filter(({ record }) =>
    record.executionState === "active" || record.executionState === "starting").length;
  const counts = [
    `${running} agents`,
    `${count("Needs input")} needs input`,
    `${count("Working")} working`,
    `${count("Done")} done`,
    ...(count("Interrupted") === 0 ? [] : [`${count("Interrupted")} interrupted`]),
    ...(count("Failed") === 0 ? [] : [`${count("Failed")} failed`]),
  ].join(" · ");
  const orchestrator = threads.find(({ record }) =>
    record.kind === "orchestrator" && record.orchestratorScope === "fleet")?.record
    ?? threads.find(({ record }) =>
      record.kind === "orchestrator" && record.cwd === state.fallbackCwd)?.record
    ?? threads.find(({ record }) => record.kind === "orchestrator")?.record;
  const scope = orchestrator?.orchestratorScope === "fleet"
    ? "fleet"
    : shortPath(orchestrator?.cwd ?? state.fallbackCwd, options.home);
  const context = orchestrator === undefined
    ? `No orchestrator · ctrl+o to choose · ${shortPath(state.fallbackCwd, options.home)}`
    : `${friendlyModel(orchestrator.provider, orchestrator.model)} · ${friendlyEffort(orchestrator.effort ?? "provider-managed")} · ${scope}`;
  // The mark is taller than the three lines of text beside it. Eight pixel rows is the floor at
  // which the octopus is still the octopus — below it the tentacles have nowhere to hang and the
  // silhouette reads as a space invader — so the header is as tall as the animal, not the copy.
  const showsMark = options.width >= 64;
  const markWidth = pixelArtWidth(OCTOPUS_MARK);
  const textWidth = Math.max(1, options.width - (showsMark ? markWidth + 2 : 0));
  const textLines = [
    paint("Cyberdeck", "bold", options.color),
    paint(fit(context, textWidth), "dim", options.color),
    paint(fit(counts, textWidth), "dim", options.color),
  ];
  if (!showsMark) return textLines;
  const mark = renderPixelArt(OCTOPUS_MARK, options.color, options.background);
  return Array.from(
    { length: Math.max(mark.length, textLines.length) },
    (_, index) => `${mark[index] ?? " ".repeat(markWidth)}  ${textLines[index] ?? ""}`,
  );
}

function shortcutHelp(width: number, destructive: "stop" | "delete"): string[] {
  const entries = [
    "pgup/dn page", "alt+k/j half", "home/end", "shift+↑↓ reorder", "←→ fold project",
    "a add project", "d remove project", "ctrl+w switch views",
    "@ mention", "alt+1–9 open", "esc back/clear",
    "ctrl+r rename", "ctrl+j/opt+enter newline", "ctrl+v paste image", "ctrl+] detach/reattach", "ctrl+n nvim (folder: main checkout)", "! shell", "ctrl+s shell popup", "ctrl+t pin to top", "ctrl+d mark for handoff", "/handoff give marked to an orc", "ctrl+l lease detail", `ctrl+x ${destructive}`, "? close",
  ];
  // Wrapping by a count rather than fixed slices is what keeps the last row from silently
  // swallowing every entry added since: a new shortcut costs a row, never another key's visibility.
  const perRow = width >= 110 ? 6 : width >= 70 ? 4 : 1;
  const rows: string[] = [];
  for (let index = 0; index < entries.length; index += perRow) {
    rows.push(entries.slice(index, index + perRow).join("   "));
  }
  return rows;
}

/**
 * Why a worker cannot be handed off, wherever the operator names one.
 *
 * Ctrl+D and the /handoff fallback are the same claim about the same worker, so they answer it the
 * same way rather than letting one gesture accept what the other refuses.
 */
const TERMINAL_HANDOFF_REFUSAL = "A terminal worker cannot be handed off";

/** The marked set. Absent and empty mean the same thing everywhere this is read. */
function handoffMarks(state: FleetState): readonly string[] {
  return state.handoffMarks ?? [];
}

function isHandoffMarked(state: FleetState, sessionId: string): boolean {
  return handoffMarks(state).includes(sessionId);
}

/**
 * Whether this session is still something a handoff could move.
 *
 * One predicate for every place that claims a worker is handoff-able — the mark filter, the
 * /handoff fallback, and the open picker — so a worker that goes away or exits stops being a
 * target everywhere at once instead of surviving in whichever surface forgot to look again.
 */
function isHandoffEligible(threads: readonly FleetThread[], sessionId: string): boolean {
  return threads.some(({ record }) =>
    record.id === sessionId && record.kind !== "orchestrator" && !isTerminalSession(record));
}

/**
 * What a handoff would move: the marked workers when there are any, otherwise the selected one.
 *
 * Marks win over the selection so the operator can mark a batch, move focus while reading the rest
 * of the list, and still hand over what they marked rather than wherever the cursor came to rest.
 * An orchestrator is never a target: it is a controller, not something one controls.
 *
 * The fallback is held to exactly what Ctrl+D would accept, and says so when it refuses. A terminal
 * worker that opened the picker anyway would cost the operator both picker steps and the directive
 * they typed, only for the broker to refuse the batch at the end of it.
 */
function handoffTargets(
  state: FleetState,
  snapshot: FleetSnapshot,
): { workerIds: string[]; refusal?: string } {
  const marked = handoffMarks(state);
  if (marked.length > 0) return { workerIds: [...marked] };
  const selected = orderedThreads(snapshot).find(({ record }) => record.id === state.selectedSessionId);
  if (selected === undefined || selected.record.kind === "orchestrator") return { workerIds: [] };
  if (isTerminalSession(selected.record)) return { workerIds: [], refusal: TERMINAL_HANDOFF_REFUSAL };
  return { workerIds: [selected.record.id] };
}

/**
 * Orchestrators that could act on a handoff now.
 *
 * A stopped orchestrator would take the leases and never read the directive, so it is not offered
 * — the broker refuses one anyway, and a picker that lists a choice the broker will reject is a
 * worse way to learn that than not listing it.
 */
function liveOrchestrators(snapshot: FleetSnapshot): SessionRecord[] {
  return existingOrchestrators(snapshot).filter((record) =>
    record.executionState === "active" || record.executionState === "starting");
}

/** Picker hint only. Broker repeats scope validation against durable binding grant. */
function handoffRecipients(snapshot: FleetSnapshot, workerIds: readonly string[]): SessionRecord[] {
  const records = new Map(snapshot.threads.map(({ record }) => [record.id, record]));
  return liveOrchestrators(snapshot).filter((recipient) =>
    recipient.orchestratorScope === "fleet"
    || workerIds.every((workerId) => records.get(workerId)?.cwd === recipient.cwd));
}

function openHandoffPicker(state: FleetState, snapshot: FleetSnapshot): FleetTransition {
  const { workerIds, refusal } = handoffTargets(state, snapshot);
  if (workerIds.length === 0) {
    return {
      state: {
        ...state,
        draft: "",
        commandPalette: undefined,
        notice: refusal ?? "Mark workers with ctrl+d, or select one, before /handoff",
        noticeTone: "warning",
      },
    };
  }
  const recipients = handoffRecipients(snapshot, workerIds);
  if (recipients.length === 0) {
    const anyLive = liveOrchestrators(snapshot).length > 0;
    return {
      state: {
        ...state,
        draft: "",
        commandPalette: undefined,
        notice: anyLive
          ? "No live orchestrator covers every worker workspace"
          : "No live orchestrator to receive a handoff",
        noticeTone: "warning",
      },
    };
  }
  return {
    state: {
      ...state,
      draft: "",
      commandPalette: undefined,
      helpOpen: false,
      notice: undefined,
      handoffPicker: { step: "recipient", workerIds, focusSessionId: recipients[0]!.id },
    },
  };
}

/**
 * Hold the open picker's batch to workers that can still be handed off.
 *
 * The operator agreed to a set of workers when they opened this, but a worker exiting is not the
 * operator changing their mind — and the set outlives both picker steps, so without this a worker
 * that dies mid-gesture reaches the broker, which refuses the whole batch and takes the typed
 * directive with it. Newly ineligible members are dropped with the same answer ctrl+d gives, the
 * draft and the recipient survive, and a batch with nothing left in it closes the picker.
 */
function transitionHandoffPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const open = state.handoffPicker!;
  const threads = orderedThreads(snapshot);
  const workerIds = open.workerIds.filter((id) => isHandoffEligible(threads, id));
  if (workerIds.length === 0) {
    return {
      state: {
        ...state,
        handoffPicker: undefined,
        notice: TERMINAL_HANDOFF_REFUSAL,
        noticeTone: "warning",
      },
    };
  }
  if (workerIds.length === open.workerIds.length) {
    return transitionOpenHandoffPicker(state, snapshot, key);
  }
  const dropped = open.workerIds.length - workerIds.length;
  const narrowed = { ...open, workerIds };
  const transition = transitionOpenHandoffPicker({ ...state, handoffPicker: narrowed }, snapshot, key);
  return {
    ...transition,
    state: {
      ...transition.state,
      // A notice the step itself raised — an empty directive, a closed picker — is the more
      // specific answer and keeps precedence over the bookkeeping one.
      ...(transition.state.notice === undefined
        ? {
          notice: `${TERMINAL_HANDOFF_REFUSAL}; ${dropped} dropped from this handoff`,
          noticeTone: "warning" as const,
        }
        : {}),
    },
  };
}

/**
 * The handoff picker's two steps: who receives, then what they are told.
 *
 * Escape backs out one step rather than the whole gesture, so correcting the recipient does not
 * cost the directive already typed.
 */
function transitionOpenHandoffPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const picker = state.handoffPicker!;
  if (picker.step === "recipient") {
    if (key === "escape") {
      return { state: { ...state, handoffPicker: undefined, notice: undefined } };
    }
    const recipients = handoffRecipients(snapshot, picker.workerIds);
    // The roster can empty while the picker is open — the recipient stopping is exactly the case
    // this gesture must not paper over — so the picker closes rather than offering nothing.
    if (recipients.length === 0) {
      return {
        state: {
          ...state,
          handoffPicker: undefined,
          notice: liveOrchestrators(snapshot).length > 0
            ? "No live orchestrator covers every worker workspace"
            : "No live orchestrator to receive a handoff",
          noticeTone: "warning",
        },
      };
    }
    const focusIndex = Math.max(
      0,
      recipients.findIndex((record) => record.id === picker.focusSessionId),
    );
    if (key === "up" || key === "down") {
      const next = recipients[boundedIndex(focusIndex + (key === "up" ? -1 : 1), recipients.length)]!;
      return { state: { ...state, handoffPicker: { ...picker, focusSessionId: next.id }, notice: undefined } };
    }
    if (key === "enter") {
      return {
        state: {
          ...state,
          handoffPicker: {
            step: "directive",
            workerIds: picker.workerIds,
            recipientSessionId: recipients[focusIndex]!.id,
            draft: "",
            mutationId: randomUUID(),
          },
          notice: undefined,
        },
      };
    }
    return { state };
  }
  if (key === "escape") {
    return {
      state: {
        ...state,
        handoffPicker: {
          step: "recipient",
          workerIds: picker.workerIds,
          focusSessionId: picker.recipientSessionId,
        },
        notice: undefined,
      },
    };
  }
  if (key === "backspace") {
    return {
      state: {
        ...state,
        handoffPicker: { ...picker, draft: [...picker.draft].slice(0, -1).join("") },
        notice: undefined,
      },
    };
  }
  if (key === "enter") {
    const directive = picker.draft.trim();
    // The directive is the whole point of a directed handoff: leases without one are an adoption,
    // which the orchestrator already has its own tool for.
    if (directive === "") {
      return { state: { ...state, notice: "A handoff needs a directive", noticeTone: "error" } };
    }
    if (directive.length > HANDOFF_LIMITS.directiveChars) {
      return {
        state: {
          ...state,
          notice: `A handoff directive can contain at most ${HANDOFF_LIMITS.directiveChars} characters`,
          noticeTone: "error",
        },
      };
    }
    return {
      state: { ...state, handoffPicker: undefined, notice: undefined },
      action: {
        type: "handoff",
        workerIds: picker.workerIds,
        recipientSessionId: picker.recipientSessionId,
        directive,
        mutationId: picker.mutationId,
      },
    };
  }
  if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
    return {
      state: {
        ...state,
        handoffPicker: { ...picker, draft: `${picker.draft}${key}` },
        notice: undefined,
      },
    };
  }
  return { state };
}

function renderHandoffDirective(
  draft: string,
  options: ResolvedFleetRenderOptions,
): string {
  const prefix = `${paint("›", "bold", options.color)} `;
  const marker = paint(SELECTION_RULE, "selection", options.color);
  const draftWidth = Math.max(
    0,
    options.width - displayWidth("› ") - displayWidth(SELECTION_RULE),
  );
  const visibleDraft = displayWidth(draft) <= draftWidth
    ? draft
    : `…${cutToWidthFromEnd(draft, Math.max(0, draftWidth - 1))}`;
  return `${prefix}${visibleDraft}${marker}`;
}

function renderHandoffPicker(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const picker = state.handoffPicker!;
  const threads = orderedThreads(snapshot);
  const lines = [
    ...renderHeader(threads, state, options),
    "",
    paint(`Handoff  ${picker.step === "recipient" ? 1 : 2} of 2`, "dim", options.color),
    "",
    `Workers (${picker.workerIds.length})`,
    "",
    // A worker that disappeared between marking and sending is named as gone rather than dropped:
    // the batch is all-or-nothing, so the operator should see the member that will refuse it.
    ...picker.workerIds.map((workerId) => {
      const record = threads.find(({ record: candidate }) => candidate.id === workerId)?.record;
      const short = paint(workerId.slice(0, 8), "dim", options.color);
      return record === undefined
        ? `  ${short}  ${paint("gone", "alert", options.color)}`
        : `  ${displayThreadName(record.name ?? `Untitled ${workerId.slice(0, 8)}`)}  ${short}`;
    }),
    "",
  ];
  if (picker.step === "recipient") {
    const recipients = handoffRecipients(snapshot, picker.workerIds);
    const focusIndex = Math.max(
      0,
      recipients.findIndex((record) => record.id === picker.focusSessionId),
    );
    lines.push("Recipient", "");
    lines.push(...recipients.map((record, index) =>
      pickerRow(existingOrchestratorLabel(record, options.color), index === focusIndex, options.color)));
  } else {
    const recipient = threads.find(({ record }) => record.id === picker.recipientSessionId)?.record;
    lines.push(
      `Directive for ${
        recipient === undefined
          ? picker.recipientSessionId.slice(0, 8)
          : displayThreadName(recipient.name ?? "orchestrator")
      }`,
      "",
      // Keep the insertion edge and newest text visible after the directive fills the row. Prefix
      // clamping would freeze the retained row, making later direct keystrokes produce no repaint.
      renderHandoffDirective(picker.draft, options),
    );
  }
  const footer = [
    ...(state.notice === undefined
      ? []
      : [renderNotice(state.notice, state.noticeTone, options.width, options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    paint(
      fit(
        picker.step === "recipient"
          ? "↑↓ select · enter next · esc cancel"
          : "enter hands the workers over · esc back",
        options.width,
      ),
      "dim",
      options.color,
    ),
  ];
  return renderCursorlessPickerFrame(
    lines,
    footer,
    options.height,
    state.notice === undefined ? 0 : 1,
  );
}

/** What the fleet list says about a handoff the broker has already answered. */
function handoffNotice(result: WorkerHandoffResult): string {
  if (!result.committed) {
    const blocker = result.blocked[0];
    return blocker === undefined ? "Handoff refused" : `Handoff refused · ${blocker.detail}`;
  }
  const count = result.transferred.length;
  const moved = `${count} worker${count === 1 ? "" : "s"} handed off`;
  // A committed transfer whose nudge failed is still a committed transfer, and says so: the
  // orchestrator holds the leases and will read the directive on its next worker_events call.
  return result.delivery === "failed" || result.delivery === "not-attempted"
    ? `${moved} · ${result.deliveryDetail ?? "the orchestrator was not nudged"}`
    : moved;
}

function transitionOrchestratorPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
  now: number,
): FleetTransition {
  const picker = state.orchestratorPicker!;
  if (key === "escape") {
    return {
      state: {
        ...state,
        orchestratorPicker: picker.step === "effort"
          ? { step: "target", focus: { kind: "profile", modelIndex: picker.modelIndex } }
          : undefined,
        notice: undefined,
      },
    };
  }

  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    if (picker.step === "target") {
      const existing = existingOrchestrators(snapshot);
      const current = orchestratorFocusIndex(picker.focus, existing);
      // An unresolved focus — its orchestrator was deleted from under the picker — is rescued onto
      // the first row rather than moved relative to a position it no longer has.
      const index = current < 0
        ? 0
        : boundedIndex(current + delta, existing.length + ORCHESTRATOR_MODEL_CHOICES.length);
      return {
        state: {
          ...state,
          orchestratorPicker: { ...picker, focus: orchestratorFocusAt(index, existing) },
        },
      };
    }
    const choice = ORCHESTRATOR_MODEL_CHOICES[picker.modelIndex]!;
    return {
      state: {
        ...state,
        orchestratorPicker: {
          ...picker,
          effortIndex: boundedIndex(picker.effortIndex + delta, choice.provider.efforts.length),
        },
      },
    };
  }

  // Same durable-id target, same graceful-stop/confirm/delete ladder as the fleet list's own
  // ctrl+x — this is a second place to reach it, not a second way to do it. A "New orchestrator"
  // row has no session to stop, so the key is inert there.
  if (key === "ctrl+x" && picker.step === "target") {
    const focus = picker.focus;
    if (focus.kind !== "existing") return { state };
    const selectedExisting = existingOrchestrators(snapshot)
      .find((record) => record.id === focus.sessionId);
    if (selectedExisting === undefined) return { state };
    const terminal = isTerminalSession(selectedExisting);
    const stopAcknowledged = picker.stopAcknowledgement?.sessionId === selectedExisting.id;
    if (!terminal || !stopAcknowledged) {
      return {
        state: {
          ...state,
          orchestratorPicker: {
            ...picker,
            stopAcknowledgement: { sessionId: selectedExisting.id },
            deleteConfirmation: undefined,
          },
          notice: `Stopping ${threadSubject(selectedExisting)}`,
          noticeTone: "warning",
        },
        action: { type: "stop", sessionId: selectedExisting.id },
      };
    }
    const deleteConfirmed = picker.deleteConfirmation?.sessionId === selectedExisting.id
      && picker.deleteConfirmation.expiresAt > now;
    if (deleteConfirmed) {
      return {
        state: {
          ...state,
          orchestratorPicker: { ...picker, deleteConfirmation: undefined },
          notice: undefined,
        },
        action: { type: "delete", sessionId: selectedExisting.id },
      };
    }
    return {
      state: {
        ...state,
        orchestratorPicker: {
          ...picker,
          deleteConfirmation: { sessionId: selectedExisting.id, expiresAt: now + DELETE_CONFIRMATION_MS },
        },
        notice: `Delete ${threadSubject(selectedExisting)}? press ctrl+x again`,
        noticeTone: "confirmation",
      },
    };
  }

  if (key !== "enter") return { state };
  if (picker.step === "target") {
    const focus = picker.focus;
    const existing = existingOrchestrators(snapshot);
    if (focus.kind === "existing") {
      const selectedExisting = existing.find((record) => record.id === focus.sessionId);
      // The row was deleted between the keypress and this snapshot. Enter opens nothing rather
      // than the orchestrator that inherited the position.
      if (selectedExisting === undefined) return { state };
      if (selectedExisting.attachmentState === "controlled") {
        return {
          state: {
            ...state,
            notice: "Orchestrator is in use by another controller",
            noticeTone: "warning",
          },
        };
      }
      // A terminal row is joined, not ignored: Enter resumes it and focuses the cockpit, which is
      // exactly what Enter on a terminal thread does in the fleet list.
      return {
        state: {
          ...state,
          selectedSessionId: selectedExisting.id,
          orchestratorPicker: undefined,
          notice: undefined,
        },
        action: {
          type: "open-orchestrator",
          sessionId: selectedExisting.id,
          cockpitCwd: state.fallbackCwd,
          requiresResume: selectedExisting.executionState !== "active"
            && selectedExisting.executionState !== "starting",
        },
      };
    }
    const modelIndex = focus.modelIndex;
    const choice = ORCHESTRATOR_MODEL_CHOICES[modelIndex];
    if (choice === undefined) {
      return {
        state: {
          ...state,
          notice: "No orchestrator model is available",
          noticeTone: "error",
        },
      };
    }
    return {
      state: {
        ...state,
        orchestratorPicker: { step: "effort", modelIndex, effortIndex: 0 },
        notice: undefined,
      },
    };
  }

  const selection = orchestratorSelection(picker);
  return {
    state: { ...state, orchestratorPicker: undefined, notice: undefined },
    action: {
      type: "create-orchestrator",
      cockpitCwd: state.fallbackCwd,
      request: {
        provider: selection.provider.provider,
        model: selection.model,
        ...(selection.effort === undefined ? {} : { effort: selection.effort }),
        cwd: state.fallbackCwd,
        scope: "fleet",
      },
    },
  };
}

function renderOrchestratorPicker(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const picker = state.orchestratorPicker!;
  const selection = picker.step === "effort" ? orchestratorSelection(picker) : undefined;
  const stepNumber = picker.step === "target" ? 1 : 2;
  const lines = [
    ...renderHeader(orderedThreads(snapshot), state, options),
    "",
    paint(`Orchestrator  ${stepNumber} of 2`, "dim", options.color),
    "",
  ];

  // Set only when the focused row is an existing orchestrator, never a "New orchestrator"
  // profile — that row has nothing for ctrl+x to target, so the hint stays silent on it.
  let destructiveHint: string | undefined;
  if (picker.step === "target") {
    const existing = existingOrchestrators(snapshot);
    const focusIndex = orchestratorFocusIndex(picker.focus, existing);
    lines.push("Existing orchestrators", "");
    if (existing.length === 0) {
      lines.push(paint("  No interactive orchestrators", "dim", options.color));
    } else {
      lines.push(...existing.map((record, index) =>
        pickerRow(existingOrchestratorLabel(record, options.color), index === focusIndex, options.color)));
    }
    lines.push("", "New orchestrator", "");
    lines.push(...ORCHESTRATOR_MODEL_CHOICES.map((choice, index) =>
      pickerRow(
        `${choice.label}  ${paint(choice.provider.label, "dim", options.color)}`,
        existing.length + index === focusIndex,
        options.color,
      )));
    const selectedExisting = existing[focusIndex];
    if (selectedExisting !== undefined) {
      destructiveHint = isTerminalSession(selectedExisting)
        && picker.stopAcknowledgement?.sessionId === selectedExisting.id
        ? "ctrl+x delete"
        : "ctrl+x stop";
    }
  } else {
    lines.push(`${selection!.provider.label} effort`, "");
    lines.push(...selection!.provider.efforts.map((effort, index) =>
      pickerRow(effort === "native-default" ? "Provider managed" : effort, index === picker.effortIndex, options.color)));
  }

  const targetHint = destructiveHint === undefined
    ? "↑↓ select · enter focus/next · esc back"
    : `↑↓ select · enter focus/next · ${destructiveHint} · esc back`;
  const footer = [
    ...(state.notice === undefined ? [] : [renderNotice(state.notice, state.noticeTone, options.width, options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    ...(selection === undefined
      ? []
      : [paint(fit(`${selection.provider.label} · ${selection.model} · ${selection.effort ?? "Provider managed"}`, options.width), "muted", options.color)]),
    paint(
      fit(picker.step === "effort"
        ? "↑↓ select · enter create in cockpit · esc back"
        : targetHint, options.width),
      "dim",
      options.color,
    ),
  ];
  return renderCursorlessPickerFrame(
    lines,
    footer,
    options.height,
    state.notice === undefined ? 0 : 1,
  );
}

function orchestratorSelection(picker: Extract<OrchestratorPickerState, { step: "effort" }>) {
  const choice = ORCHESTRATOR_MODEL_CHOICES[picker.modelIndex]!;
  const provider = choice.provider;
  const effort = provider.efforts[picker.effortIndex]!;
  return {
    provider,
    model: choice.model,
    effort: effort === "native-default" ? undefined : effort,
  };
}

function initialOrchestratorPicker(snapshot: FleetSnapshot, _cwd: string): OrchestratorPickerState {
  return { step: "target", focus: orchestratorFocusAt(0, existingOrchestrators(snapshot)) };
}

/** Where a focus sits in the picker's combined row order, or -1 when its orchestrator is gone. */
function orchestratorFocusIndex(
  focus: OrchestratorPickerFocus,
  existing: readonly SessionRecord[],
): number {
  return focus.kind === "profile"
    ? existing.length + focus.modelIndex
    : existing.findIndex((record) => record.id === focus.sessionId);
}

/** The inverse: the durable focus a row position names, so navigation never stores a position. */
function orchestratorFocusAt(
  index: number,
  existing: readonly SessionRecord[],
): OrchestratorPickerFocus {
  const record = existing[index];
  return record === undefined
    ? { kind: "profile", modelIndex: Math.max(0, index - existing.length) }
    : { kind: "existing", sessionId: record.id };
}

/**
 * Every orchestrator the broker still holds, live or terminal, in the fleet list's own order.
 *
 * Terminal rows stay until they are deleted, exactly as they do in the fleet list. Filtering them
 * out broke the ctrl+x ladder on the real broker: `SessionRegistry.stop()` moves a live
 * orchestrator to cancelled/stopping on the first press, so the row vanished before the second
 * press could arm the delete and the third could run it. A row that cannot be reached is a row
 * that cannot be cleaned up, so retention is now the whole record set and the label carries the
 * state instead.
 */
function existingOrchestrators(snapshot: FleetSnapshot): SessionRecord[] {
  return orderedThreads(snapshot)
    .map(({ record }) => record)
    .filter((record) => record.kind === "orchestrator" && record.role === "orchestrator");
}

function existingOrchestratorLabel(record: SessionRecord, color: boolean): string {
  const name = displayThreadName(
    record.name ?? `${friendlyModel(record.provider, record.model)} orchestrator`,
  );
  const lifecycle = record.attachmentState === "controlled"
    ? paint("in use", "yellow", color)
    : record.executionState === "active"
      ? paint("available", "green", color)
      : record.executionState === "starting"
        ? paint("starting", "green", color)
        // Anything else wears its own outcome rather than a join affordance. A stopped orchestrator
        // sits in this list until it is deleted, and must not read as one waiting to be joined.
        : paint(terminalOrchestratorState(record), "dim", color);
  return `${name}  ${paint(record.id.slice(0, 8), "dim", color)}  ${lifecycle}`;
}

/**
 * The fleet list's own status vocabulary, lowercased for a picker row. Only non-active records
 * reach it, so the `active` branch of {@link threadStatus} — the one that reads the terminal
 * replay — is unreachable and the empty replay below is never consulted.
 */
function terminalOrchestratorState(record: SessionRecord): string {
  return threadStatus({ record, replay: "" }).toLowerCase();
}

function pickerRow(value: string, selected: boolean, color: boolean): string {
  return `${paint(selected ? "›" : "·", selected ? "bold" : "dim", color)} ${selected ? paint(value, "bold", color) : value}`;
}

/**
 * A cursorless picker still needs a visible interaction anchor in a very short pane.
 *
 * Every selected picker row — including the directed-handoff draft — starts with `›`. Keep that
 * row inside the body window, and when the footer itself would consume the pane, spend the first
 * physical row on the selection before retaining as many trailing hints as still fit. This is a
 * visual anchor only; it never turns a picker into a terminal caret owner.
 */
function renderCursorlessPickerFrame(
  lines: readonly string[],
  footer: readonly string[],
  height: number,
  priorityFooterRows = 0,
): string {
  const frameHeight = Math.max(1, height);
  const selectedIndex = lines.findLastIndex((line) =>
    stripTerminalControl(line).startsWith("› "));
  const fallbackIndex = lines.findLastIndex((line) => stripTerminalControl(line).trim() !== "");
  const anchorIndex = Math.max(0, selectedIndex === -1 ? fallbackIndex : selectedIndex);

  if (frameHeight <= footer.length) {
    const footerCapacity = frameHeight - 1;
    const priorityFooter = footer.slice(0, Math.min(priorityFooterRows, footerCapacity));
    const trailingCapacity = footerCapacity - priorityFooter.length;
    const trailingFooter = trailingCapacity === 0
      ? []
      : footer.slice(priorityFooterRows).slice(-trailingCapacity);
    const visibleFooter = [...priorityFooter, ...trailingFooter];
    return [lines[anchorIndex] ?? footer.at(-1) ?? "", ...visibleFooter].join("\n");
  }

  const bodyHeight = frameHeight - footer.length;
  const firstBodyRow = Math.max(
    0,
    Math.min(anchorIndex - bodyHeight + 1, lines.length - bodyHeight),
  );
  const body = lines.slice(firstBodyRow, firstBodyRow + bodyHeight);
  while (body.length < bodyHeight) body.push("");
  return [...body, ...footer].join("\n");
}

function boundedIndex(value: number, length: number): number {
  return Math.max(0, Math.min(length - 1, value));
}

/**
 * Left gutter shared by folder and thread rows. The focused row carries a rule
 * rather than a color change, so the bar reads the same with color disabled.
 */
function rowGutter(
  focused: boolean,
  color: boolean,
  scrollbar?: "track" | "thumb" | undefined,
  marked = false,
): string {
  // The gutter's second cell is blank in every one of its states, which is what lets a handoff
  // mark cost the row no width: no column yields for it, so a marked row and an unmarked one
  // still line up.
  const mark = marked ? paint(HANDOFF_MARK, "selection", color) : " ";
  if (focused) return `${paint(SELECTION_RULE, "selection", color)}${mark}`;
  if (scrollbar === "thumb") return `${paint("┃", "subtle", color)}${mark}`;
  if (scrollbar === "track") return `${paint("│", "dim", color)}${mark}`;
  return marked ? ` ${mark}` : ROW_GUTTER;
}

function threadListScrollbar(
  visibleIndex: number,
  offset: number,
  contentHeight: number,
  viewportHeight: number,
): "track" | "thumb" {
  const thumbHeight = Math.max(1, Math.floor(viewportHeight * viewportHeight / contentHeight));
  const scrollRange = contentHeight - viewportHeight;
  const thumbRange = viewportHeight - thumbHeight;
  const thumbStart = scrollRange === 0
    ? 0
    : Math.round(offset * thumbRange / scrollRange);
  return visibleIndex >= thumbStart && visibleIndex < thumbStart + thumbHeight
    ? "thumb"
    : "track";
}

/**
 * A folder header. Plain by default — paths are structure, not state — and bold
 * when focused. Collapsed folders report how many threads they are hiding. The Orcs
 * section wears the same row under its own name rather than a path.
 */
function renderFolderRow(
  cwd: string,
  threadCount: number,
  heading: string | undefined,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
  scrollbar?: "track" | "thumb" | undefined,
): string {
  const focused = state.focusedFolderCwd === cwd;
  const collapsed = isCollapsed(state, cwd);
  const summary = collapsed
    ? ` · ${threadCount} thread${threadCount === 1 ? "" : "s"}`
    : "";
  const label = fit(
    `${collapsed ? "▸" : "▾"} ${heading ?? shortPath(cwd, options.home)}${summary}`,
    Math.max(1, options.width - ROW_GUTTER.length),
  );
  return `${rowGutter(focused, options.color, scrollbar)}${focused ? paint(label, "bold", options.color) : label}`;
}

/**
 * The folder's hidden remainder, or — once opened — the way back to the capped view. It is
 * a navigable row like the folder header above it, and bolds the same way when focused.
 */
function renderShowMoreRow(
  cwd: string,
  hiddenCount: number,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
  scrollbar?: "track" | "thumb" | undefined,
): string {
  const focused = state.focusedShowMoreCwd === cwd;
  const label = fit(
    hiddenCount === 0 ? "  − show less" : `  + ${hiddenCount} more`,
    Math.max(1, options.width - ROW_GUTTER.length),
  );
  return `${rowGutter(focused, options.color, scrollbar)}${
    focused ? paint(label, "bold", options.color) : paint(label, "dim", options.color)
  }`;
}

function renderThreadRow(
  thread: FleetThread,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
  pullRequestWidth = 0,
  leaseBadgeWidth = 0,
  leaseBadge?: LeaseCustodyBadge | undefined,
  worktreeWidth = 0,
  worktree?: string | undefined,
  scrollbar?: "track" | "thumb" | undefined,
  ownerSigilWidth = 0,
  ownerSigil?: string | undefined,
  outsideLens = false,
): string {
  const selected = !threadFocusInert(state)
    && thread.record.id === state.selectedSessionId;
  const baseTitle = displayThreadName(
    thread.record.name ?? thread.record.role ?? `Untitled ${thread.record.id.slice(0, 8)}`,
  );
  const title = `${thread.record.pinned === true ? "⌃ " : ""}${baseTitle}`;
  const identity = threadIdentity(thread.record);
  const status = threadStatus(thread);
  const age = relativeTime(thread.record.meaningfulUpdatedAt ?? thread.record.updatedAt, options.now);
  const layout = threadRowLayout(
    options.width,
    pullRequestWidth,
    leaseBadgeWidth,
    worktreeWidth,
    ownerSigilWidth,
  );
  const preview = threadPreview(thread, layout.preview);
  const row = [
    `${
      rowGutter(selected, options.color, scrollbar, isHandoffMarked(state, thread.record.id))
    }${statusMarker(status, selected, options.color)}`,
    titleCell(pad(title, layout.title), selected, options.color),
    ...(layout.leaseBadge === 0
      ? []
      : [leaseBadgeCell(leaseBadge, layout.leaseBadge, options.color)]),
    ...(layout.worktree === 0
      ? []
      : [paint(pad(fit(worktree ?? "", layout.worktree), layout.worktree), "subtle", options.color)]),
    paint(pad(identity, layout.identity), "subtle", options.color),
    statusText(pad(status, STATUS_CELL_WIDTH), false, options.color),
    paint(pad(preview, layout.preview), "muted", options.color),
    // The number sits between the preview and the time: right of everything that
    // says what the thread is doing, left of when it last did it.
    ...(layout.pullRequest === 0
      ? []
      : [pullRequestCell(options.pullRequests.get(thread.record.id), layout.pullRequest, options.color)]),
    padStart(age, 5),
    // Provenance closes the row, after when it last moved. Nothing to the right of it competes.
    ...(layout.ownerSigil === 0
      ? []
      : [ownerSigilCell(ownerSigil, layout.ownerSigil, options.color)]),
  ].join(" ");
  return outsideLens ? dimRow(row, options.color) : row;
}

/**
 * How one thread row spends its width.
 *
 * The columns are not equals, and the order they yield in is the whole point of this function.
 * Model and state are what an operator reads a row *for* — which agent is on this, and is it
 * moving — so they are budgeted first and never yield, at any width the fleet supports. The owner
 * sigil joins them: one cell, and losing it does not shrink the row's meaning, it changes it into
 * a claim that the operator dispatched this worker themselves. Title and
 * preview shrink to floors. Of the supplementary columns, the lease conflict/anomaly badge is
 * budgeted before the pull-request number: a contested worker with nowhere to show a badge is
 * invisible unless the operator already knows to open lease detail, and unrelated PR metadata must
 * not be the reason it stays that way. Pull request and worktree name are handed whatever is left
 * over after that and drop out entirely when it does not cover them; the worktree name is last in
 * line because it repeats what the folder above already said.
 *
 * Every input is either the pane width or a column width the caller measured across the whole
 * list, so two rows in the same frame always resolve to the same layout and the columns stay
 * columns.
 */
function threadRowLayout(
  width: number,
  pullRequestWidth: number,
  leaseBadgeWidth: number,
  worktreeWidth: number,
  ownerSigilWidth = 0,
): {
  title: number;
  identity: number;
  leaseBadge: number;
  worktree: number;
  pullRequest: number;
  ownerSigil: number;
  preview: number;
} {
  const wide = width >= WIDE_ROW_WIDTH;
  const identity = wide
    ? Math.min(20, Math.max(NARROW_IDENTITY_CELL_WIDTH, Math.floor(width * 0.15)))
    : NARROW_IDENTITY_CELL_WIDTH;
  // Gutter, marker, age, and the separator between every one of the six cells a row always has,
  // plus the owner sigil and its separator when any row in the frame carries one.
  const reserved = 13 + STATUS_CELL_WIDTH + identity
    + (ownerSigilWidth === 0 ? 0 : ownerSigilWidth + 1);
  let optional = width - reserved - MIN_TITLE_CELL_WIDTH - MIN_PREVIEW_CELL_WIDTH;
  const affordable = (cell: number): number => {
    if (cell === 0 || optional < cell + 1) return 0;
    optional -= cell + 1;
    return cell;
  };
  const leaseBadge = affordable(leaseBadgeWidth);
  const pullRequest = affordable(pullRequestWidth);
  const worktree = affordable(worktreeWidth);
  const spent = reserved
    + (pullRequest === 0 ? 0 : pullRequest + 1)
    + (leaseBadge === 0 ? 0 : leaseBadge + 1)
    + (worktree === 0 ? 0 : worktree + 1);
  const remaining = width - spent;
  const desiredTitle = wide
    ? Math.min(38, Math.max(22, Math.floor(width * 0.28)))
    : Math.min(28, Math.max(16, Math.floor(width * 0.38)));
  const title = Math.min(
    desiredTitle,
    Math.max(MIN_TITLE_CELL_WIDTH, remaining - MIN_PREVIEW_CELL_WIDTH),
  );
  return {
    title,
    identity,
    leaseBadge,
    worktree,
    pullRequest,
    ownerSigil: ownerSigilWidth,
    preview: Math.max(1, remaining - title),
  };
}

/** The title cell. Weight is the only thing it varies: the focused row bolds, the rest recede. */
function titleCell(title: string, selected: boolean, color: boolean): string {
  return paint(title, selected ? "bold" : "muted", color);
}

/**
 * The owner sigil, at the end of the row.
 *
 * It is the last cell but the first one budgeted, so a narrowing pane takes the title and the
 * preview down to their floors before it takes provenance away: a row that has lost its sigil is
 * indistinguishable from one the operator dispatched by hand, which is the one confusion this
 * column exists to end. Dim, never hued — colour in this list carries state.
 */
function ownerSigilCell(sigil: string | undefined, width: number, color: boolean): string {
  if (sigil === undefined) return " ".repeat(width);
  return paint(pad(sigil, width), "subtle", color);
}

/**
 * Hold the whole row at low intensity while the ownership lens is on another Orc.
 *
 * The row is composed first and dimmed afterwards, so every cell keeps the tone it earned and
 * only its weight changes. Each cell resets its own SGR state, and a reset clears dim along with
 * the colour, so dim has to be re-asserted after each one rather than wrapped around the row.
 *
 * With `--no-color` the lens is a no-op, deliberately. Intensity is the only channel it uses, and
 * the alternative — editing what the unselected rows say — would make the filter destructive. The
 * sigils themselves are shapes and survive color-off, so provenance is still readable there.
 */
function dimRow(row: string, color: boolean): string {
  if (!color) return row;
  return `${ANSI.dim}${row.split(ANSI.reset).join(`${ANSI.reset}${ANSI.dim}`)}${ANSI.reset}`;
}

/**
 * A worker's lease custody, at the width of the longest badge on screen. A thread with
 * nothing to report holds the column open and shows nothing, exactly as the pull-request
 * column does.
 */
function leaseBadgeCell(
  badge: LeaseCustodyBadge | undefined,
  width: number,
  color: boolean,
): string {
  if (badge === undefined) return " ".repeat(width);
  return paint(pad(badge.label, width), badge.tone, color);
}

/**
 * The unabridged broker projection, shown only while lease-custody detail is toggled on.
 * The five fields are redundant by design here: this is the line an operator reads when
 * they distrust the badge and want to see which field disagrees with which.
 */
function renderWorkerCoordinationRow(
  coordination: FleetWorkerCoordinationView,
  options: ResolvedFleetRenderOptions,
  scrollbar?: "track" | "thumb" | undefined,
): string {
  const controller = coordination.currentController?.controllerId ?? "none";
  const label = fit(
    `  origin ${coordination.origin.creatorControllerId} · controller ${controller} · lease ${coordination.leaseHealth} · orphaned ${coordination.orphaned ? "yes" : "no"} · adoptable ${coordination.adoptable ? "yes" : "no"}`,
    Math.max(1, options.width - ROW_GUTTER.length),
  );
  const badge = leaseCustodyBadge(leaseCustody(coordination));
  return `${rowGutter(false, options.color, scrollbar)}${paint(label, badge?.tone ?? "subtle", options.color)}`;
}

/**
 * The pull request a thread's own branch produced, as its number in the colour of
 * its state. A thread with no known pull request holds the column open and shows
 * nothing. The number is right-aligned so the column reads as a column even when
 * one thread is at `#7` and another at `#1204`.
 */
function pullRequestCell(
  summary: PullRequestSummary | undefined,
  width: number,
  color: boolean,
): string {
  if (summary === undefined) return " ".repeat(width);
  const label = fit(pullRequestLabel(summary), width);
  return paint(padStart(label, width), pullRequestTone(summary.state), color);
}

/**
 * The preview cell for one row.
 *
 * `record.latestPreview` is the broker's transcript-derived extraction and is re-classified here
 * because records persisted by earlier versions hold raw TUI chrome. The PTY replay is only
 * consulted when nothing better exists, and a session with no reply yet shows its task prompt under
 * an explicit label so it can never be mistaken for something the agent said.
 */
function threadPreview(thread: FleetThread, width: number): string {
  const preview = conversationPreview({
    storedPreview: thread.record.latestPreview,
    replay: thread.replay,
    maxLength: width,
  });
  if (preview.kind !== "prompt") return preview.text;
  const label = "Task: ";
  return `${label}${conversationPreview({
    prompt: preview.text,
    maxLength: Math.max(1, width - label.length),
  }).text}`;
}

/**
 * The status dot. Finished, blocked, failing and live threads each take their own
 * hue, and `Working` also takes the filled glyph so the live thread stays findable
 * with color off. The focused row is already marked by the selection rule, so
 * focus adds weight alone.
 */
function statusMarker(
  status: ThreadStatus,
  selected: boolean,
  color: boolean,
): string {
  const tone = status === "Done"
    ? "done"
    : status === "Needs input"
      ? "attention"
      : status === "Failed"
        ? "alert"
        : status === "Working"
          ? "working"
          : "muted";
  // Both glyphs are one display column, so the marker never shifts the row.
  const glyph = status === "Working" ? "•" : "·";
  const painted = paint(glyph, tone, color);
  return selected ? paint(painted, "bold", color) : painted;
}

function layoutOrchestratorSessionIds(
  snapshot: FleetSnapshot,
  additional?: string | undefined,
): string[] {
  return [...new Set([
    ...snapshot.threads
      .filter(({ record }) => record.kind === "orchestrator")
      .map(({ record }) => record.id),
    ...(additional === undefined ? [] : [additional]),
  ])];
}

/**
 * What the providers advertise, or a stored list that says why it is standing in.
 *
 * The broker is the one place that asks the provider CLIs, so a Fleet that cannot reach it has not
 * learned that a provider offers nothing — it has learned nothing, and the catalog it falls back to
 * is rendered as the snapshot it is.
 */
async function readWorkerModels(client: InteractiveFleetTransport): Promise<WorkerModelCatalog> {
  try {
    return workerModelCatalog(
      await client.request<readonly ResolvedWorkerCapability[]>("worker.capabilities", {}),
    );
  } catch (error) {
    return workerModelCatalog(fallbackWorkerCapabilities(
      `Fleet could not read provider capabilities from the broker: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ));
  }
}

/** Preview polling is the only background repaint source; one sample per interval coalesces it. */
const PREVIEW_REPAINT_INTERVAL_MS = 100;

interface FleetFrameLayout {
  width: number;
  height: number;
  /** Names the viewport position independently of the rows currently occupying it. */
  scrollOffset: string;
  /** Stable while the same kinds of rows occupy the same terminal positions. */
  topology: string;
}

interface RetainedFleetFrame extends FleetFrameLayout {
  rows: readonly string[];
  cursor: { row: number; column: number } | undefined;
}

/**
 * Structural identity for the rendered Fleet surface.
 *
 * Content such as a preview, age, status, selection, or draft is deliberately absent: those are
 * row damage. Row insertion/reordering, footer growth, picker changes, or a column appearing alter
 * where later content lives and therefore force a complete in-place repaint.
 */
function fleetFrameLayout(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): FleetFrameLayout {
  const frame = (topology: unknown, scrollOffset: string): FleetFrameLayout => ({
    width: options.width,
    height: options.height,
    scrollOffset,
    topology: JSON.stringify(topology),
  });
  const sessionIds = orderedThreads(snapshot).map(({ record }) => record.id);
  const noticeRows = state.notice === undefined ? 0 : 1;

  if (state.workerPicker !== undefined) {
    const picker = state.workerPicker;
    const choices = pickerModelChoices(state);
    const fallbackRows = state.workerModels.fallbacks.length
      + (state.workerModels.fallbacks.length === 0 ? 0 : 1);
    const modelPreludeRows = renderHeader([], state, options).length + 3 + fallbackRows;
    const visibleModelRows = Math.max(1, options.height - 3 - modelPreludeRows);
    const modelScrollOffset = picker.step === "model"
      ? pickerScrollOffset(picker.modelIndex, choices.length, visibleModelRows)
      : 0;
    return frame({
      surface: "worker-picker",
      step: picker.step,
      sessions: sessionIds,
      choices: choices.map(({ provider, model }) => `${provider}:${model}`),
      fallbackCount: state.workerModels.fallbacks.length,
      preludeRows: modelPreludeRows,
      footerRows: 3,
    }, `worker-picker:${picker.step}:${modelScrollOffset}`);
  }
  if (state.permissionPicker !== undefined) {
    return frame({
      surface: "permission-picker",
      step: state.permissionPicker.step,
      sessions: sessionIds,
      footerRows: 2 + noticeRows,
    }, `permission-picker:${state.permissionPicker.step}`);
  }
  if (state.commandPalette !== undefined) {
    const composerRows = renderComposerLines(state.draft, "task", options).length;
    return frame({
      surface: "command-palette",
      level: state.commandPalette.level,
      candidates: commandPaletteCandidates(state),
      footerRows: composerRows + 3,
    }, `command-palette:${state.commandPalette.scrollOffset}`);
  }
  if (state.handoffPicker !== undefined) {
    return frame({
      surface: "handoff-picker",
      step: state.handoffPicker.step,
      workers: state.handoffPicker.workerIds,
      recipients: handoffRecipients(snapshot, state.handoffPicker.workerIds).map(({ id }) => id),
      footerRows: 2 + noticeRows,
    }, `handoff-picker:${state.handoffPicker.step}`);
  }
  if (state.orchestratorPicker !== undefined) {
    return frame({
      surface: "orchestrator-picker",
      step: state.orchestratorPicker.step,
      sessions: existingOrchestrators(snapshot).map(({ id }) => id),
      footerRows: 2 + noticeRows + (state.orchestratorPicker.step === "effort" ? 1 : 0),
    }, `orchestrator-picker:${state.orchestratorPicker.step}`);
  }

  const threads = orderedThreads(snapshot);
  const rows = fleetListRows(snapshot, state);
  const pullRequestWidth = threads.reduce((widest, { record }) => {
    const summary = options.pullRequests.get(record.id);
    return summary === undefined
      ? widest
      : Math.max(widest, Math.min(PULL_REQUEST_CELL_WIDTH, pullRequestLabel(summary).length));
  }, 0);
  const leaseBadgeWidth = rows.reduce(
    (widest, row) => row.kind === "thread" && row.leaseBadge !== undefined
      ? Math.max(widest, row.leaseBadge.label.length)
      : widest,
    0,
  );
  const worktreeWidth = rows.reduce(
    (widest, row) => row.kind === "thread" && row.worktree !== undefined
      ? Math.max(widest, Math.min(WORKTREE_TAG_WIDTH, row.worktree.length))
      : widest,
    0,
  );
  const ownerSigilWidth = rows.reduce(
    (widest, row) => row.kind === "thread" && row.ownerSigil !== undefined
      ? Math.max(widest, displayWidth(row.ownerSigil))
      : widest,
    0,
  );
  const footerHeight = renderFleetFooter(snapshot, state, options).length;
  const headerHeight = renderHeader(threads, state, options).length + 1;
  const bodyHeight = Math.max(0, options.height - footerHeight);
  const viewportHeight = Math.max(0, bodyHeight - headerHeight);
  const shellTranscript = state.shellMode === undefined
    ? undefined
    : renderShellTranscript(state.shellMode, viewportHeight, options);
  const rowKeys = state.shellMode === undefined
    ? rows.map((row) => {
        if (row.kind === "folder") return `folder:${row.cwd}`;
        if (row.kind === "thread") return `thread:${row.thread.record.id}`;
        if (row.kind === "show-more") return `show-more:${row.cwd}`;
        if (row.kind === "ownership") return `ownership:${row.coordination.sessionId}`;
        return row.kind;
      })
    : [`shell:${shellTranscript!.length}`];

  return frame({
    surface: state.shellMode === undefined ? "fleet-list" : "shell",
    headerHeight,
    footerHeight,
    rows: rowKeys,
    columns: [pullRequestWidth, leaseBadgeWidth, worktreeWidth, ownerSigilWidth],
  }, state.shellMode === undefined
    ? `fleet-list:${state.threadListScrollOffset}`
    : `shell:${shellTranscriptScrollOffset(state.shellMode, viewportHeight)}`);
}

export async function runFleet(
  client: InteractiveFleetTransport,
  input: FleetInput = process.stdin,
  output: FleetOutput = process.stdout,
  signals: FleetSignals = process,
  runtime: FleetRuntimeOptions = {},
): Promise<void> {
  let snapshot = await collectFleetSnapshot(client);
  let state = createFleetState(snapshot);
  const permissionPreferences = runtime.permissionPreferences
    ?? new ProviderPermissionPreferenceStore(appStateDirectory);
  try {
    state = {
      ...state,
      launchProfiles: await client.request<Record<string, LaunchProfile>>("fleet.preferences", {}),
    };
  } catch {
    // Older brokers and isolated presentation tests have no persisted preference surface.
  }
  try {
    const dispositions = await client.request<Record<string, FolderDisposition>>(
      "fleet.folderDispositions",
      {},
    );
    const keys = Object.entries(dispositions);
    const collapsed = keys.filter(([, disposition]) => disposition.collapsed).map(([key]) => key);
    state = {
      ...state,
      // The unregistered bucket starts folded because it is where anything the registry does not
      // account for lands — scratch directories, one-off clones — and that is a list to open on
      // purpose, not one to read past every time. An explicit unfold is persisted like any other.
      collapsedCwds: dispositions[UNREGISTERED_SECTION_KEY] === undefined
        ? [...collapsed, UNREGISTERED_SECTION_KEY]
        : collapsed,
      expandedCwds: keys.filter(([, disposition]) => disposition.expanded).map(([key]) => key),
    };
  } catch {
    // Same as launch profiles: an unfolded list is the right fallback when nothing was persisted.
  }
  try {
    state = {
      ...state,
      nvimLayoutEnabled: await client.request<boolean>("fleet.nvimLayout", {}),
    };
  } catch {
    // Automatic layout is the local default; an older broker cannot supply a durable opt-out.
  }
  try {
    state = {
      ...state,
      permissionPolicies: {
        ...state.permissionPolicies,
        ...await permissionPreferences.list(),
      },
    };
  } catch (error) {
    state = {
      ...state,
      notice: `Could not load permission preferences: ${
        error instanceof Error ? error.message : String(error)
      }`,
      noticeTone: "error",
    };
  }
  if (input.isTTY !== true) {
    output.write(`${renderFleet(snapshot, state, { color: false, width: output.columns, height: output.rows })}\n`);
    client.close();
    return;
  }
  // One OSC 11 round trip, before the key decoder owns stdin, asks what the octopus is sitting
  // on. Silence — an older terminal, a tmux that will not forward — costs the timeout once and
  // means unknown, which renders exactly as it always has.
  const terminalBackground = await queryTerminalBackground(input, output);
  // workerModels feeds only the interactive composer's model picker — the list rendering above
  // never reads it. Probing for it runs the provider listing CLIs (WorkerCapabilityCatalog), which
  // can hold a cold broker for the full capability-probe timeout, so a piped snapshot must never
  // reach this line.
  state = { ...state, workerModels: await readWorkerModels(client) };
  let nvimLayoutHookInstalled = false;
  if (state.nvimLayoutEnabled && runtime.nvimLayoutHooks !== undefined) {
    try {
      await runtime.nvimLayoutHooks.install(layoutOrchestratorSessionIds(snapshot));
      nvimLayoutHookInstalled = true;
    } catch (error) {
      state = {
        ...state,
        notice: `Could not install automatic nvim layout: ${
          error instanceof Error ? error.message : String(error)
        }`,
        noticeTone: "error",
      };
    }
  }

  // Probing is an interactive affordance: a piped fleet renders once, before
  // any out-of-band probe could land, so it never pays the subprocess cost.
  const pullRequestStatus = runtime.pullRequestStatus
    ?? (output.isTTY === true ? new PullRequestStatusCache() : NO_PULL_REQUEST_STATUS);
  // Pasted images land beside the rest of the fleet's state so a worker in any worktree can read
  // the path it is handed, and so one directory bounds every image the operator ever pastes.
  const pasteboardImage = runtime.pasteboardImage
    ?? (() => capturePasteboardImage({ directory: join(appStateDirectory, "pasted-images") }));

  const previousRawMode = input.isRaw === true;
  /**
   * The visible rows last written to the pane, separate from the caret that was parked over them.
   * Keeping rows as rows is what makes a preview delta cost one addressed row instead of the whole
   * pane. Undefined means the terminal's contents or geometry are unknown — before the first
   * frame, after an excursion off the alternate screen, and after a resize reflowed it.
   */
  let paintedFrame: RetainedFleetFrame | undefined;
  const enterFleetScreen = () => {
    output.write(ENTER_FLEET_SCREEN);
    paintedFrame = undefined;
  };
  /**
   * Paint one visible frame, caret hidden for the whole write.
   *
   * Stable geometry takes the damage path: compare retained rows, address each changed row
   * absolutely, and rewrite only that row. `ESC[K` removes a longer predecessor's tail, except on
   * an exact-width row where the terminal's pending wrap leaves the caret on the last glyph and an
   * erase would remove it. Geometry, scroll, and layout-topology changes repaint every row; only
   * unknown geometry clears first, preserving the no-black-frame behaviour of in-place repainting.
   */
  const writeFrame = (
    body: string,
    cursor: { row: number; column: number } | undefined,
    layout: FleetFrameLayout,
  ) => {
    // Absolute row addressing is sound only when one logical row occupies one physical terminal
    // row. Most Fleet surfaces already fit their content, but picker drafts and dashboard fields
    // can contain arbitrary-width values; clamp at the write boundary so none can soft-wrap behind
    // the damage renderer's retained geometry. In a pane shorter than a surface's fixed footer,
    // retain only one physical-height window, keeping the active composer cursor in view.
    const renderedRows = body.split("\n");
    const maximumFirstRow = Math.max(0, renderedRows.length - layout.height);
    const firstRow = cursor === undefined
      ? 0
      : Math.min(maximumFirstRow, Math.max(0, cursor.row - layout.height));
    const rows = renderedRows
      .slice(firstRow, firstRow + layout.height)
      .map((row) => clampRowWidth(row, layout.width));
    const frameCursor = cursor !== undefined
      && cursor.row > firstRow
      && cursor.row <= firstRow + rows.length
      ? {
          row: cursor.row - firstRow,
          column: Math.max(1, Math.min(cursor.column, layout.width)),
        }
      : undefined;
    const retainedLayout = {
      ...layout,
      // The tiny-pane row window is a viewport offset too. If it moves, take the same mandatory
      // full-repaint path as every other scroll offset instead of treating shifted rows as damage.
      scrollOffset: JSON.stringify([layout.scrollOffset, firstRow]),
    };
    const previous = paintedFrame;
    const dimensionsChanged = previous !== undefined
      && (previous.width !== retainedLayout.width || previous.height !== retainedLayout.height);
    const fullRepaint = previous === undefined
      || dimensionsChanged
      || previous.topology !== retainedLayout.topology
      || previous.scrollOffset !== retainedLayout.scrollOffset
      || previous.rows.length !== rows.length;
    const dirtyRows = fullRepaint
      ? rows.map((_, index) => index)
      : rows.flatMap((row, index) => row === previous.rows[index] ? [] : [index]);
    const cursorUnchanged = previous?.cursor?.row === frameCursor?.row
      && previous?.cursor?.column === frameCursor?.column;
    if (dirtyRows.length === 0 && cursorUnchanged) return;

    const caret = frameCursor === undefined
      ? ""
      : `\u001b[${frameCursor.row};${frameCursor.column}H\u001b[?25h`;
    const paintRow = (row: string) =>
      printedWidth(row) < layout.width ? `${row}\u001b[K` : row;
    let damage: string;
    if (fullRepaint) {
      const clear = previous === undefined || dimensionsChanged ? "\u001b[2J" : "";
      const below = !dimensionsChanged && previous !== undefined && previous.rows.length > rows.length
        ? `\u001b[${rows.length + 1};1H\u001b[0J`
        : "";
      damage = `${clear}\u001b[H${rows.map(paintRow).join("\n")}${below}`;
    } else {
      damage = dirtyRows
        .map((index) => `\u001b[${index + 1};1H${paintRow(rows[index]!)}`)
        .join("");
    }
    output.write(`\u001b[?25l${damage}${caret}`);
    paintedFrame = { ...retainedLayout, rows, cursor: frameCursor };
  };
  let stopped = false;
  let attaching = false;
  let wake: (() => void) | undefined;
  // A key/action can finish in the narrow gap between painting and registering the next waiter.
  // Remember that wake so direct interaction never falls through to the preview sampling timer.
  let wakePending = false;
  let inputQueue = Promise.resolve();
  const keyDecoder = new FleetKeyDecoder();
  let decoderFlushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set while a `!` line is running, so the key that leaves the shell can reach it. */
  let shellInterrupt: AbortController | undefined;
  const notify = () => {
    if (wake === undefined) {
      wakePending = true;
      return;
    }
    wake();
  };
  const waitForNextFrame = () => waitForRefresh(
    (resume) => {
      if (wakePending) {
        wakePending = false;
        resume();
      } else {
        wake = resume;
      }
    },
    () => { wake = undefined; },
  );
  const stop = () => {
    stopped = true;
    if (attaching) client.close();
    notify();
  };
  const unsubscribeClose = client.onClose(stop);

  const openNativeThread = async (sessionId: string) => {
    attaching = true;
    notify();
    keyDecoder.reset();
    if (decoderFlushTimer !== undefined) clearTimeout(decoderFlushTimer);
    input.off("data", onInput);
    input.pause?.();
    input.setRawMode?.(false);
    output.write(`${LEAVE_FLEET_SCREEN}\u001b[2J\u001b[H`);
    try {
      const status = await attachSession({
        sessionId,
        mode: "control",
        transport: client,
        input,
        output,
        signals,
        closeTransport: false,
        ...(runtime.detachIdentity === undefined ? {} : { detachIdentity: runtime.detachIdentity }),
      });
      if (status !== 0) state = { ...state, notice: "Provider attachment closed unexpectedly", noticeTone: "error" };
    } catch (error) {
      state = { ...state, notice: error instanceof Error ? error.message : String(error), noticeTone: "error" };
    } finally {
      attaching = false;
      if (!stopped) {
        input.setRawMode?.(true);
        input.on("data", onInput);
        input.resume?.();
        enterFleetScreen();
        snapshot = await collectFleetSnapshot(client);
      }
      notify();
    }
  };

  const openOrchestrator = async (target: OrchestratorCockpitTarget) => {
    if (runtime.openOrchestrator === undefined) {
      throw new Error("Orchestrator cockpit presentation is unavailable in this client");
    }
    attaching = true;
    notify();
    keyDecoder.reset();
    if (decoderFlushTimer !== undefined) clearTimeout(decoderFlushTimer);
    input.off("data", onInput);
    input.pause?.();
    input.setRawMode?.(false);
    output.write(`${LEAVE_FLEET_SCREEN}\u001b[2J\u001b[H`);
    try {
      const session = await runtime.openOrchestrator(target);
      state = { ...state, selectedSessionId: session.id, notice: undefined };
      if (nvimLayoutHookInstalled) {
        await runtime.nvimLayoutHooks?.rebalance(
          layoutOrchestratorSessionIds(snapshot, session.id),
        );
      }
    } finally {
      attaching = false;
      if (!stopped) {
        input.setRawMode?.(true);
        input.on("data", onInput);
        input.resume?.();
        enterFleetScreen();
        snapshot = await collectFleetSnapshot(client);
      }
      notify();
    }
  };

  const perform = async (key: string) => {
    const width = Math.max(1, output.columns ?? 120);
    const height = Math.max(1, output.rows ?? 32);
    const renderOptions: ResolvedFleetRenderOptions = {
      color: output.isTTY === true,
      width,
      height,
      now: Date.now(),
      home: homedir(),
      pullRequests: pullRequestStatus.states(),
      background: terminalBackground,
    };
    state = normalizeThreadListViewport(snapshot, state, renderOptions);
    const transition = transitionFleet(
      state,
      snapshot,
      key,
      renderOptions.now,
      threadListViewportHeight(snapshot, state, renderOptions),
    );
    state = transition.state;
    const action = transition.action;
    if (action?.type === "quit") {
      stop();
      return;
    }
    try {
      if (action?.type === "stop") {
        await client.request("session.stopOne", { sessionId: action.sessionId });
        state = {
          ...state,
          notice: "Stopping thread",
          noticeTone: "warning",
        };
      } else if (action?.type === "delete") {
        const selectedIndex = Math.max(
          0,
          orderedThreads(snapshot).findIndex(({ record }) => record.id === action.sessionId),
        );
        // Deleting the focused row is the one moment the picker's focus cannot survive as an id.
        // Its position in the pre-delete list is read here so focus can land on the neighbour the
        // row leaves behind, and is turned straight back into an id below.
        const picker = state.orchestratorPicker;
        const pickerIndex = picker?.step === "target"
          && picker.focus.kind === "existing"
          && picker.focus.sessionId === action.sessionId
          ? existingOrchestrators(snapshot).findIndex((record) => record.id === action.sessionId)
          : -1;
        await client.request("session.delete", { sessionId: action.sessionId });
        snapshot = await collectFleetSnapshot(client);
        const remaining = orderedThreads(snapshot);
        const remainingExisting = existingOrchestrators(snapshot);
        state = {
          ...state,
          selectedSessionId: remaining[selectedIndex]?.record.id ?? remaining[selectedIndex - 1]?.record.id,
          notice: "Deleted thread",
          noticeTone: "neutral",
          ...(picker?.step === "target" && pickerIndex >= 0
            ? {
                orchestratorPicker: {
                  ...picker,
                  focus: orchestratorFocusAt(
                    remainingExisting[pickerIndex] !== undefined
                      ? pickerIndex
                      : Math.max(0, pickerIndex - 1),
                    remainingExisting,
                  ),
                  stopAcknowledgement: undefined,
                  deleteConfirmation: undefined,
                },
              }
            : {}),
        };
      } else if (action?.type === "attach") {
        await openNativeThread(action.sessionId);
      } else if (action?.type === "resume") {
        await client.request<SessionRecord>("session.resume", { sessionId: action.sessionId });
        snapshot = await collectFleetSnapshot(client);
        await openNativeThread(action.sessionId);
      } else if (action?.type === "start") {
        const record = await startFleetSession(client, action);
        state = { ...state, selectedSessionId: record.id };
        snapshot = await collectFleetSnapshot(client);
        await openNativeThread(record.id);
      } else if (action?.type === "open-orchestrator") {
        const session = snapshot.threads.find(({ record }) => record.id === action.sessionId)?.record;
        if (session === undefined) throw new Error("Selected orchestrator is no longer available");
        await openOrchestrator({
          type: "existing",
          session,
          cockpitCwd: action.cockpitCwd,
          requiresResume: action.requiresResume,
        });
      } else if (action?.type === "create-orchestrator") {
        await openOrchestrator({
          type: "create",
          request: action.request,
          cockpitCwd: action.cockpitCwd,
        });
      } else if (action?.type === "fable-workers") {
        const result = await client.request<FableWorkersResult>(
          "orchestrator.fableWorkers",
          action.request,
        );
        state = {
          ...state,
          notice: grantToggleNotice("Fable workers", result),
          noticeTone: "neutral",
        };
      } else if (action?.type === "caveman-workers") {
        const result = await client.request<CavemanWorkersResult>(
          "orchestrator.cavemanWorkers",
          action.request,
        );
        state = { ...state, notice: cavemanWorkersNotice(result), noticeTone: "neutral" };
      } else if (action?.type === "nvim-layout") {
        if (runtime.nvimLayoutHooks === undefined) {
          throw new Error("Automatic nvim layout is unavailable in this Fleet client");
        }
        const orchestratorSessionIds = layoutOrchestratorSessionIds(snapshot);
        if (action.enabled) {
          await runtime.nvimLayoutHooks.install(orchestratorSessionIds);
          nvimLayoutHookInstalled = true;
          try {
            await client.request("fleet.nvimLayout.set", { enabled: true });
          } catch (error) {
            await runtime.nvimLayoutHooks.remove();
            nvimLayoutHookInstalled = false;
            throw error;
          }
        } else {
          await runtime.nvimLayoutHooks.remove();
          nvimLayoutHookInstalled = false;
          try {
            await client.request("fleet.nvimLayout.set", { enabled: false });
          } catch (error) {
            await runtime.nvimLayoutHooks.install(orchestratorSessionIds);
            nvimLayoutHookInstalled = true;
            throw error;
          }
        }
        state = {
          ...state,
          nvimLayoutEnabled: action.enabled,
          notice: `Automatic nvim layout: ${action.enabled ? "ON" : "OFF"}`,
          noticeTone: "neutral",
        };
      } else if (action?.type === "rename") {
        await client.request("session.rename", { sessionId: action.sessionId, name: action.name });
      } else if (action?.type === "pin") {
        await client.request("session.togglePin", { sessionId: action.sessionId });
      } else if (action?.type === "reorder") {
        await client.request("session.reorder", {
          sessionId: action.sessionId,
          direction: action.direction,
        });
      } else if (action?.type === "profile") {
        await client.request("fleet.preference.set", { cwd: action.cwd, profile: action.profile });
      } else if (action?.type === "handoff") {
        const result = await client.request<WorkerHandoffResult>("fleet.workerHandoff", {
          recipientSessionId: action.recipientSessionId,
          workerIds: action.workerIds,
          directive: action.directive,
          mutationId: action.mutationId,
        });
        state = {
          ...state,
          // Marks are cleared only by a transfer that actually happened. A refused batch leaves the
          // operator holding exactly what they marked, to fix and retry or to unmark.
          ...(result.committed ? { handoffMarks: [] } : {}),
          notice: handoffNotice(result),
          noticeTone: result.committed
            ? result.delivery === "delivered" || result.delivery === "pending" ? "neutral" : "warning"
            : "error",
        };
      } else if (action?.type === "worker-capabilities") {
        state = adoptWorkerModels(state, await readWorkerModels(client));
      } else if (action?.type === "folder-disposition") {
        await client.request("fleet.folderDisposition.set", {
          key: action.cwd,
          disposition: action.disposition,
        });
      } else if (action?.type === "permission-policy") {
        await permissionPreferences.set(action.provider, action.policy);
      } else if (action?.type === "open-worktree") {
        if (runtime.openWorktree === undefined) {
          throw new Error("nvim worktree navigation is unavailable in this client");
        }
        const session = snapshot.threads.find(({ record }) => record.id === action.sessionId)?.record;
        if (session === undefined) throw new Error("Selected worker is no longer available");
        state = {
          ...state,
          notice: await runtime.openWorktree(session, {
            enabled: state.nvimLayoutEnabled,
            orchestratorSessionIds: layoutOrchestratorSessionIds(snapshot),
          }),
          noticeTone: "neutral",
        };
      } else if (action?.type === "open-checkout") {
        if (runtime.openCheckout === undefined) {
          throw new Error("nvim worktree navigation is unavailable in this client");
        }
        state = {
          ...state,
          notice: await runtime.openCheckout(
            action.cwd,
            {
              enabled: state.nvimLayoutEnabled,
              orchestratorSessionIds: layoutOrchestratorSessionIds(snapshot),
            },
            // Every thread, not the folder's own rows: which of them is running *in* the checkout is
            // the open's question to answer, and it answers it from the same truth Fleet renders.
            snapshot.threads.map(({ record }) => record),
          ),
          noticeTone: "neutral",
        };
      } else if (action?.type === "attach-clipboard-image") {
        const image = await pasteboardImage();
        if (image.status === "captured") {
          const target = state.launchProfiles[composerCwd(state, snapshot)]?.provider;
          if (target !== undefined && !providerAcceptsImages(target)) {
            // Only reachable when the profile changed between the chord and the capture. The file
            // is on disk either way; what it must not do is enter a draft bound for a CLI that
            // will read it as words.
            state = { ...state, notice: imageInputRefusal(target), noticeTone: "error" };
          } else {
            // The notice names the mechanism, not just the file. A path Claude opens with its file
            // reader and a path Codex attaches with `-i` are both honest deliveries and are not the
            // same delivery, and the operator is the one who has to know which they just got.
            state = {
              ...state,
              draft: draftWithImageReference(state.draft, image.path),
              notice: `Attached ${basename(image.path)} — ${
                target === undefined ? "worker not chosen yet" : providerImageMechanism(target)
              }`,
              noticeTone: "neutral",
            };
          }
        } else if (image.status === "unavailable") {
          // The pasteboard was never read, so whether it held a screenshot is unknown. Saying so is
          // the whole point: the quiet branch below is for a pasteboard that answered "nothing".
          state = {
            ...state,
            notice: `Could not read the clipboard: ${image.reason}`,
            noticeTone: "error",
          };
        }
      } else if (action?.type === "project-add") {
        const result = await client.request<FleetProjectAddResult>("fleet.project.add", {
          path: action.path,
          ...(action.acceptParent === true ? { acceptParent: true } : {}),
        });
        if (result.status === "worktree") {
          // Nothing was written. The prompt comes back holding the broker's answer so Enter means
          // the repository, and any other key means the operator is still typing.
          state = {
            ...state,
            projectPrompt: {
              draft: action.path,
              parentOffer: { root: result.root, toplevel: result.toplevel },
            },
            notice: `${shortPath(result.toplevel, renderOptions.home)} is a worktree of ${shortPath(result.root, renderOptions.home)} — enter registers the repository, esc cancels`,
            noticeTone: "confirmation",
          };
        } else {
          snapshot = await collectFleetSnapshot(client);
          state = {
            ...state,
            notice: result.alreadyRegistered
              ? `Already a project: ${shortPath(result.root, renderOptions.home)}`
              : `Registered project ${shortPath(result.root, renderOptions.home)}`,
            noticeTone: "neutral",
          };
        }
      } else if (action?.type === "project-remove") {
        const result = await client.request<FleetProjectRemoveResult>("fleet.project.remove", {
          path: action.root,
        });
        snapshot = await collectFleetSnapshot(client);
        state = {
          ...state,
          notice: result.removed
            ? `Removed project ${shortPath(result.root, renderOptions.home)} — its threads are now unregistered`
            : `Not a registered project: ${shortPath(result.root, renderOptions.home)}`,
          noticeTone: result.removed ? "neutral" : "warning",
        };
      } else if (action?.type === "project-complete") {
        const completion = await completeDirectoryPath(action.draft, {
          cwd: composerCwd(state, snapshot),
          home: renderOptions.home,
        });
        state = {
          ...state,
          projectPrompt: { draft: completion.value },
          // Several matches are worth showing; one is already in the draft.
          notice: completion.candidates.length > 1
            ? completion.candidates.slice(0, 12).join("  ")
            : undefined,
          noticeTone: "neutral",
        };
      } else if (action?.type === "shell-run") {
        if (runtime.runShellCommand === undefined) {
          throw new Error("Shell mode is unavailable in this Fleet client");
        }
        const abort = new AbortController();
        shellInterrupt = abort;
        const result = await runtime.runShellCommand({
          command: action.command,
          cwd: action.cwd,
          signal: abort.signal,
          // Output is folded into the transcript as it arrives and the frame is woken for each
          // chunk, so a slow command shows its progress rather than landing all at once.
          onOutput: (chunk) => {
            const shell = state.shellMode;
            if (shell === undefined) return;
            state = {
              ...state,
              shellMode: { ...shell, transcript: appendShellOutput(shell.transcript, chunk) },
            };
            notify();
          },
        });
        shellInterrupt = undefined;
        const shell = state.shellMode;
        state = {
          ...state,
          // A `cd` only persists because the shell says where it ended up; when it says nothing,
          // Fleet stays exactly where it was.
          ...(result.cwd === undefined ? {} : { workingDirectory: result.cwd }),
          ...(shell === undefined ? {} : {
            shellMode: {
              ...shell,
              running: false,
              // A failing line says so on a row of its own, whether or not its output ended on a
              // line boundary. A status nobody prints is a status nobody notices.
              transcript: result.exitStatus === 0
                ? shell.transcript
                : appendShellOutput(
                    shell.transcript,
                    `${(shell.transcript.at(-1) ?? "") === "" ? "" : "\n"}exit ${result.exitStatus}\n`,
                  ),
            },
          }),
        };
      } else if (action?.type === "change-directory") {
        if (runtime.changeDirectory === undefined) {
          throw new Error("Working-directory navigation is unavailable in this client");
        }
        const cwd = await runtime.changeDirectory(action.cwd);
        if (cwd !== undefined) {
          state = {
            ...state,
            workingDirectory: cwd,
            notice: `Working directory: ${cwd}`,
            noticeTone: "neutral",
          };
        }
      }
      if (
        action !== undefined
        && action.type !== "attach"
        && action.type !== "resume"
        && action.type !== "start"
        && action.type !== "open-orchestrator"
        && action.type !== "create-orchestrator"
        && action.type !== "change-directory"
        && action.type !== "shell-run"
        && action.type !== "permission-policy"
        && action.type !== "folder-disposition"
        && action.type !== "nvim-layout"
        && action.type !== "delete"
        && action.type !== "open-worktree"
        && action.type !== "open-checkout"
        && action.type !== "attach-clipboard-image"
        && action.type !== "project-add"
        && action.type !== "project-remove"
        && action.type !== "project-complete"
      ) {
        snapshot = await collectFleetSnapshot(client);
      }
    } catch (error) {
      shellInterrupt = undefined;
      state = {
        ...state,
        ...(action?.type === "start" ? { draft: action.request.initialPrompt } : {}),
        // A rejected path is almost always a typo, so the prompt comes back with it still in hand.
        ...(action?.type === "project-add" ? { projectPrompt: { draft: action.path } } : {}),
        // A transport failure is not a definitive handoff result. Restore the exact directive and
        // mutation id so Enter retries the same durable broker mutation rather than duplicating it.
        ...(action?.type === "handoff"
          ? {
              handoffPicker: {
                step: "directive" as const,
                workerIds: action.workerIds,
                recipientSessionId: action.recipientSessionId,
                draft: action.directive,
                mutationId: action.mutationId,
              },
            }
          : {}),
        // A shell that could not be run is still a shell the operator is standing in.
        ...(action?.type === "shell-run" && state.shellMode !== undefined
          ? { shellMode: { ...state.shellMode, running: false } }
          : {}),
        ...(action?.type === "permission-policy"
          ? {
              permissionPolicies: {
                ...state.permissionPolicies,
                [action.provider]: action.previousPolicy,
              },
            }
          : {}),
        notice: error instanceof RpcError && error.code === "METHOD_NOT_FOUND"
          ? "Restart the Cyberdeck broker to enable this fleet action"
          : error instanceof Error ? error.message : String(error),
        noticeTone: "error",
      };
    }
    notify();
  };
  const queueKeys = (keys: readonly string[]) => {
    // Keys are performed one at a time, and a shell line is performed like any other action — so
    // while one runs, every later key is stuck behind it in this chain, the key that would stop it
    // most of all. The interrupt is therefore fired here, on arrival, and the key still queues
    // normally to leave the mode once the line lets go.
    if (
      shellInterrupt !== undefined
      && keys.some((key) => key === "ctrl+g" || key === "escape" || key === "ctrl+c")
    ) {
      shellInterrupt.abort();
    }
    for (const key of keys) inputQueue = inputQueue.then(() => perform(key));
  };
  const onInput = (value: Buffer | string) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    queueKeys(keyDecoder.push(bytes));
    if (decoderFlushTimer !== undefined) clearTimeout(decoderFlushTimer);
    if (keyDecoder.hasPendingInput) {
      decoderFlushTimer = setTimeout(() => {
        decoderFlushTimer = undefined;
        queueKeys(keyDecoder.flush());
      }, 25);
    }
  };

  input.setRawMode?.(true);
  input.on("data", onInput);
  input.resume?.();
  const onSigint = () => { queueKeys(["ctrl+c"]); };
  // A resize invalidates the geometry an in-place repaint overwrites: the terminal reflows what is
  // on screen, and the row the frame's last line lands on is no longer the row it left. Dropping
  // the painted frame makes the next one clear and paint in full, whether or not it differs.
  const onResize = () => {
    paintedFrame = undefined;
    notify();
  };
  signals.on("SIGINT", onSigint);
  signals.on("SIGTERM", stop);
  signals.on("SIGWINCH", onResize);
  enterFleetScreen();

  try {
    while (!stopped) {
      if (attaching) {
        await waitForNextFrame();
        continue;
      }
      snapshot = await collectFleetSnapshot(client);
      state = normalizeState(state, snapshot, Date.now());
      // A thread is asked about by the branch its own work lands on. The declared
      // workspace branch is the only thing that separates threads sharing one
      // checkout; a thread without one is answered for by its worktree, or not at
      // all. Either way the answer is that thread's, not its directory's.
      pullRequestStatus.refresh(snapshot.threads.map(({ record }) => ({
        threadId: record.id,
        cwd: record.cwd,
        ...(record.workspace?.branch === undefined ? {} : { branch: record.workspace.branch }),
      })));
      const height = Math.max(1, output.rows ?? 32);
      const width = Math.max(1, output.columns ?? 120);
      if (state.view === "diagnostics") {
        const dashboard = await collectDashboardSnapshot(client);
        const diagnostics = renderDashboard(dashboard).split("\n");
        const footer = [
          ...(state.notice === undefined ? [] : [renderNotice(state.notice, state.noticeTone, width, output.isTTY === true)]),
          paint("─".repeat(width), "dim", output.isTTY === true),
          "ctrl+w Fleet · ctrl+c twice to exit",
        ];
        const body = diagnostics.slice(0, Math.max(0, height - footer.length));
        while (body.length < height - footer.length) body.push("");
        writeFrame([...body, ...footer].join("\n"), undefined, {
          width,
          height,
          scrollOffset: "diagnostics",
          topology: JSON.stringify({
            surface: "diagnostics",
            footerRows: footer.length,
            sourceRows: Math.min(diagnostics.length, body.length),
            sessions: dashboard.sessions.map(({ id }) => id),
            jobs: dashboard.jobs.map(({ record }) => record.id),
            queue: dashboard.queue === null
              ? null
              : dashboard.queue.queued.map(({ jobId }) => jobId),
            budget: dashboard.budget === null
              ? null
              : dashboard.budget.scopes.map(({ scopeId, usage }) => [
                  scopeId,
                  usage.jobsWithUnknownUsage > 0,
                ]),
            reconciliation: dashboard.reconciliation === null
              ? null
              : {
                  ran: dashboard.reconciliation.reconciledAt !== null,
                  findings: dashboard.reconciliation.findings.map(({ kind, subject }) =>
                    `${kind}:${subject}`),
                },
          }),
        });
      } else {
        const renderOptions: ResolvedFleetRenderOptions = {
          color: output.isTTY === true,
          width,
          height,
          now: Date.now(),
          home: homedir(),
          pullRequests: pullRequestStatus.states(),
          background: terminalBackground,
        };
        state = normalizeThreadListViewport(snapshot, state, renderOptions);
        const rendered = renderFleet(snapshot, state, renderOptions);
        writeFrame(
          rendered,
          composerCursor(rendered, state, width),
          fleetFrameLayout(snapshot, state, renderOptions),
        );
      }
      await waitForNextFrame();
    }
    await inputQueue;
  } finally {
    let layoutCleanupError: unknown;
    try {
      if (nvimLayoutHookInstalled) await runtime.nvimLayoutHooks?.remove();
    } catch (error) {
      layoutCleanupError = error;
    }
    unsubscribeClose();
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", stop);
    signals.off("SIGWINCH", onResize);
    input.off("data", onInput);
    input.pause?.();
    input.setRawMode?.(previousRawMode);
    if (decoderFlushTimer !== undefined) clearTimeout(decoderFlushTimer);
    output.write(LEAVE_FLEET_SCREEN);
    client.close();
    if (layoutCleanupError !== undefined) throw layoutCleanupError;
  }
}

function waitForRefresh(register: (wake: () => void) => void, clear: () => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clear();
      resolve();
    }, PREVIEW_REPAINT_INTERVAL_MS);
    register(() => {
      clearTimeout(timer);
      clear();
      resolve();
    });
  });
}

/**
 * The composer that owns text input in the rendered frame, or nothing when none does.
 *
 * The precedence is {@link renderFleet}'s own, not a second opinion about it: a picker that renders
 * instead of the list collects arrow keys, not text, and the two surfaces that do render a composer
 * row — the list's footer and the command palette — must be read for the same draft the row shows.
 */
function composerFocus(state: FleetState): { mode: ComposerMode; value: string } | undefined {
  if (state.view !== "fleet") return undefined;
  if (state.workerPicker !== undefined || state.permissionPicker !== undefined) return undefined;
  if (state.commandPalette !== undefined) return { mode: "task", value: state.draft };
  if (state.orchestratorPicker !== undefined || state.handoffPicker !== undefined) return undefined;
  if (state.rename !== undefined) return { mode: "rename", value: state.rename.draft };
  if (state.projectPrompt !== undefined) return { mode: "project", value: state.projectPrompt.draft };
  if (state.shellMode !== undefined) return { mode: "shell", value: state.shellMode.draft };
  return { mode: "task", value: state.draft };
}

/**
 * Where the caret belongs in the rendered frame, or nothing when no composer owns it.
 *
 * The column is counted in terminal cells rather than code points, because that is what the `CUP`
 * sequence addresses: a draft holding an ideograph or an emoji is wider on screen than it is long
 * in JavaScript, and counting the string would park the caret inside the text the operator typed.
 */
export function composerCursor(
  rendered: string,
  state: FleetState,
  width: number,
): { row: number; column: number } | undefined {
  const focus = composerFocus(state);
  if (focus === undefined) return undefined;
  const lines = rendered.split("\n");
  const expectedComposerRow = renderComposerLines(focus.value, focus.mode, {
    width,
    height: lines.length,
    now: 0,
    color: false,
    home: "",
    pullRequests: new Map(),
    background: undefined,
  }).at(-1);
  const rowIndex = expectedComposerRow === undefined
    ? -1
    : lines.findLastIndex((line) =>
        stripTerminalControl(line) === stripTerminalControl(expectedComposerRow));
  if (rowIndex === -1) return undefined;
  const visibleLine = stripTerminalControl(lines[rowIndex] ?? "");
  // An empty draft shows its placeholder, so the caret is placed off the prompt the composer wears
  // rather than off the end of copy the operator did not type.
  const emptyColumn = displayWidth(COMPOSER_PROMPTS[focus.mode].prefix) + 2;
  return {
    row: Math.max(1, rowIndex + 1),
    column: focus.value === ""
      ? emptyColumn
      : Math.min(width, displayWidth(visibleLine) + 1),
  };
}

/**
 * Stateful terminal-input decoder for the fleet composer.
 *
 * Provider TUIs can leave mouse/focus reporting enabled on the shared pane. Those reports are CSI
 * control sequences and may be split across arbitrary stdin chunks, so a per-chunk decoder would
 * turn their printable suffixes into task text. This decoder buffers incomplete escape sequences,
 * recognizes the fleet's navigation keys, and consumes every other complete CSI sequence.
 */
export class FleetKeyDecoder {
  private pending = "";

  get hasPendingInput(): boolean {
    return this.pending !== "";
  }

  push(bytes: Buffer | string): string[] {
    const value = this.pending + (Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
    this.pending = "";
    return this.decode(value);
  }

  flush(): string[] {
    if (this.pending === "") return [];
    const pending = this.pending;
    this.pending = "";
    return pending === "\u001b" ? ["escape"] : [];
  }

  reset(): void {
    this.pending = "";
  }

  private decode(value: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < value.length;) {
    const rest = value.slice(index);
    const special = [
      ["\u001b[A", "up"],
      ["\u001b[B", "down"],
      ["\u001b[D", "left"],
      ["\u001b[C", "right"],
      ["\u001b[1;2A", "shift+up"],
      ["\u001b[1;2B", "shift+down"],
      ["\u001b[5~", "pageup"],
      ["\u001b[6~", "pagedown"],
      ["\u001b[H", "home"],
      ["\u001b[1~", "home"],
      ["\u001b[7~", "home"],
      ["\u001b[F", "end"],
      ["\u001b[4~", "end"],
      ["\u001b[8~", "end"],
    ] as const;
    const match = special.find(([sequence]) => rest.startsWith(sequence));
    if (match !== undefined) {
      keys.push(match[1]);
      index += match[0].length;
      continue;
    }
    if (rest.startsWith("\u001b[")) {
      const csi = /^\u001b\[[0-?]*[ -/]*[@-~]/u.exec(rest);
      if (csi === null) {
        this.pending = rest;
        break;
      }
      const csiKey = decodeCsiUKey(csi[0]);
      if (csiKey !== undefined) keys.push(csiKey);
      index += csi[0].length;
      continue;
    }
    // SS3 has its own three-byte shape. Consuming it whole keeps its final byte out of the draft.
    if (rest.startsWith("\u001bO")) {
      if (rest.length < 3) {
        this.pending = rest;
        break;
      }
      index += 3;
      continue;
    }
    if (rest === "\u001b") {
      this.pending = rest;
      break;
    }
    // An Esc that already has a byte behind it is the Meta prefix of a single chord, never Esc plus
    // that key. Resolving it here is what stops Option+Enter from clearing the draft and submitting.
    if (rest.startsWith("\u001b")) {
      if (rest.charCodeAt(1) === 0x1b) {
        keys.push("escape");
        index += 1;
        continue;
      }
      const chord = altChordKey(rest.charCodeAt(1), rest[1]!);
      if (chord !== undefined) keys.push(chord);
      index += 2;
      continue;
    }
    const code = value.charCodeAt(index);
    if (code === 0x03) keys.push("ctrl+c");
    else if (code === 0x04) keys.push("ctrl+d");
    else if (code === 0x07) keys.push("ctrl+g");
    else if (code === 0x0a) keys.push("ctrl+j");
    else if (code === 0x0c) keys.push("ctrl+l");
    else if (code === 0x0e) keys.push("ctrl+n");
    else if (code === 0x0f) keys.push("ctrl+o");
    else if (code === 0x12) keys.push("ctrl+r");
    else if (code === 0x13) keys.push("ctrl+s");
    else if (code === 0x14) keys.push("ctrl+t");
    else if (code === 0x15) keys.push("ctrl+u");
    else if (code === 0x16) keys.push("ctrl+v");
    else if (code === 0x17) keys.push("ctrl+w");
    else if (code === 0x18) keys.push("ctrl+x");
    else if (code === 0x1d) keys.push("ctrl+]");
    else if (code === 0x0d) keys.push("enter");
    // Tab is byte-identical to Ctrl+I, so this names one key, not two. It is bound only inside the
    // project prompt, where Ctrl+I completing a path as well costs the operator nothing.
    else if (code === 0x09) keys.push("tab");
    else if (code === 0x7f || code === 0x08) keys.push("backspace");
    else if (code >= 0x20) keys.push(value[index]!);
    index += 1;
  }
  return keys;
  }
}

/**
 * Decode a CSI-u key report into a fleet key name.
 *
 * A provider TUI can leave the terminal in a keyboard protocol that reports ordinary keys as
 * `CSI <code> ; <modifiers> u` rather than as bytes, and that mode outlives the attachment. Without
 * this the fleet swallowed every such report as an anonymous control sequence, so Esc did nothing
 * and Option+Enter did nothing — the same gesture behaving differently depending on which provider
 * the operator had visited last. Sequences that are not key reports stay consumed and unnamed.
 */
function decodeCsiUKey(sequence: string): string | undefined {
  const report = /^\u001b\[(\d+)(?:;(\d+)(?::\d+)?)?u$/u.exec(sequence);
  if (report === null) return undefined;
  const code = Number(report[1]);
  const modifiers = report[2] === undefined ? 0 : Number(report[2]) - 1;
  const shift = (modifiers & 1) !== 0;
  const alt = (modifiers & 2) !== 0;
  const ctrl = (modifiers & 4) !== 0;
  if (code === 27) return "escape";
  if (code === 13 || code === 10) {
    if (alt) return "alt+enter";
    if (shift) return "shift+enter";
    return ctrl ? "ctrl+enter" : "enter";
  }
  if (code === 127 || code === 8) return "backspace";
  if (code === 9) return "tab";
  if (ctrl || code < 0x20) return undefined;
  const character = String.fromCodePoint(code);
  return alt ? `alt+${character}` : character;
}

/**
 * Name the single chord an Esc prefix forms with the byte behind it.
 *
 * Option is delivered either as this prefix or as a composed character; a composed character needs
 * no decoding, so this is the whole of Meta handling. Chords the fleet does not bind resolve to
 * `undefined` and are dropped, which is the point: an unbound chord must do nothing rather than
 * decay into its two halves and fire two bindings.
 */
function altChordKey(code: number, character: string): string | undefined {
  if (code === 0x0d || code === 0x0a) return "alt+enter";
  if (code === 0x7f || code === 0x08) return "alt+backspace";
  if (code < 0x20) return undefined;
  return `alt+${character}`;
}

function openAction(record: SessionRecord): FleetAction {
  return record.executionState === "active" || record.executionState === "starting"
    ? { type: "attach", sessionId: record.id }
    : { type: "resume", sessionId: record.id };
}

function normalizeState(state: FleetState, snapshot: FleetSnapshot, now: number): FleetState {
  const threads = orderedThreads(snapshot);
  const selectedExists = threads.some(({ record }) => record.id === state.selectedSessionId);
  const selectedSessionId = selectedExists ? state.selectedSessionId : threads[0]?.record.id;
  // An orc's row is never hidden by the folder it was launched in — it lives in the global
  // Orcs section — but that section folds and caps like a folder, so the orc answers to it
  // under the sentinel key instead.
  const selectedRecord = threads.find(({ record }) => record.id === selectedSessionId)?.record;
  const orcs = orchestratorThreads(snapshot.threads);
  const folders = [
    ...(orcs.length === 0 ? [] : [{ cwd: ORCS_SECTION_KEY, threads: orcs }]),
    ...groupThreads(snapshot),
  ];
  // A worker answers to the section it renders in, which under a registry is its project rather
  // than its own working directory.
  const selectedCwd = selectedRecord === undefined
    ? undefined
    : selectedRecord.kind === "orchestrator"
      ? ORCS_SECTION_KEY
      : folders.find(({ threads: workers }) =>
        workers.some(({ record }) => record.id === selectedRecord.id))?.cwd;
  const folderExists = state.focusedFolderCwd !== undefined
    && folders.some(({ cwd }) => cwd === state.focusedFolderCwd);
  // A capped folder only offers a show-more row once it has more workers than it shows,
  // and a collapsed folder offers none at all.
  const showMoreExists = state.focusedShowMoreCwd !== undefined
    && !isCollapsed(state, state.focusedShowMoreCwd)
    && folders.some(({ cwd, threads: workers }) =>
      cwd === state.focusedShowMoreCwd && workers.length > FOLDER_THREAD_CAP);
  // A collapsed folder hides its threads, so focus rises to the header rather
  // than resting on a row nobody can see; the cap does the same onto its show-more row.
  const selectedCollapsed = selectedCwd !== undefined && isCollapsed(state, selectedCwd);
  const selectedCapped = !selectedCollapsed
    && selectedCwd !== undefined
    && selectedSessionId !== undefined
    && cappedOut(folders, state, selectedCwd, selectedSessionId);
  const focusedFolderCwd = folderExists
    ? state.focusedFolderCwd
    : !showMoreExists && selectedCollapsed
      ? selectedCwd
      : undefined;
  const focusedShowMoreCwd = focusedFolderCwd !== undefined
    ? undefined
    : showMoreExists
      ? state.focusedShowMoreCwd
      : selectedCapped
        ? selectedCwd
        : undefined;
  const stopAcknowledgement = state.stopAcknowledgement?.sessionId === selectedSessionId
    ? state.stopAcknowledgement
    : undefined;
  const deleteConfirmation = state.deleteConfirmation !== undefined
    && state.deleteConfirmation.sessionId === selectedSessionId
    && state.deleteConfirmation.expiresAt > now
    ? state.deleteConfirmation
    : undefined;
  const quitConfirmation = state.quitConfirmation !== undefined && state.quitConfirmation.expiresAt > now
    ? state.quitConfirmation
    : undefined;
  // A mark is a claim about a live worker. A session that has gone away takes its mark with it,
  // rather than leaving a batch member the broker would have to refuse the whole handoff over.
  const markedIds = handoffMarks(state).filter((id) => isHandoffEligible(threads, id));
  const confirmationExpired = (state.deleteConfirmation !== undefined && deleteConfirmation === undefined)
    || (state.quitConfirmation !== undefined && quitConfirmation === undefined);
  return {
    ...state,
    selectedSessionId,
    focusedFolderCwd,
    focusedShowMoreCwd,
    stopAcknowledgement,
    deleteConfirmation,
    quitConfirmation,
    ...(state.handoffMarks === undefined ? {} : { handoffMarks: markedIds }),
    ...(state.orchestratorPicker === undefined
      ? {}
      : { orchestratorPicker: normalizeOrchestratorPicker(state.orchestratorPicker, snapshot, now) }),
    ...(confirmationExpired
      ? { notice: undefined }
      : {}),
  };
}

/**
 * Carry the picker across a snapshot refresh.
 *
 * The focus itself is durable, so nothing has to be re-derived from a row number; the only work is
 * rescuing a focus whose orchestrator was deleted, and dropping a stop acknowledgement or a delete
 * confirmation that is no longer the focused row's — the same rules the fleet list applies to its
 * own copies of that ladder state.
 */
function normalizeOrchestratorPicker(
  picker: OrchestratorPickerState,
  snapshot: FleetSnapshot,
  now: number,
): OrchestratorPickerState {
  if (picker.step !== "target") return picker;
  const existing = existingOrchestrators(snapshot);
  const focus = orchestratorFocusIndex(picker.focus, existing) < 0
    ? orchestratorFocusAt(0, existing)
    : picker.focus;
  const focusedId = focus.kind === "existing" ? focus.sessionId : undefined;
  return {
    ...picker,
    focus,
    stopAcknowledgement: picker.stopAcknowledgement?.sessionId === focusedId
      ? picker.stopAcknowledgement
      : undefined,
    deleteConfirmation: picker.deleteConfirmation !== undefined
      && picker.deleteConfirmation.sessionId === focusedId
      && picker.deleteConfirmation.expiresAt > now
      ? picker.deleteConfirmation
      : undefined,
  };
}

/** True when the folder's cap would hide this worker, leaving its selection without a row. */
function cappedOut(
  folders: ReadonlyArray<{ cwd: string; threads: readonly FleetThread[] }>,
  state: FleetState,
  cwd: string,
  sessionId: string,
): boolean {
  if (isExpanded(state, cwd)) return false;
  const folder = folders.find((candidate) => candidate.cwd === cwd);
  if (folder === undefined) return false;
  return folder.threads.findIndex(({ record }) => record.id === sessionId) >= FOLDER_THREAD_CAP;
}

function isTerminalSession(record: SessionRecord): boolean {
  if (record.executionState === "active" || record.executionState === "starting") return false;
  return record.exitCode !== null;
}

function orderedThreads(snapshot: FleetSnapshot): FleetThread[] {
  return [
    ...orchestratorThreads(snapshot.threads),
    ...groupThreads(snapshot).flatMap(({ threads }) => threads),
  ];
}

/**
 * One navigable line of the fleet list. Folder headers and show-more rows are rows in
 * their own right: focus lands on them, and Enter there collapses or expands the folder.
 */
type FleetRow =
  | {
    kind: "folder";
    cwd: string;
    threadCount: number;
    /** Set on the Orcs header, which names a section rather than a path on disk. */
    label?: string;
  }
  | {
    kind: "thread";
    cwd: string;
    thread: FleetThread;
    /** Absent when custody is healthy, unknown, or already stated by the group rollup. */
    leaseBadge?: LeaseCustodyBadge;
    /** Where under its project the worker lives, when that is not the project root itself. */
    worktree?: string;
    /** The owner's sigil. Absent on a worker nobody dispatched — the operator's own. */
    ownerSigil?: string;
    /** True while an Orc row is selected and this worker is not one of that Orc's. */
    outsideLens?: boolean;
  }
  | {
    kind: "show-more";
    cwd: string;
    /** Zero once the folder is expanded, when the row reads as the way back. */
    hiddenCount: number;
  };

/**
 * Role headings and blank separators occupy a line each, so the viewport has to count them, but
 * neither is a focus target. Keeping them in the same list is what stops the scroll offset and the
 * rendered lines from disagreeing about how tall the list is.
 */
type FleetListRow =
  | FleetRow
  | { kind: "spacer" }
  | { kind: "section"; label: string }
  | { kind: "ownership"; coordination: FleetWorkerCoordinationView };

function isCollapsed(state: FleetState, cwd: string): boolean {
  return state.collapsedCwds?.includes(cwd) === true;
}

function isExpanded(state: FleetState, cwd: string): boolean {
  return state.expandedCwds?.includes(cwd) === true;
}

/**
 * The fleet reads top-down as one Orcs roster over the folders its workers live in.
 * Orchestrators are fleet-wide, so they are listed once, flat, ahead of every folder;
 * folders below hold workers only.
 */
function fleetListRows(snapshot: FleetSnapshot, state: FleetState): FleetListRow[] {
  const orcs = orchestratorThreads(snapshot.threads);
  // One assignment for the whole frame, so an Orc's row and its workers' rows cannot disagree.
  const provenance: FleetProvenance = {
    sigils: snapshotOwnerSigils(snapshot),
    lens: ownershipLensControllerId(snapshot, state),
  };
  const orcRows: FleetListRow[] = orcs.length === 0
    ? []
    : orcSectionRows(orcs, state, provenance);
  const folderRows = groupThreads(snapshot).flatMap(({ cwd, label, threads }, groupIndex): FleetListRow[] => {
    const header: FleetRow = {
      kind: "folder",
      cwd,
      threadCount: threads.length,
      ...(label === undefined ? {} : { label }),
    };
    const spacer: FleetListRow[] = groupIndex === 0 && orcRows.length === 0
      ? []
      : [{ kind: "spacer" }];
    if (isCollapsed(state, cwd)) return [...spacer, header];
    const visible = isExpanded(state, cwd) ? threads : threads.slice(0, FOLDER_THREAD_CAP);
    return [
      ...spacer,
      header,
      ...sectionRows(WORKERS_SECTION_LABEL, visible, threads, state, provenance, cwd),
      // The row survives expansion so the folder can be rolled back up from the same place.
      ...(threads.length > FOLDER_THREAD_CAP
        ? [{ kind: "show-more" as const, cwd, hiddenCount: threads.length - visible.length }]
        : []),
    ];
  });
  return [...orcRows, ...folderRows];
}

/**
 * The global Orcs roster, headed by a row that folds it exactly as a folder header folds a
 * project. A fleet accumulates orchestrators without bound, so the roster is capped the same
 * way too: an unbounded section would shove every folder below it down the screen.
 */
function orcSectionRows(
  orcs: readonly FleetThread[],
  state: FleetState,
  provenance: FleetProvenance,
): FleetListRow[] {
  const header: FleetRow = {
    kind: "folder",
    cwd: ORCS_SECTION_KEY,
    threadCount: orcs.length,
    label: ORCS_SECTION_LABEL,
  };
  if (isCollapsed(state, ORCS_SECTION_KEY)) return [header];
  const visible = isExpanded(state, ORCS_SECTION_KEY) ? orcs : orcs.slice(0, FOLDER_THREAD_CAP);
  return [
    header,
    ...threadRows(visible, state, undefined, provenance),
    ...(orcs.length > FOLDER_THREAD_CAP
      ? [{ kind: "show-more" as const, cwd: ORCS_SECTION_KEY, hiddenCount: orcs.length - visible.length }]
      : []),
  ];
}

/**
 * A role heading and the thread rows under it. `all` carries the whole group even when the
 * cap trims what is shown, so the heading keeps describing the folder rather than the slice.
 */
function sectionRows(
  label: string,
  visible: readonly FleetThread[],
  all: readonly FleetThread[],
  state: FleetState,
  provenance: FleetProvenance,
  root?: string | undefined,
): FleetListRow[] {
  // A section whose workers all share one custody says it once on the heading, and
  // its rows go bare: a badge repeated down the whole group is a column of noise.
  const rollup = uniformLeaseCustody(all.map(threadLeaseCustody));
  return [
    { kind: "section", label: sectionLabel(label, all.length, rollup) },
    ...threadRows(visible, state, rollup, provenance, root),
  ];
}

/** The thread rows of one section, each with the ownership line it owns when detail is on. */
function threadRows(
  visible: readonly FleetThread[],
  state: FleetState,
  rollup: LeaseCustody | undefined,
  provenance: FleetProvenance,
  root?: string | undefined,
): FleetListRow[] {
  return visible.flatMap((thread): FleetListRow[] => {
    const custody = threadLeaseCustody(thread);
    const badge = rollup !== undefined || custody === undefined
      ? undefined
      : leaseCustodyBadge(custody);
    // A worktree folded into its project says so on its own row; that is what the row costs the
    // section it no longer gets to head.
    const worktree = root === undefined || root.startsWith("/@")
      ? undefined
      : worktreeTag(thread, root);
    const sigil = threadOwnerSigil(thread, provenance.sigils);
    return [
      {
        kind: "thread",
        cwd: thread.record.cwd,
        thread,
        ...(badge === undefined ? {} : { leaseBadge: badge }),
        ...(worktree === undefined ? {} : { worktree }),
        ...(sigil === undefined ? {} : { ownerSigil: sigil }),
        ...(outsideOwnershipLens(thread, provenance.lens) ? { outsideLens: true } : {}),
      },
      ...(state.leaseDetail === true && thread.coordination !== undefined
        && thread.record.kind !== "orchestrator"
        ? [{ kind: "ownership" as const, coordination: thread.coordination }]
        : []),
    ];
  });
}

function threadLeaseCustody(thread: FleetThread): LeaseCustody | undefined {
  return thread.record.kind === "orchestrator" || thread.coordination === undefined
    ? undefined
    : leaseCustody(thread.coordination);
}

/** One frame's provenance: who wears which sigil, and which Orc the lens is resting on. */
interface FleetProvenance {
  sigils: OwnerSigils;
  /** The selected Orc's controller identity, or `undefined` when the lens is off. */
  lens?: string | undefined;
}

/**
 * The sigil assignment for one snapshot.
 *
 * Bound orchestrators are seeded from their own session's `createdAt`, which is the only
 * seniority Fleet has locally and is enough for the property that matters: an Orc already on
 * screen does not lose its glyph when another one spawns.
 */
function snapshotOwnerSigils(snapshot: FleetSnapshot): OwnerSigils {
  return fleetOwnerSigils({
    orchestrators: snapshot.threads.flatMap((thread) =>
      thread.record.kind === "orchestrator" && thread.controllerId !== undefined
        ? [{ controllerId: thread.controllerId, since: thread.record.createdAt }]
        : []),
    workers: snapshot.threads.flatMap((thread) =>
      thread.record.kind === "orchestrator" || thread.coordination === undefined
        ? []
        : [thread.coordination]),
  });
}

/**
 * The sigil one row wears.
 *
 * An Orc wears the sigil of the family it is bound to; a worker wears whatever its lease says,
 * which is the only authority on the question. A worker with no coordination record at all was
 * never registered with a controller — the operator started it themselves — and wears nothing.
 */
function threadOwnerSigil(thread: FleetThread, sigils: OwnerSigils): string | undefined {
  if (thread.record.kind === "orchestrator") {
    return thread.controllerId === undefined ? undefined : sigils.get(thread.controllerId);
  }
  return thread.coordination === undefined
    ? undefined
    : workerOwnerSigil(thread.coordination, sigils);
}

/**
 * The Orc the ownership lens is resting on, if any.
 *
 * Selection is the whole gesture: moving onto an Orc row filters, moving off restores. There is no
 * mode to be in and no key to remember, so the feature costs nothing when it is not being used —
 * which is the only reason a filter this broad is affordable in a list this dense.
 */
function ownershipLensControllerId(
  snapshot: FleetSnapshot,
  state: FleetState,
): string | undefined {
  if (threadFocusInert(state) || state.selectedSessionId === undefined) return undefined;
  const selected = snapshot.threads.find(({ record }) => record.id === state.selectedSessionId);
  return selected?.record.kind === "orchestrator" ? selected.controllerId : undefined;
}

/**
 * True for a worker the lens is filtering out.
 *
 * Orc rows never dim: the roster is what the operator is reading the sigil against, and dimming
 * the rest of it would hide the comparison the lens exists to make. An orphaned worker dims like
 * any other row the selected Orc does not own, because it does not own it.
 */
function outsideOwnershipLens(thread: FleetThread, lens: string | undefined): boolean {
  if (lens === undefined || thread.record.kind === "orchestrator") return false;
  const owner = thread.coordination === undefined
    ? undefined
    : workerOwner(thread.coordination);
  return owner?.kind !== "controlled" || owner.controllerId !== lens;
}

/**
 * A role heading, plus the group's shared lease custody when it has one. Attached is the
 * healthy state and stays unsaid, so the heading only grows when there is something to say.
 */
function sectionLabel(
  label: string,
  threadCount: number,
  rollup: LeaseCustody | undefined,
): string {
  if (rollup === undefined || rollup.kind === "attached") return label;
  return `${label} (${threadCount} · all ${leaseCustodySummary(rollup)})`;
}

function focusedListRowIndex(rows: readonly FleetListRow[], state: FleetState): number {
  const index = state.focusedFolderCwd !== undefined
    ? rows.findIndex((row) => row.kind === "folder" && row.cwd === state.focusedFolderCwd)
    : state.focusedShowMoreCwd !== undefined
      ? rows.findIndex((row) => row.kind === "show-more" && row.cwd === state.focusedShowMoreCwd)
      : rows.findIndex((row) => row.kind === "thread" && row.thread.record.id === state.selectedSessionId);
  return Math.max(0, index);
}

/** True while a folder header or show-more row owns the row, leaving thread keys inert. */
function threadFocusInert(state: FleetState): boolean {
  return state.focusedFolderCwd !== undefined || state.focusedShowMoreCwd !== undefined;
}

function navigableListRowIndex(
  rows: readonly FleetListRow[],
  targetIndex: number,
  direction: -1 | 1,
): number {
  if (rows.length === 0) return -1;
  const target = Math.max(0, Math.min(rows.length - 1, targetIndex));
  for (
    let index = target;
    index >= 0 && index < rows.length;
    index += direction
  ) {
    if (isFocusableListRow(rows[index])) return index;
  }
  for (
    let index = target - direction;
    index >= 0 && index < rows.length;
    index -= direction
  ) {
    if (isFocusableListRow(rows[index])) return index;
  }
  return -1;
}

function isFocusableListRow(row: FleetListRow | undefined): row is FleetRow {
  return row?.kind === "folder" || row?.kind === "thread" || row?.kind === "show-more";
}

function focusRow(state: FleetState, row: FleetListRow | undefined): FleetState {
  if (!isFocusableListRow(row)) return state;
  if (row.kind === "folder") {
    return { ...state, focusedFolderCwd: row.cwd, focusedShowMoreCwd: undefined };
  }
  if (row.kind === "show-more") {
    return { ...state, focusedFolderCwd: undefined, focusedShowMoreCwd: row.cwd };
  }
  return {
    ...state,
    focusedFolderCwd: undefined,
    focusedShowMoreCwd: undefined,
    selectedSessionId: row.thread.record.id,
  };
}

function clampThreadListScrollOffset(
  offset: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  if (viewportHeight <= 0 || contentHeight <= viewportHeight) return 0;
  return Math.max(0, Math.min(contentHeight - viewportHeight, offset));
}

function scrollFocusedRowIntoView(
  state: FleetState,
  rows: readonly FleetListRow[],
  viewportHeight: number,
): FleetState {
  const focusedIndex = focusedListRowIndex(rows, state);
  let offset = clampThreadListScrollOffset(
    state.threadListScrollOffset,
    rows.length,
    viewportHeight,
  );
  if (focusedIndex < offset) {
    offset = focusedIndex;
  } else if (focusedIndex >= offset + viewportHeight) {
    offset = focusedIndex - viewportHeight + 1;
  }
  offset = clampThreadListScrollOffset(offset, rows.length, viewportHeight);
  return { ...state, threadListScrollOffset: offset };
}

function setCollapsed(state: FleetState, cwd: string, collapsed: boolean): FleetState {
  const current = state.collapsedCwds ?? [];
  if (current.includes(cwd) === collapsed) return state;
  return {
    ...state,
    collapsedCwds: collapsed
      ? [...current, cwd]
      : current.filter((candidate) => candidate !== cwd),
  };
}

function setExpanded(state: FleetState, cwd: string, expanded: boolean): FleetState {
  const current = state.expandedCwds ?? [];
  if (current.includes(cwd) === expanded) return state;
  return {
    ...state,
    expandedCwds: expanded
      ? [...current, cwd]
      : current.filter((candidate) => candidate !== cwd),
  };
}

/**
 * A fold is a standing operator decision, not view state, so each toggle writes through to the
 * preference store. Arrow keys repeat against a folder that is already folded, and an append-only
 * store would take a line for every one of those, so a toggle that changed nothing stays silent.
 */
function foldTransition(state: FleetState, next: FleetState, cwd: string): FleetTransition {
  const settled: FleetState = { ...next, deleteConfirmation: undefined, notice: undefined };
  if (next === state) return { state: settled };
  return {
    state: settled,
    action: {
      type: "folder-disposition",
      cwd,
      disposition: { collapsed: isCollapsed(next, cwd), expanded: isExpanded(next, cwd) },
    },
  };
}

function threadSubject(record: SessionRecord): string {
  return record.kind === "orchestrator" ? "orchestrator" : "thread";
}

/** Last activity, the fleet's ordering key. Falls back for records that never reported one. */
function lastActivity(record: SessionRecord): string {
  return record.meaningfulUpdatedAt ?? record.updatedAt;
}

/**
 * Pinned threads first, then most recent first within each group.
 *
 * A pin is a standing operator decision that a thread stays where it can be seen; recency is the
 * fleet's own guess at what matters now. A pin that only broke ties lost to the first sibling that
 * reported newer activity, which is the same as not having pinned at all — so the pin outranks
 * recency outright. Below both, ties fall back to explicit reorder and then age, so threads that
 * share a timestamp still hold a stable position.
 */
function byRecency(left: FleetThread, right: FleetThread): number {
  // `pinned` is optional, so an unpinned thread is `false` on one record and absent on another.
  // Comparing the raw fields would rank those two against each other.
  const leftPinned = left.record.pinned === true;
  const rightPinned = right.record.pinned === true;
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  const recency = lastActivity(right.record).localeCompare(lastActivity(left.record));
  if (recency !== 0) return recency;
  const leftOrder = left.record.displayOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.record.displayOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return left.record.createdAt.localeCompare(right.record.createdAt);
}

/** Every orchestrator in the fleet as one flat roster, whatever folder each was launched in. */
function orchestratorThreads(threads: readonly FleetThread[]): FleetThread[] {
  return threads
    .filter(({ record }) => record.kind === "orchestrator")
    .sort(byRecency);
}

/** One section of the worker list: a registered project, the unregistered bucket, or a folder. */
interface FleetFolder {
  cwd: string;
  threads: FleetThread[];
  /** Set on the unregistered bucket, which names a condition rather than a path on disk. */
  label?: string;
}

/**
 * The registered root a directory belongs to, longest first.
 *
 * Longest wins so a project nested inside another still claims its own threads, and the match is
 * taken at a path separator so `/repo-two` is never swallowed by `/repo`.
 */
function projectRootFor(cwd: string, projects: readonly string[]): string | undefined {
  let match: string | undefined;
  for (const root of projects) {
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    if (match === undefined || root.length > match.length) match = root;
  }
  return match;
}

/**
 * Which project a worker belongs to, which is not always where it is running.
 *
 * A worktree Cyberdeck provisioned is a *sibling* of the repository it was cut from, so nothing
 * about its path puts it under a registered project root. The workspace the broker recorded says
 * which repository it belongs to, and that is the section the operator looks for it in — a worker
 * on a Cyberdeck branch reads as Cyberdeck work, not as a stray root named after a branch.
 */
function sectionPath(thread: FleetThread): string {
  return thread.record.workspace?.repositoryPath ?? thread.record.cwd;
}

/**
 * What a worker's row says about where under its project it actually lives.
 *
 * A worktree under the project root names itself relatively, which is both short and true. A
 * provisioned sibling worktree has no such relative name, so it says its own directory name — the
 * one Cyberdeck's naming policy derived from the branch, and the one `cd` takes.
 */
function worktreeTag(thread: FleetThread, root: string): string | undefined {
  const cwd = thread.record.cwd;
  if (cwd === root) return undefined;
  if (cwd.startsWith(`${root}/`)) return cwd.slice(root.length + 1);
  const worktreePath = thread.record.workspace?.worktreePath;
  return worktreePath === undefined ? undefined : basename(worktreePath);
}

/**
 * Workers by section.
 *
 * With a registry, a section is a project the operator named: every per-task worktree under it
 * folds into it and says which worktree on its own row, and a registered project holds its
 * section open even with nothing in it. Threads under no registered root land in one bucket
 * rather than disappearing — the operator has to be able to find work to finish it.
 *
 * Without a registry the fleet falls back to one folder per working directory, alphabetical by
 * absolute path so the list reads in the same order as `ls`.
 */
function groupThreads(snapshot: FleetSnapshot): FleetFolder[] {
  const workers = snapshot.threads.filter(({ record }) => record.kind !== "orchestrator");
  const projects = snapshot.projects;
  if (projects === undefined) {
    const groups = new Map<string, FleetThread[]>();
    for (const thread of workers) {
      const group = groups.get(thread.record.cwd) ?? [];
      group.push(thread);
      groups.set(thread.record.cwd, group);
    }
    return [...groups.entries()]
      .map(([cwd, entries]) => ({ cwd, threads: entries.sort(byRecency) }))
      .sort((left, right) => left.cwd.localeCompare(right.cwd));
  }
  const roots = [...new Set(projects)].sort((left, right) => left.localeCompare(right));
  const groups = new Map<string, FleetThread[]>(roots.map((root) => [root, []]));
  const unregistered: FleetThread[] = [];
  for (const thread of workers) {
    const root = projectRootFor(sectionPath(thread), roots) ?? projectRootFor(thread.record.cwd, roots);
    if (root === undefined) unregistered.push(thread);
    else groups.get(root)!.push(thread);
  }
  return [
    ...[...groups.entries()].map(([cwd, entries]) => ({ cwd, threads: entries.sort(byRecency) })),
    ...(unregistered.length === 0
      ? []
      : [{
        cwd: UNREGISTERED_SECTION_KEY,
        label: UNREGISTERED_SECTION_LABEL,
        threads: unregistered.sort(byRecency),
      }]),
  ];
}

/**
 * The workspace a composer start declares when the folder is set to `worktree`.
 *
 * The branch is named after the task because that is the only thing the operator has said, and it
 * goes under `cyberdeck/` so a repository's branch list keeps saying which branches a fleet made.
 * `HEAD` is the base because the composer starts work from the checkout the operator is looking at,
 * and no guess about a default branch is better than the branch they actually left it on. It stays
 * a declaration of intent: the provisioner resolves it to the commit it named and records *that*,
 * because `HEAD` re-read inside the worktree later is the worktree's own tip. The path is
 * deliberately absent: naming the worktree is Cyberdeck's job, and the broker refuses loudly rather
 * than reusing a directory or a branch that already exists.
 */
function composerWorkspace(instruction: string): StartSessionRequest["workspace"] {
  return {
    branch: `cyberdeck/${provisionedWorktreeSlug(taskName(instruction))}`,
    baseRef: "HEAD",
    provisioning: "cyberdeck-provisioned",
    writableRoots: [],
  };
}

function taskName(instruction: string): string {
  const singleLine = instruction.replace(/\s+/gu, " ").trim();
  return fit(singleLine, 72);
}

function composerCwd(state: FleetState, snapshot: FleetSnapshot): string {
  return state.workingDirectory
    ?? snapshot.threads.find(({ record }) => record.id === state.selectedSessionId)?.record.cwd
    ?? state.fallbackCwd;
}

/**
 * Cursor's catalog is one slug per model-and-effort pair, so labels are composed from a family and
 * the slug's effort suffix rather than enumerated. A new rung inside a known family therefore reads
 * correctly in Fleet without a label edit; an unknown family falls back to the raw slug.
 */
function cursorModelLabel(model: string): string | undefined {
  const families: Record<string, string> = {
    "composer-2.5": "Composer 2.5",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "claude-sonnet-5": "Sonnet 5",
    "claude-opus-5": "Opus 5",
    "claude-opus-5-thinking": "Opus 5 Thinking",
    "claude-fable-5": "Fable 5",
    "claude-fable-5-thinking": "Fable 5 Thinking",
    "cursor-grok-4.5": "Grok 4.5",
    "kimi-k2.7-code": "Kimi K2.7 Code",
    "kimi-k3": "Kimi K3",
    "glm-5.2": "GLM 5.2",
  };
  const efforts: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
  };
  const direct = families[model];
  if (direct !== undefined) return direct;
  const separator = model.lastIndexOf("-");
  if (separator === -1) return undefined;
  const family = families[model.slice(0, separator)];
  const effort = efforts[model.slice(separator + 1)];
  return family === undefined || effort === undefined ? undefined : `${family} ${effort}`;
}

/**
 * The model column: what the session is running, not what it was started with.
 *
 * The operator can switch model inside the provider's own CLI, and the launch request cannot know
 * it happened — so this prefers the model the provider itself last recorded. A leading `~` marks a
 * pair that is not fully observed: the provider keeps no transcript to read a running model out of,
 * it has not produced a turn yet, or it named a model without naming an effort. The launch value is
 * still shown, because the alternative is a blank column, but it is shown as the guess it is.
 */
export function threadIdentity(record: SessionRecord): string {
  const observed = record.observedModel;
  const effort = observed?.effort ?? record.effort;
  const unverified = observed === undefined || observed.effort === undefined;
  return `${unverified ? "~" : ""}${
    friendlyModel(record.provider, observed?.model ?? record.model)
  } · ${friendlyEffort(effort ?? "provider-managed")}`;
}

function friendlyModel(provider: string, model: string | undefined): string {
  if (model === undefined) return `${titleCase(provider)} Native`;
  if (provider === "cursor") {
    const label = cursorModelLabel(model);
    if (label !== undefined) return label;
  }
  const known: Record<string, string> = {
    "gpt-5.6-luna": "Codex Luna",
    "gpt-5.6-terra": "Codex Terra",
    "gpt-5.6-sol": "Codex Sol",
    haiku: "Claude Haiku",
    sonnet: "Claude Sonnet",
    opus: "Claude Opus",
    fable: "Claude Fable",
    composer: "Cursor Composer",
    "gemini-3.6-flash": "Gemini 3.6 Flash",
    "gemini-3.6-flash-low": "Gemini 3.6 Flash",
    "gemini-3.6-flash-medium": "Gemini 3.6 Flash",
    "gemini-3.6-flash-high": "Gemini 3.6 Flash",
  };
  return known[model] ?? readableSlug(provider, model);
}

/**
 * A model id nothing recognises, made readable without being renamed.
 *
 * An observed id is whatever the provider wrote — `claude-opus-4-8` — and the table above can only
 * ever cover ids that existed when it was written. Words are capitalised as printed and adjacent
 * digit groups are rejoined into the version they were, so `claude-opus-4-8` reads as
 * `Claude Opus 4.8` and is still recognisably the same string. A prefix the provider already
 * supplies is not repeated.
 */
function readableSlug(provider: string, model: string): string {
  const words: string[] = [];
  for (const token of model.split("-")) {
    const previous = words.at(-1);
    if (/^\d+$/u.test(token) && previous !== undefined && /\d$/u.test(previous)) {
      words[words.length - 1] = `${previous}.${token}`;
      continue;
    }
    words.push(/^[a-z]/u.test(token) ? titleCase(token) : token);
  }
  const readable = words.join(" ");
  return readable.toLowerCase().startsWith(provider.toLowerCase())
    ? readable
    : `${titleCase(provider)} ${readable}`;
}

function friendlyEffort(effort: ReasoningEffort | "provider-managed"): string {
  return effort === "provider-managed" ? "Provider managed" : effort;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function startTransition(
  state: FleetState,
  selected: SessionRecord | undefined,
  draft: string,
): FleetTransition {
  if (draft.startsWith("/")) {
    return { state: { ...state, notice: "Use /model to configure a new worker", noticeTone: "error" } };
  }
  const cwd = state.workingDirectory ?? selected?.cwd ?? state.fallbackCwd;
  const profile = state.launchProfiles[cwd];
  if (profile === undefined) {
    return openWorkerPickerForCwd(state, cwd, draft);
  }
  const initialPrompt = draft;
  // Read off the draft rather than out of a list held beside it, so what the operator can see is
  // what launches. This is also the only gate a *typed* or dropped path passes through — a
  // terminal drop types the path in and never touches ctrl+v — so the refusal lives here as well
  // as on the chord, and neither surface can let an image through in silence.
  const images = composerImageAttachments(initialPrompt);
  if (images.length > 0 && !providerAcceptsImages(profile.provider)) {
    return {
      state: {
        ...state,
        notice: `${imageInputRefusal(profile.provider, images.length)} — remove the path or /model to a provider that can`,
        noticeTone: "error",
      },
    };
  }
  const sandbox = selected?.sandbox ?? "read-only";
  const policy = state.permissionPolicies[profile.provider] ?? "permissioned";
  const permission = resolveProviderPermission(profile.provider, policy, sandbox);
  if (!permission.ok) {
    return {
      state: {
        ...state,
        notice: permission.message,
        noticeTone: "error",
      },
    };
  }
  const approvalMode = permission.value.application.kind === "approval-mode"
    && permission.value.application.value === "auto"
    ? { approvalMode: permission.value.application.value }
    : {};
  return {
    state: { ...state, draft: "", deleteConfirmation: undefined, notice: undefined },
    action: {
      type: "start",
      request: {
        provider: profile.provider,
        model: profile.model,
        ...(profile.effort === undefined ? {} : { effort: profile.effort }),
        cwd,
        sandbox,
        ...approvalMode,
        detached: true,
        name: taskName(initialPrompt),
        initialPrompt,
        // Sent only to a provider whose CLI has a flag to carry them. The paths stay in the prompt
        // regardless, so a provider that reads its images from the text is served by the text and
        // is handed no list the launch would drop.
        ...(images.length > 0 && providerAttachesImagesAtLaunch(profile.provider)
          ? { imageAttachments: images }
          : {}),
        ...(profile.isolation === "worktree" ? { workspace: composerWorkspace(initialPrompt) } : {}),
      },
      ...(permission.value.application.kind === "post-launch-command"
        ? { permissionLaunch: permission.value }
        : {}),
    },
  };
}

/**
 * One `/<grant>-workers status|on|off` command against the bound orchestrator of the current scope.
 * Every delegation grant the operator can toggle from Fleet routes through here, so they cannot
 * drift apart in which binding they address or how a missing binding is reported.
 */
function grantToggleTransition(
  state: FleetState,
  snapshot: FleetSnapshot,
  command: string,
  grant: { name: "/fable-workers"; action: "fable-workers" },
): FleetTransition | undefined {
  if (!command.startsWith(grant.name)) return undefined;
  const match = new RegExp(`^${grant.name}(?:\\s+(status|on|off))?$`, "u").exec(command);
  if (match === null) {
    return {
      state: {
        ...state,
        draft: "",
        notice: `Usage: ${grant.name} status|on|off`,
        noticeTone: "error",
      },
    };
  }
  const orchestrator = policyOrchestrator(snapshot, state);
  if (orchestrator === undefined) {
    return {
      state: {
        ...state,
        draft: "",
        notice: "No orchestrator is bound; press ctrl+o to choose one",
        noticeTone: "error",
      },
    };
  }
  const mode = match[1] ?? "status";
  return {
    state: { ...state, draft: "", notice: undefined },
    action: {
      type: grant.action,
      request: {
        cwd: orchestrator.cwd,
        scope: orchestrator.orchestratorScope ?? "workspace",
        ...(mode === "status" ? {} : { enabled: mode === "on" }),
      },
    },
  };
}

function cavemanWorkersTransition(
  state: FleetState,
  _snapshot: FleetSnapshot,
  command: string,
): FleetTransition | undefined {
  if (!command.startsWith("/caveman-workers")) return undefined;
  const match = /^\/caveman-workers(?:\s+(status|on|off))?$/u.exec(command);
  if (match === null) {
    return {
      state: {
        ...state,
        draft: "",
        notice: "Usage: /caveman-workers status|on|off",
        noticeTone: "error",
      },
    };
  }
  const mode = match[1] ?? "status";
  return {
    state: { ...state, draft: "", notice: undefined },
    action: {
      type: "caveman-workers",
      request: {
        ...(mode === "status" ? {} : { enabled: mode === "on" }),
      },
    },
  };
}

function nvimLayoutTransition(
  state: FleetState,
  command: string,
): FleetTransition | undefined {
  if (!command.startsWith("/nvim-settings")) return undefined;
  const match = /^\/nvim-settings(?:\s+(status|on|off))?$/u.exec(command);
  if (match === null) {
    return {
      state: {
        ...state,
        draft: "",
        notice: "Usage: /nvim-settings status|on|off",
        noticeTone: "error",
      },
    };
  }
  const mode = match[1] ?? "status";
  if (mode === "status") {
    return {
      state: {
        ...state,
        draft: "",
        notice: `Automatic nvim layout: ${state.nvimLayoutEnabled ? "ON" : "OFF"}`,
        noticeTone: "neutral",
      },
    };
  }
  return {
    state: { ...state, draft: "", notice: undefined },
    action: { type: "nvim-layout", enabled: mode === "on" },
  };
}

/**
 * `/worktree status|on|off` for the folder the composer is pointed at.
 *
 * Isolation is a per-folder decision rather than a per-worker one because the operator makes it
 * once, about a repository, and then stops thinking about it: either work in this project belongs
 * in its own worktree or it does not. It rides on the launch profile for the same reason the
 * provider and model do — it is what "start a worker here" means in this folder.
 */
function worktreeModeTransition(
  state: FleetState,
  snapshot: FleetSnapshot,
  command: string,
): FleetTransition | undefined {
  if (!command.startsWith("/worktree")) return undefined;
  const match = /^\/worktree(?:\s+(status|on|off))?$/u.exec(command);
  if (match === null) {
    return {
      state: {
        ...state,
        draft: "",
        notice: "Usage: /worktree status|on|off",
        noticeTone: "error",
      },
    };
  }
  const cwd = composerCwd(state, snapshot);
  const profile = state.launchProfiles[cwd];
  const mode = match[1] ?? "status";
  if (mode === "status") {
    return {
      state: {
        ...state,
        draft: "",
        notice: profile === undefined
          ? `${shortPath(cwd, homedir())} has no worker profile yet — /model first`
          : `Own worktree per worker in ${shortPath(cwd, homedir())}: ${
            profile.isolation === "worktree" ? "ON" : "OFF"
          }`,
        noticeTone: "neutral",
      },
    };
  }
  if (profile === undefined) {
    return {
      state: {
        ...state,
        draft: "",
        notice: "Choose a worker with /model before setting how it is isolated",
        noticeTone: "error",
      },
    };
  }
  const isolation: WorkerIsolation = mode === "on" ? "worktree" : "shared";
  const updated: LaunchProfile = { ...profile, isolation };
  return {
    state: {
      ...state,
      draft: "",
      launchProfiles: { ...state.launchProfiles, [cwd]: updated },
      notice: isolation === "worktree"
        ? "Workers started here get their own worktree, cut by Cyberdeck"
        : "Workers started here run in this folder",
      noticeTone: "neutral",
    },
    action: { type: "profile", cwd, profile: updated },
  };
}

function workerPolicyTransition(
  state: FleetState,
  snapshot: FleetSnapshot,
  command: string,
): FleetTransition | undefined {
  return grantToggleTransition(state, snapshot, command, {
    name: "/fable-workers",
    action: "fable-workers",
  })
    ?? cavemanWorkersTransition(state, snapshot, command)
    ?? nvimLayoutTransition(state, command)
    ?? worktreeModeTransition(state, snapshot, command);
}

function policyOrchestrator(snapshot: FleetSnapshot, state: FleetState): SessionRecord | undefined {
  const selected = snapshot.threads.find(({ record }) => record.id === state.selectedSessionId)?.record;
  if (selected?.kind === "orchestrator") return selected;
  return snapshot.threads.find(({ record }) =>
    record.kind === "orchestrator" && record.orchestratorScope === "fleet")?.record
    ?? snapshot.threads.find(({ record }) =>
      record.kind === "orchestrator" && record.cwd === state.fallbackCwd)?.record
    ?? snapshot.threads.find(({ record }) => record.kind === "orchestrator")?.record;
}

function grantToggleNotice(
  label: string,
  result: OrchestratorGrantToggleResult,
): string {
  if (!result.configured) return `${label}: OFF · no orchestrator bound for ${result.key}`;
  return `${label}: ${result.enabled ? "ON" : "OFF"} · ${result.key} · ${result.sessionId}`;
}

function cavemanWorkersNotice(result: CavemanWorkersResult): string {
  return `Caveman workers: ${result.enabled ? "ON" : "OFF"} · box default · orchestrator-spawned workers`;
}

function shortPath(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function relativeTime(timestamp: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(timestamp));
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function statusText(status: string, pendingDelete: boolean, color: boolean): string {
  const label = status.trim();
  if (pendingDelete || label === "Failed") return paint(status, "alert", color);
  // Four states carry a hue: finished, blocked, failing, and the one live thread.
  // Stopping, Stopped and Interrupted are inert, not a request, and stay greyscale.
  if (label === "Done") return paint(status, "done", color);
  if (label === "Needs input") return paint(status, "attention", color);
  if (label === "Working") return paint(status, "working", color);
  return paint(status, "muted", color);
}

function paint(value: string, tone: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[tone]}${value}${ANSI.reset}` : value;
}

function renderNotice(
  notice: string,
  tone: FleetNoticeTone | undefined,
  width: number,
  color: boolean,
): string {
  const value = fit(notice, width);
  if (tone === "warning") return paint(value, "attention", color);
  if (tone === "error" || tone === "confirmation") return paint(value, "alert", color);
  return value;
}

/**
 * What the composer row is collecting: a task to dispatch, a new thread name, a project path, or a
 * shell line.
 */
type ComposerMode = "task" | "rename" | "project" | "shell";

/**
 * Shell mode announces itself with a red `!` and nothing else — no border, no frame. The prefix is
 * painted after the row's width is measured, because escape sequences cost no columns and counting
 * them would shorten every wrap.
 */
const COMPOSER_PROMPTS: Readonly<Record<ComposerMode, {
  prefix: string;
  placeholder: string;
  tone?: keyof typeof ANSI;
}>> = {
  task: { prefix: "›", placeholder: "Describe a task for a new session" },
  rename: { prefix: "Rename ›", placeholder: "Rename thread" },
  project: { prefix: "Project ›", placeholder: "Repository path · tab completes · enter registers" },
  shell: {
    prefix: "!",
    placeholder: "Run a shell command · enter runs · esc or ctrl+g leaves",
    tone: "red",
  },
};

function renderComposerLines(
  value: string,
  mode: ComposerMode,
  options: ResolvedFleetRenderOptions,
): string[] {
  const prompt = COMPOSER_PROMPTS[mode];
  const paintedPrefix = prompt.tone === undefined
    ? prompt.prefix
    : paint(prompt.prefix, prompt.tone, options.color);
  if (value === "") {
    return [`${paintedPrefix} ${paint(prompt.placeholder, "dim", options.color)}`];
  }

  const rows: string[] = [];
  const logicalLines = value.split("\n");
  for (const logicalLine of logicalLines) {
    // Wrapping is measured in cells and cut between grapheme clusters: a row cut by code point
    // overruns the pane on wide text — the terminal then soft-wraps a fragment the fleet never
    // counted — and a cut inside a cluster splits a character from the marks that complete it.
    const clusters = graphemes(logicalLine);
    let offset = 0;
    do {
      const leading = rows.length === 0;
      const prefix = leading ? `${prompt.prefix} ` : "  ";
      const capacity = Math.max(1, options.width - displayWidth(prefix) - 1);
      let end = offset;
      let printed = 0;
      while (end < clusters.length) {
        const cell = graphemeWidth(clusters[end]!);
        if (printed + cell > capacity) break;
        printed += cell;
        end += 1;
      }
      // A cluster wider than the whole row still has to move: no capacity is an empty row forever.
      if (end === offset) end = offset + 1;
      rows.push(`${leading ? `${paintedPrefix} ` : "  "}${clusters.slice(offset, end).join("")}`);
      offset = end;
    } while (offset < clusters.length);
  }

  const maximumRows = Math.max(1, Math.min(12, Math.floor(options.height / 3)));
  if (rows.length <= maximumRows) return rows;
  const visibleRows = rows.slice(-maximumRows);
  visibleRows[0] = `… ${(visibleRows[0] ?? "").slice(2)}`;
  return visibleRows;
}

/** Splits a painted line into plain text and the escape sequences between it. */
const ANSI_SEQUENCE = /(\u001b\[[0-9;]*m)/u;

/**
 * The longest prefix of `value` that prints inside `width` cells.
 *
 * The cut falls between grapheme clusters and the budget is counted in cells, because both of the
 * other answers put text on screen the fleet never counted. A cut by code point splits a character
 * from the marks that complete it, and a budget in code points lets an ideograph print two cells
 * against a one-cell allowance — until the row overruns the pane, the terminal soft-wraps the
 * remainder onto a line of its own, and everything below it moves down one, the composer row and
 * the caret parked on it included.
 */
function cutToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  let printed = 0;
  let cut = "";
  for (const cluster of graphemes(value)) {
    const cell = graphemeWidth(cluster);
    if (printed + cell > width) break;
    printed += cell;
    cut += cluster;
  }
  return cut;
}

/**
 * The columns a composed row prints. Escape sequences steer the terminal rather than filling it, so
 * they cost nothing here — the byte length of a painted row and the cells it occupies are different
 * numbers, and the caret follows the second one.
 */
function printedWidth(value: string): number {
  // Odd parts are the captured escape sequences; even parts are what the terminal shows.
  return value
    .split(ANSI_SEQUENCE)
    .reduce((cells, part, index) => (index % 2 === 1 ? cells : cells + displayWidth(part)), 0);
}

/**
 * A composed row cut to the columns it prints. Escape sequences cost no columns, so they are
 * carried across whole and a cut inside painted text closes its own color: a row truncated
 * mid-sequence would leak the rest of the pane's paint, and one left open would leak its hue.
 */
function clampRowWidth(value: string, width: number): string {
  if (width <= 0) return "";
  const parts = value.split(ANSI_SEQUENCE);
  let printed = 0;
  let painted = false;
  let clamped = "";
  for (const [index, part] of parts.entries()) {
    // Odd parts are the captured escape sequences; even parts are what the terminal shows.
    if (index % 2 === 1) {
      clamped += part;
      painted = part !== ANSI.reset;
      continue;
    }
    for (const cluster of graphemes(part)) {
      // Dashboard tables use tabs. A terminal advances those to the next eight-cell stop, whereas
      // displayWidth correctly counts generic control bytes as zero; expand them here so the row's
      // retained width is the width the terminal will actually occupy.
      const cells = cluster === "\t" ? 8 - (printed % 8) : graphemeWidth(cluster);
      if (printed + cells > width) {
        return painted ? `${clamped}${ANSI.reset}` : clamped;
      }
      clamped += cluster === "\t" ? " ".repeat(cells) : cluster;
      printed += cells;
    }
  }
  return clamped;
}

/**
 * The name a thread is listed under. Stored orchestrator names spell the fleet out in full, which
 * is the right thing for a record and far too wide for a row, so the row abbreviates it. Threads
 * named anything else are listed exactly as they were named.
 */
function displayThreadName(name: string): string {
  const orchestrator = /^Cyberdeck orchestrator \((.+)\)$/u.exec(name);
  return orchestrator === null ? name : `cd-orc (${orchestrator[1]})`;
}

/**
 * The composer's context line, fitted so its key hints outlive its path.
 *
 * `fit` drops the tail, and the tail is where the way out is written. A cwd long enough to push the
 * line past the terminal takes `ctrl+g stops and leaves` off the screen with it — while the command
 * that hint stops is still running, which is the one moment the operator most needs to read it. The
 * path is the part with slack, so the path is the part that gives: leading segments go first and
 * the leaf directory, the part that says *which* checkout this is, is the last to be dropped.
 */
function contextLine(prefix: string, path: string, hints: string, width: number): string {
  const line = `${prefix} · cwd ${path} · ${hints}`;
  if (displayWidth(line) <= width) return line;
  const room = width - displayWidth(`${prefix} · cwd  · ${hints}`);
  // No width even for a one-cell path: nothing to save, so cut the whole line the ordinary way.
  if (room < 1) return fit(line, width);
  return `${prefix} · cwd ${elideLeading(path, room)} · ${hints}`;
}

/** A path narrowed to `width` from the front, dropping whole segments while any remain to drop. */
function elideLeading(path: string, width: number): string {
  if (displayWidth(path) <= width) return path;
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const candidate = `…/${segments.slice(index).join("/")}`;
    if (displayWidth(candidate) <= width) return candidate;
  }
  // The leaf alone is too wide: keep its end, since that is where a worktree's name is.
  const leaf = segments.at(-1) ?? path;
  return width <= 1 ? fit(leaf, width) : `…${cutToWidthFromEnd(leaf, width - 1)}`;
}

/** The last `width` cells of `value`, the mirror of {@link cutToWidth}. */
function cutToWidthFromEnd(value: string, width: number): string {
  if (width <= 0) return "";
  let printed = 0;
  let cut = "";
  for (const cluster of [...graphemes(value)].reverse()) {
    const cell = graphemeWidth(cluster);
    if (printed + cell > width) break;
    printed += cell;
    cut = `${cluster}${cut}`;
  }
  return cut;
}

/** Plain text cut to `width` cells, with an ellipsis in the last one when anything was dropped. */
function fit(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  if (width <= 1) return cutToWidth(value, width);
  return `${cutToWidth(value, width - 1)}…`;
}

function pad(value: string, width: number): string {
  const fitted = fit(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - displayWidth(fitted)))}`;
}

function padStart(value: string, width: number): string {
  return `${" ".repeat(Math.max(0, width - displayWidth(value)))}${value}`;
}
