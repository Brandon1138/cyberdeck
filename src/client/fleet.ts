import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  CavemanWorkersRequest,
  CavemanWorkersResult,
  CreateOrchestratorRequest,
  CursorWorkersRequest,
  CursorWorkersResult,
  FableWorkersRequest,
  FableWorkersResult,
  OrchestratorGrantToggleResult,
} from "../domain/orchestrator.js";
import type {
  FleetOrchestratorCustodyColorView,
  FleetWorkerCoordinationView,
} from "../broker/worker-coordination-view.js";
import type {
  FleetProjectAddResult,
  FleetProjectRemoveResult,
} from "../broker/fleet-project-service.js";
import type { CustodyColor } from "../domain/custody-color.js";
import type { ProviderId, ReasoningEffort, SessionRecord, StartSessionRequest } from "../domain/session.js";
import { ORCHESTRATOR_CATALOG } from "../orchestration/orchestrator-catalog.js";
import { WORKER_PROVIDER_CAPABILITIES } from "../orchestration/worker-capabilities.js";
import { appStateDirectory } from "../paths.js";
import {
  ProviderPermissionPreferenceStore,
  type ProviderPermissionPreferencePort,
  type ProviderPermissionPreferences,
} from "../persistence/provider-permission-preference-store.js";
import { conversationPreview } from "../runtime/conversation-preview.js";
import type { ShellCommandResult } from "../runtime/shell-command.js";
import { providerTerminalActivity, stripTerminalControl } from "../runtime/terminal-replay.js";
import { attachSession, type AttachTransport } from "./attach.js";
import {
  capturePasteboardImage,
  draftWithImageReference,
  type PasteboardImageAttachment,
} from "./clipboard-image.js";
import { collectDashboardSnapshot, renderDashboard } from "./dashboard.js";
import {
  OCTOPUS_MARK,
  OCTOPUS_SPLASH,
  pixelArtHeight,
  pixelArtWidth,
  renderPixelArt,
} from "./octopus.js";
import {
  custodyColorTone,
  leaseCustody,
  leaseCustodyBadge,
  leaseCustodySummary,
  uniformLeaseCustody,
  type LeaseCustody,
  type LeaseCustodyBadge,
} from "./lease-custody.js";
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
  pullRequestGlyph,
  type PullRequestState,
  type PullRequestStatusPort,
} from "./pr-status.js";
import { RpcError } from "./rpc-client.js";

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
   * Which orchestrator this row belongs to, in hue. A worker takes it from the broker's custody
   * projection; an orchestrator wears its own slot, always at full intensity while it is bound.
   */
  custodyColor?: CustodyColor;
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

export type OrchestratorPickerState =
  | { step: "target"; choiceIndex: number }
  | { step: "effort"; modelIndex: number; effortIndex: number };

export interface LaunchProfile {
  provider: ProviderId;
  model: string;
  effort?: ReasoningEffort;
}

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
  workerPicker?: WorkerPickerState | undefined;
  commandPalette?: CommandPaletteState | undefined;
  permissionPicker?: PermissionPickerState | undefined;
  launchProfiles: Record<string, LaunchProfile>;
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
  | { type: "cursor-workers"; request: CursorWorkersRequest }
  | { type: "caveman-workers"; request: CavemanWorkersRequest }
  | { type: "nvim-layout"; enabled: boolean }
  | { type: "open-worktree"; sessionId: string }
  | { type: "rename"; sessionId: string; name: string }
  | { type: "pin"; sessionId: string }
  | { type: "reorder"; sessionId: string; direction: "up" | "down" }
  | { type: "profile"; cwd: string; profile: LaunchProfile }
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
  /** Pull-request state per worktree, read synchronously from an async cache. */
  pullRequests?: ReadonlyMap<string, PullRequestState> | undefined;
}

interface ResolvedFleetRenderOptions {
  color: boolean;
  width: number;
  height: number;
  now: number;
  home: string;
  pullRequests: ReadonlyMap<string, PullRequestState>;
}

interface WorkerModelChoice {
  provider: ProviderId;
  model: string;
  label: string;
  efforts: readonly (ReasoningEffort | "provider-managed")[];
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
  | "/cursor-workers"
  | "/caveman-workers"
  | "/nvim-settings";

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
    name: "/cursor-workers",
    description: "Inspect or toggle Cursor workers",
    values: [
      { value: "status", description: "Show current Cursor worker grant" },
      { value: "on", description: "Enable Cursor workers" },
      { value: "off", description: "Disable Cursor workers" },
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
];
const WORKER_MODEL_CHOICES: readonly WorkerModelChoice[] = WORKER_PROVIDER_CAPABILITIES.flatMap((capability) =>
  (capability.provider === "antigravity" ? ["gemini-3.6-flash"] : capability.models)
    .map((model): WorkerModelChoice => ({
    provider: capability.provider,
    model,
    label: friendlyModel(capability.provider, model),
    efforts: capability.efforts.length === 0
        ? ["provider-managed"]
        : capability.efforts,
    })),
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

  // Custody. Six hues, one per orchestrator, worn by the leading glyph alone.
  //
  // They sit away from every status hue above — no amber, no green, no ice, no red — so a
  // custody hue can never be misread as a state. Each has a dimmed twin at the same hue angle
  // for workers whose lease has ended: legibly the same orchestrator, visibly no longer live.

  custody1: "\u001b[38;2;104;178;168m",
  custody2: "\u001b[38;2;112;156;204m",
  custody3: "\u001b[38;2;140;142;216m",
  custody4: "\u001b[38;2;198;138;186m",
  custody5: "\u001b[38;2;154;178;108m",
  custody6: "\u001b[38;2;200;142;110m",
  custody1Faded: "\u001b[38;2;62;107;101m",
  custody2Faded: "\u001b[38;2;67;94;122m",
  custody3Faded: "\u001b[38;2;84;85;130m",
  custody4Faded: "\u001b[38;2;119;83;112m",
  custody5Faded: "\u001b[38;2;92;107;65m",
  custody6Faded: "\u001b[38;2;120;85;66m",
} as const;

/** Gutter cell that prefixes every navigable row; carries the selection rule. */
const SELECTION_RULE = "▌";
const ROW_GUTTER = "  ";

export async function collectFleetSnapshot(client: FleetTransport): Promise<FleetSnapshot> {
  const sessions = await client.request<SessionRecord[]>("session.list", {});
  const coordination = await client.request<FleetWorkerCoordinationView[]>(
    "fleet.workerCoordination",
    {},
  ).catch(() => []);
  const coordinationBySession = new Map(
    coordination.map((entry) => [entry.sessionId, entry] as const),
  );
  // Orchestrator hues come from the bindings, which the coordination projection does not carry.
  // A broker too old to answer leaves every orc neutral rather than failing the snapshot.
  const orchestratorColors = new Map(
    (await client.request<FleetOrchestratorCustodyColorView[]>("fleet.custodyColors", {})
      .catch(() => []))
      .map((entry) => [entry.sessionId, entry.slot] as const),
  );
  // Undefined rather than empty when the broker has no registry: an empty list is an answer, and
  // grouping every thread under "Unregistered" is the wrong answer to a question nobody asked.
  const projects = await client.request<string[]>("fleet.projects", {})
    .then((roots) => roots as readonly string[] | undefined, () => undefined);
  const threads = await Promise.all(sessions.map(async (record): Promise<FleetThread | null> => {
    try {
      const snapshot = await client.request<{ data: string }>("session.snapshot", {
        sessionId: record.id,
      });
      const workerCoordination = coordinationBySession.get(record.id);
      const orchestratorSlot = orchestratorColors.get(record.id);
      const color: CustodyColor | undefined = orchestratorSlot === undefined
        ? workerCoordination?.custodyColor
        : { slot: orchestratorSlot, intensity: "active" };
      return {
        record,
        replay: Buffer.from(snapshot.data, "base64").toString("utf8"),
        ...(workerCoordination === undefined ? {} : { coordination: workerCoordination }),
        ...(color === undefined ? {} : { custodyColor: color }),
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
    return transitionOrchestratorPicker(state, snapshot, key);
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
    return startTransition(state, undefined, initialPrompt);
  }
  if (
    key === "up"
    || key === "down"
    || key === "pageup"
    || key === "pagedown"
    || key === "ctrl+u"
    || key === "ctrl+d"
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
                    : key === "ctrl+u"
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
  const width = Math.max(50, options.width ?? 120);
  const height = Math.max(16, options.height ?? 32);
  const now = options.now ?? Date.now();
  const color = options.color ?? true;
  const home = options.home ?? homedir();
  const pullRequests = options.pullRequests ?? new Map();
  const resolved = { width, height, now, color, home, pullRequests };
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
      return command.name === "/model"
        ? openWorkerPicker(closed, snapshot, "")
        : openPermissionPicker(closed, snapshot);
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
  const body = lines.slice(0, Math.max(0, options.height - footer.length));
  while (body.length < options.height - footer.length) body.push("");
  return [...body, ...footer].join("\n");
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
  const modelIndex = current === undefined
    ? 0
    : Math.max(0, WORKER_MODEL_CHOICES.findIndex((choice) =>
      choice.provider === current.provider
      && (choice.model === current.model
        || (choice.provider === "antigravity" && current.model.startsWith(`${choice.model}-`)))));
  const choice = WORKER_MODEL_CHOICES[modelIndex]!;
  const effortIndex = current?.effort === undefined
    ? 0
    : Math.max(0, choice.efforts.indexOf(current.effort));
  return {
    state: {
      ...state,
      draft: "",
      helpOpen: false,
      notice: undefined,
      workerPicker: { step: "model", modelIndex, effortIndex, cwd, returnDraft },
    },
  };
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
            modelIndex: boundedIndex(picker.modelIndex + delta, WORKER_MODEL_CHOICES.length),
            effortIndex: 0,
          },
        },
      };
    }
    const choice = WORKER_MODEL_CHOICES[picker.modelIndex]!;
    return {
      state: {
        ...state,
        workerPicker: {
          ...picker,
          effortIndex: boundedIndex(picker.effortIndex + delta, choice.efforts.length),
        },
      },
    };
  }
  if (key !== "enter") return { state };
  if (picker.step === "model") {
    return { state: { ...state, workerPicker: { ...picker, step: "effort", effortIndex: 0 } } };
  }
  const choice = WORKER_MODEL_CHOICES[picker.modelIndex]!;
  const effort = choice.efforts[picker.effortIndex]!;
  const model = choice.provider === "antigravity" && effort !== "provider-managed"
    ? `${choice.model}-${effort}`
    : choice.model;
  const profile: LaunchProfile = {
    provider: choice.provider,
    model,
    ...(effort === "provider-managed" ? {} : { effort }),
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
  const choice = WORKER_MODEL_CHOICES[picker.modelIndex]!;
  const lines = renderHeader([], state, options);
  lines.push("");
  let range = "";
  if (picker.step === "model") {
    lines.push("Choose a model", "");
    const total = WORKER_MODEL_CHOICES.length;
    const visibleRows = Math.max(1, options.height - 3 - lines.length);
    const offset = pickerScrollOffset(picker.modelIndex, total, visibleRows);
    lines.push(...WORKER_MODEL_CHOICES.slice(offset, offset + visibleRows).map((model, index) =>
      pickerRow(
        `${model.label}  ${paint(model.provider, "dim", options.color)}`,
        offset + index === picker.modelIndex,
        options.color,
      )));
    if (total > visibleRows) {
      range = ` · ${offset + 1}-${Math.min(total, offset + visibleRows)} of ${total}`;
    }
  } else {
    lines.push(`${choice.label} effort`, "");
    lines.push(...choice.efforts.map((effort, index) =>
      pickerRow(friendlyEffort(effort), index === picker.effortIndex, options.color)));
  }
  const footer = [
    paint("─".repeat(options.width), "dim", options.color),
    paint(fit(`${choice.label} · ${shortPath(picker.cwd, options.home)}`, options.width), "muted", options.color),
    paint(fit(`↑↓ select · enter apply/next · esc back${range}`, options.width), "dim", options.color),
  ];
  const body = lines.slice(0, Math.max(0, options.height - footer.length));
  while (body.length < options.height - footer.length) body.push("");
  return [...body, ...footer].join("\n");
}

function renderFleetList(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const threads = orderedThreads(snapshot);
  const header = [...renderHeader(threads, state, options), ""];

  // The column only exists once some thread actually has a pull request, so a
  // fleet without `gh` — or without PRs — never pays for it.
  const pullRequestColumn = threads.some(({ record }) =>
    options.pullRequests.get(record.cwd) !== undefined);
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
            pullRequestColumn,
            leaseBadgeWidth,
            row.leaseBadge,
            worktreeWidth,
            row.worktree,
            indicator,
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
    ? `▶ ${shellName()} -lc${state.shellMode.running === true ? " · running" : ""} · cwd ${shortPath(cwd, options.home)} · enter runs · ${state.shellMode.running === true ? "ctrl+g stops and leaves" : "esc or ctrl+g leaves"}`
    : profile === undefined
    ? `▶ /model required · ${selected?.record.sandbox ?? "read-only"} · cwd ${shortPath(cwd, options.home)} · ctrl+s change`
    : `▶ ${friendlyModel(profile.provider, profile.model)} · ${friendlyEffort(profile.effort ?? "provider-managed")} · ${selected?.record.sandbox ?? "read-only"} · cwd ${shortPath(cwd, options.home)} · ctrl+s change`;
  const helpLines = state.helpOpen === true
    ? shortcutHelp(options.width, terminal && stopAcknowledged ? "delete" : "stop")
    : [];
  const footer = [
    ...(state.notice === undefined ? [] : [renderNotice(state.notice, state.noticeTone, options.width, options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    ...composerLines,
    paint("─".repeat(options.width), "dim", options.color),
    ...helpLines.map((line) => paint(fit(line, options.width), "dim", options.color)),
    paint(fit(launchContext, options.width), "dim", options.color),
    paint(fit(`↑↓ · pgup/dn · ctrl+u/d half · home/end · enter open/start · ctrl+] detach/reattach · ctrl+n nvim · ? more · ${destructiveHint}`, options.width), "dim", options.color),
  ];
  return footer;
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
    ...renderPixelArt(OCTOPUS_SPLASH, options.color).map((line) => `${indent}${line}`),
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
  const mark = renderPixelArt(OCTOPUS_MARK, options.color);
  return Array.from(
    { length: Math.max(mark.length, textLines.length) },
    (_, index) => `${mark[index] ?? " ".repeat(markWidth)}  ${textLines[index] ?? ""}`,
  );
}

function shortcutHelp(width: number, destructive: "stop" | "delete"): string[] {
  const entries = [
    "pgup/dn page", "ctrl+u/d half", "home/end", "shift+↑↓ reorder", "←→ fold project",
    "a add project", "d remove project", "ctrl+w switch views",
    "@ mention", "alt+1–9 open", "esc back/clear",
    "ctrl+r rename", "ctrl+j/opt+enter newline", "ctrl+v paste image", "ctrl+] detach/reattach", "ctrl+n nvim", "! shell", "ctrl+s shell popup", "ctrl+t pin to top", "ctrl+l lease detail", `ctrl+x ${destructive}`, "? close",
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

function transitionOrchestratorPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const picker = state.orchestratorPicker!;
  if (key === "escape") {
    return {
      state: {
        ...state,
        orchestratorPicker: picker.step === "effort"
          ? {
              step: "target",
              choiceIndex: existingOrchestrators(snapshot).length + picker.modelIndex,
            }
          : undefined,
        notice: undefined,
      },
    };
  }

  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    if (picker.step === "target") {
      return {
        state: {
          ...state,
          orchestratorPicker: {
            ...picker,
            choiceIndex: boundedIndex(
              picker.choiceIndex + delta,
              existingOrchestrators(snapshot).length + ORCHESTRATOR_MODEL_CHOICES.length,
            ),
          },
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

  if (key !== "enter") return { state };
  if (picker.step === "target") {
    const existing = existingOrchestrators(snapshot);
    const selectedExisting = existing[picker.choiceIndex];
    if (selectedExisting !== undefined) {
      if (selectedExisting.attachmentState === "controlled") {
        return {
          state: {
            ...state,
            notice: "Orchestrator is in use by another controller",
            noticeTone: "warning",
          },
        };
      }
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
    const modelIndex = picker.choiceIndex - existing.length;
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

  if (picker.step === "target") {
    const existing = existingOrchestrators(snapshot);
    lines.push("Existing orchestrators", "");
    if (existing.length === 0) {
      lines.push(paint("  No interactive orchestrators", "dim", options.color));
    } else {
      lines.push(...existing.map((record, index) =>
        pickerRow(existingOrchestratorLabel(record, options.color), index === picker.choiceIndex, options.color)));
    }
    lines.push("", "New orchestrator", "");
    lines.push(...ORCHESTRATOR_MODEL_CHOICES.map((choice, index) =>
      pickerRow(
        `${choice.label}  ${paint(choice.provider.label, "dim", options.color)}`,
        existing.length + index === picker.choiceIndex,
        options.color,
      )));
  } else {
    lines.push(`${selection!.provider.label} effort`, "");
    lines.push(...selection!.provider.efforts.map((effort, index) =>
      pickerRow(effort === "native-default" ? "Provider managed" : effort, index === picker.effortIndex, options.color)));
  }

  const footer = [
    ...(state.notice === undefined ? [] : [renderNotice(state.notice, state.noticeTone, options.width, options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    ...(selection === undefined
      ? []
      : [paint(fit(`${selection.provider.label} · ${selection.model} · ${selection.effort ?? "Provider managed"}`, options.width), "muted", options.color)]),
    paint(
      fit(picker.step === "effort"
        ? "↑↓ select · enter create in cockpit · esc back"
        : "↑↓ select · enter focus/next · esc back", options.width),
      "dim",
      options.color,
    ),
  ];
  const body = lines.slice(0, Math.max(0, options.height - footer.length));
  while (body.length < options.height - footer.length) body.push("");
  return [...body, ...footer].join("\n");
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

function initialOrchestratorPicker(_snapshot: FleetSnapshot, _cwd: string): OrchestratorPickerState {
  return { step: "target", choiceIndex: 0 };
}

function existingOrchestrators(snapshot: FleetSnapshot): SessionRecord[] {
  return orderedThreads(snapshot)
    .map(({ record }) => record)
    .filter((record) =>
      record.kind === "orchestrator"
      && record.role === "orchestrator"
      && (
        record.executionState === "active"
        // A `starting` orc is healthy and already the operator's; leaving it out of the picker
        // is what made them start a second one while the first was still coming up.
        || record.executionState === "starting"
        || (
          record.executionState === "cancelled"
          // `done` joins `interrupted` here because a broker shutdown now preserves the outcome of
          // an orchestrator that had finished its turn; it is still reconnectable.
          && (record.attentionState === "interrupted" || record.attentionState === "done")
        )
      ));
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
        : paint("reconnect", "yellow", color);
  return `${name}  ${paint(record.id.slice(0, 8), "dim", color)}  ${lifecycle}`;
}

function pickerRow(value: string, selected: boolean, color: boolean): string {
  return `${paint(selected ? "›" : "·", selected ? "bold" : "dim", color)} ${selected ? paint(value, "bold", color) : value}`;
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
): string {
  if (focused) return `${paint(SELECTION_RULE, "selection", color)} `;
  if (scrollbar === "thumb") return `${paint("┃", "subtle", color)} `;
  if (scrollbar === "track") return `${paint("│", "dim", color)} `;
  return ROW_GUTTER;
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
  pullRequestColumn = false,
  leaseBadgeWidth = 0,
  leaseBadge?: LeaseCustodyBadge | undefined,
  worktreeWidth = 0,
  worktree?: string | undefined,
  scrollbar?: "track" | "thumb" | undefined,
): string {
  const selected = !threadFocusInert(state)
    && thread.record.id === state.selectedSessionId;
  const baseTitle = displayThreadName(
    thread.record.name ?? thread.record.role ?? `Untitled ${thread.record.id.slice(0, 8)}`,
  );
  const title = `${thread.record.pinned === true ? "⌃ " : ""}${baseTitle}`;
  const identity = `${friendlyModel(thread.record.provider, thread.record.model)} · ${friendlyEffort(thread.record.effort ?? "provider-managed")}`;
  const status = threadStatus(thread);
  const age = relativeTime(thread.record.meaningfulUpdatedAt ?? thread.record.updatedAt, options.now);
  const showIdentity = options.width >= 80;
  const titleWidth = showIdentity
    ? Math.min(38, Math.max(22, Math.floor(options.width * 0.28)))
    : Math.min(28, Math.max(16, Math.floor(options.width * 0.38)));
  const identityWidth = showIdentity
    ? Math.min(20, Math.max(12, Math.floor(options.width * 0.15)))
    : 0;
  const statusWidth = 11;
  const fixedWidth = 12 + titleWidth + statusWidth
    + (showIdentity ? identityWidth + 1 : 0)
    + (pullRequestColumn ? 2 : 0)
    + (leaseBadgeWidth === 0 ? 0 : leaseBadgeWidth + 1)
    + (worktreeWidth === 0 ? 0 : worktreeWidth + 1);
  const previewWidth = Math.max(1, options.width - fixedWidth);
  const preview = threadPreview(thread, previewWidth);
  return [
    `${rowGutter(selected, options.color, scrollbar)}${statusMarker(status, selected, options.color, thread.custodyColor)}`,
    titleCell(thread, pad(title, titleWidth), selected, options.color),
    ...(leaseBadgeWidth === 0
      ? []
      : [leaseBadgeCell(leaseBadge, leaseBadgeWidth, options.color)]),
    ...(worktreeWidth === 0
      ? []
      : [paint(pad(fit(worktree ?? "", worktreeWidth), worktreeWidth), "subtle", options.color)]),
    ...(pullRequestColumn
      ? [pullRequestCell(options.pullRequests.get(thread.record.cwd), options.color)]
      : []),
    ...(showIdentity ? [paint(pad(identity, identityWidth), "subtle", options.color)] : []),
    statusText(pad(status, statusWidth), false, options.color),
    paint(pad(preview, previewWidth), "muted", options.color),
    padStart(age, 5),
  ].join(" ");
}

/**
 * The title cell.
 *
 * An orchestrator wears its custody hue on its name as well as its glyph, because the name is
 * what its workers' glyphs have to be matched against. Workers keep the neutral title: hue on
 * both would read as a colored row, which is what the glyph-only rule exists to prevent.
 */
function titleCell(
  thread: FleetThread,
  title: string,
  selected: boolean,
  color: boolean,
): string {
  const custody = thread.record.kind === "orchestrator" && thread.custodyColor !== undefined
    ? custodyColorTone(thread.custodyColor)
    : undefined;
  if (custody === undefined) return paint(title, selected ? "bold" : "muted", color);
  const painted = paint(title, custody, color);
  return selected ? paint(painted, "bold", color) : painted;
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

/** A thread with no known pull request holds the column open and shows nothing. */
function pullRequestCell(state: PullRequestState | undefined, color: boolean): string {
  if (state === undefined) return " ";
  const { glyph, tone } = pullRequestGlyph(state);
  return paint(glyph, tone, color);
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
  custody?: CustodyColor | undefined,
): string {
  const statusTone = status === "Done"
    ? "done"
    : status === "Needs input"
      ? "attention"
      : status === "Failed"
        ? "alert"
        : status === "Working"
          ? "working"
          : "muted";
  // Custody outranks status on the glyph alone: the status hue survives in the status-text
  // column, so nothing is lost, and the glyph is the one cell every row already has.
  const tone = (custody === undefined ? undefined : custodyColorTone(custody)) ?? statusTone;
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
  let stopped = false;
  let attaching = false;
  let wake: (() => void) | undefined;
  let inputQueue = Promise.resolve();
  const keyDecoder = new FleetKeyDecoder();
  let decoderFlushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set while a `!` line is running, so the key that leaves the shell can reach it. */
  let shellInterrupt: AbortController | undefined;
  const notify = () => { wake?.(); };
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
        output.write(ENTER_FLEET_SCREEN);
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
        output.write(ENTER_FLEET_SCREEN);
        snapshot = await collectFleetSnapshot(client);
      }
      notify();
    }
  };

  const perform = async (key: string) => {
    const width = Math.max(50, output.columns ?? 120);
    const height = Math.max(16, output.rows ?? 32);
    const renderOptions: ResolvedFleetRenderOptions = {
      color: output.isTTY === true,
      width,
      height,
      now: Date.now(),
      home: homedir(),
      pullRequests: pullRequestStatus.states(),
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
        await client.request("session.delete", { sessionId: action.sessionId });
        snapshot = await collectFleetSnapshot(client);
        const remaining = orderedThreads(snapshot);
        state = {
          ...state,
          selectedSessionId: remaining[selectedIndex]?.record.id ?? remaining[selectedIndex - 1]?.record.id,
          notice: "Deleted thread",
          noticeTone: "neutral",
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
      } else if (action?.type === "cursor-workers") {
        const result = await client.request<CursorWorkersResult>(
          "orchestrator.cursorWorkers",
          action.request,
        );
        state = {
          ...state,
          notice: grantToggleNotice("Cursor workers", result),
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
      } else if (action?.type === "attach-clipboard-image") {
        const image = await pasteboardImage();
        if (image !== undefined) {
          state = {
            ...state,
            draft: draftWithImageReference(state.draft, image),
            notice: `Attached ${basename(image)}`,
            noticeTone: "neutral",
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
  const onResize = () => { notify(); };
  signals.on("SIGINT", onSigint);
  signals.on("SIGTERM", stop);
  signals.on("SIGWINCH", onResize);
  output.write(ENTER_FLEET_SCREEN);

  try {
    while (!stopped) {
      if (attaching) {
        await waitForRefresh((resume) => { wake = resume; }, () => { wake = undefined; });
        continue;
      }
      snapshot = await collectFleetSnapshot(client);
      state = normalizeState(state, snapshot, Date.now());
      pullRequestStatus.refresh(snapshot.threads.map(({ record }) => record.cwd));
      const height = Math.max(16, output.rows ?? 32);
      const width = Math.max(50, output.columns ?? 120);
      if (state.view === "diagnostics") {
        const diagnostics = renderDashboard(await collectDashboardSnapshot(client)).split("\n");
        const footer = [
          ...(state.notice === undefined ? [] : [renderNotice(state.notice, state.noticeTone, width, output.isTTY === true)]),
          paint("─".repeat(width), "dim", output.isTTY === true),
          "ctrl+w Fleet · ctrl+c twice to exit",
        ];
        const body = diagnostics.slice(0, Math.max(0, height - footer.length));
        while (body.length < height - footer.length) body.push("");
        output.write(`\u001b[2J\u001b[H${[...body, ...footer].join("\n")}\u001b[?25l`);
      } else {
        const renderOptions = {
          color: output.isTTY === true,
          width,
          height,
          pullRequests: pullRequestStatus.states(),
        };
        state = normalizeThreadListViewport(snapshot, state, {
          ...renderOptions,
          now: Date.now(),
          home: homedir(),
        });
        const rendered = renderFleet(snapshot, state, renderOptions);
        const cursor = composerCursor(rendered, state, width);
        output.write(`\u001b[2J\u001b[H${rendered}\u001b[${cursor.row};${cursor.column}H\u001b[?25h`);
      }
      await waitForRefresh((resume) => { wake = resume; }, () => { wake = undefined; });
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
    }, 500);
    register(() => {
      clearTimeout(timer);
      clear();
      resolve();
    });
  });
}

function composerCursor(rendered: string, state: FleetState, width: number): { row: number; column: number } {
  const lines = rendered.split("\n");
  const value = state.rename?.draft ?? state.draft;
  const divider = "─".repeat(width);
  const lowerDividerIndex = lines.findLastIndex((line) => stripTerminalControl(line) === divider);
  const rowIndex = Math.max(0, lowerDividerIndex - 1);
  const visibleLine = stripTerminalControl(lines[rowIndex] ?? "");
  const emptyColumn = state.rename === undefined ? 3 : 10;
  return {
    row: Math.max(1, rowIndex + 1),
    column: value === ""
      ? emptyColumn
      : Math.min(width, [...visibleLine].length + 1),
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
    ...(confirmationExpired
      ? { notice: undefined }
      : {}),
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
  const orcRows: FleetListRow[] = orcs.length === 0
    ? []
    : orcSectionRows(orcs, state);
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
      ...sectionRows(WORKERS_SECTION_LABEL, visible, threads, state, cwd),
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
function orcSectionRows(orcs: readonly FleetThread[], state: FleetState): FleetListRow[] {
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
    ...threadRows(visible, state, undefined),
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
  root?: string | undefined,
): FleetListRow[] {
  // A section whose workers all share one custody says it once on the heading, and
  // its rows go bare: a badge repeated down the whole group is a column of noise.
  const rollup = uniformLeaseCustody(all.map(threadLeaseCustody));
  return [
    { kind: "section", label: sectionLabel(label, all.length, rollup) },
    ...threadRows(visible, state, rollup, root),
  ];
}

/** The thread rows of one section, each with the ownership line it owns when detail is on. */
function threadRows(
  visible: readonly FleetThread[],
  state: FleetState,
  rollup: LeaseCustody | undefined,
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
      : worktreeTag(thread.record.cwd, root);
    return [
      {
        kind: "thread",
        cwd: thread.record.cwd,
        thread,
        ...(badge === undefined ? {} : { leaseBadge: badge }),
        ...(worktree === undefined ? {} : { worktree }),
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
 * Most recent first. Ties fall back to the operator's own ordering — pinned, then explicit
 * reorder, then age — so threads that share a timestamp still hold a stable position.
 */
function byRecency(left: FleetThread, right: FleetThread): number {
  const recency = lastActivity(right.record).localeCompare(lastActivity(left.record));
  if (recency !== 0) return recency;
  if (left.record.pinned !== right.record.pinned) return left.record.pinned === true ? -1 : 1;
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

/** What a worker's row says about where under its project it actually lives. */
function worktreeTag(cwd: string, root: string): string | undefined {
  return cwd === root ? undefined : cwd.slice(root.length + 1);
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
    const root = projectRootFor(thread.record.cwd, roots);
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
  return known[model] ?? `${titleCase(provider)} ${model}`;
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
  grant: { name: "/fable-workers" | "/cursor-workers"; action: "fable-workers" | "cursor-workers" },
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

function workerPolicyTransition(
  state: FleetState,
  snapshot: FleetSnapshot,
  command: string,
): FleetTransition | undefined {
  return grantToggleTransition(state, snapshot, command, {
    name: "/fable-workers",
    action: "fable-workers",
  })
    ?? grantToggleTransition(state, snapshot, command, {
      name: "/cursor-workers",
      action: "cursor-workers",
    })
    ?? cavemanWorkersTransition(state, snapshot, command)
    ?? nvimLayoutTransition(state, command);
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
  return `Caveman workers: ${result.enabled ? "ON" : "OFF"} · box default · new workers`;
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
    const characters = [...logicalLine];
    let offset = 0;
    do {
      const leading = rows.length === 0;
      const prefix = leading ? `${prompt.prefix} ` : "  ";
      const capacity = Math.max(1, options.width - [...prefix].length - 1);
      const segment = characters.slice(offset, offset + capacity).join("");
      rows.push(`${leading ? `${paintedPrefix} ` : "  "}${segment}`);
      offset += capacity;
    } while (offset < characters.length);
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
    const characters = [...part];
    if (printed + characters.length <= width) {
      clamped += part;
      printed += characters.length;
      continue;
    }
    clamped += characters.slice(0, width - printed).join("");
    return painted ? `${clamped}${ANSI.reset}` : clamped;
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

function fit(value: string, width: number): string {
  const characters = [...value];
  if (characters.length <= width) return value;
  if (width <= 1) return characters.slice(0, width).join("");
  return `${characters.slice(0, width - 1).join("")}…`;
}

function pad(value: string, width: number): string {
  const fitted = fit(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - [...fitted].length))}`;
}

function padStart(value: string, width: number): string {
  return `${" ".repeat(Math.max(0, width - [...value].length))}${value}`;
}
