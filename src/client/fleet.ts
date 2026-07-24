import { homedir } from "node:os";
import type {
  CavemanWorkersRequest,
  CavemanWorkersResult,
  CreateOrchestratorRequest,
  FableWorkersRequest,
  FableWorkersResult,
} from "../domain/orchestrator.js";
import type { ProviderId, ReasoningEffort, SessionRecord, StartSessionRequest } from "../domain/session.js";
import { ORCHESTRATOR_CATALOG } from "../orchestration/orchestrator-catalog.js";
import { WORKER_PROVIDER_CAPABILITIES } from "../orchestration/worker-capabilities.js";
import { latestTerminalPreview, providerTerminalActivity, stripTerminalControl } from "../runtime/terminal-replay.js";
import { attachSession, type AttachTransport } from "./attach.js";
import { collectDashboardSnapshot, renderDashboard } from "./dashboard.js";
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
}

export interface FleetSnapshot {
  threads: FleetThread[];
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

export interface WorkerPickerState {
  step: "model" | "effort";
  modelIndex: number;
  effortIndex: number;
  cwd: string;
  returnDraft: string;
}

export interface RenameState {
  sessionId: string;
  draft: string;
}

export type FleetNoticeTone = "neutral" | "warning" | "error" | "confirmation";

export interface FleetState {
  selectedSessionId?: string | undefined;
  fallbackCwd: string;
  workingDirectory?: string | undefined;
  draft: string;
  stopAcknowledgement?: StopAcknowledgement | undefined;
  deleteConfirmation?: DeleteConfirmation | undefined;
  quitConfirmation?: QuitConfirmation | undefined;
  orchestratorPicker?: OrchestratorPickerState | undefined;
  workerPicker?: WorkerPickerState | undefined;
  launchProfiles: Record<string, LaunchProfile>;
  view: "fleet" | "diagnostics";
  helpOpen?: boolean | undefined;
  rename?: RenameState | undefined;
  notice?: string | undefined;
  noticeTone?: FleetNoticeTone | undefined;
}

export type FleetAction =
  | { type: "stop-tree"; sessionId: string }
  | { type: "delete-tree"; sessionId: string }
  | { type: "attach"; sessionId: string }
  | { type: "resume"; sessionId: string }
  | { type: "start"; request: StartSessionRequest & { initialPrompt: string } }
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
  | { type: "rename"; sessionId: string; name: string }
  | { type: "pin"; sessionId: string }
  | { type: "reorder"; sessionId: string; direction: "up" | "down" }
  | { type: "profile"; cwd: string; profile: LaunchProfile }
  | { type: "change-directory"; cwd: string }
  | { type: "quit" };

export interface FleetTransition {
  state: FleetState;
  action?: FleetAction;
}

export type ThreadStatus = "Working" | "Needs input" | "Done" | "Stopping" | "Stopped" | "Interrupted" | "Failed";

export interface FleetRenderOptions {
  color?: boolean | undefined;
  width?: number | undefined;
  height?: number | undefined;
  now?: number | undefined;
  home?: string | undefined;
}

interface ResolvedFleetRenderOptions {
  color: boolean;
  width: number;
  height: number;
  now: number;
  home: string;
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

interface SessionTreeProgress {
  rootSessionId: string;
  rootKind: "worker" | "orchestrator";
  childCount: number;
  total: number;
  active: number;
  stopping: number;
  terminal: number;
  deleted?: number;
}

export interface FleetRuntimeOptions {
  changeDirectory?: ((cwd: string) => Promise<string | undefined>) | undefined;
  detachIdentity?: string | undefined;
  openOrchestrator?: ((target: OrchestratorCockpitTarget) => Promise<SessionRecord>) | undefined;
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
].join("");
const ENTER_FLEET_SCREEN = `${DISABLE_INHERITED_TERMINAL_INPUT_MODES}\u001b[?1049h\u001b[?25l`;
const LEAVE_FLEET_SCREEN = `${DISABLE_INHERITED_TERMINAL_INPUT_MODES}\u001b[?25h\u001b[?1049l`;

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  blue: "\u001b[38;2;158;182;255m",
  purple: "\u001b[38;2;182;158;255m",
  cyan: "\u001b[38;2;102;194;208m",
  yellow: "\u001b[38;2;212;168;91m",
  green: "\u001b[38;2;120;198;121m",
  red: "\u001b[38;2;217;108;117m",
  gray: "\u001b[38;2;123;132;144m",
} as const;

export async function collectFleetSnapshot(client: FleetTransport): Promise<FleetSnapshot> {
  const sessions = await client.request<SessionRecord[]>("session.list", {});
  const threads = await Promise.all(sessions.map(async (record): Promise<FleetThread | null> => {
    try {
      const snapshot = await client.request<{ data: string }>("session.snapshot", {
        sessionId: record.id,
      });
      return { record, replay: Buffer.from(snapshot.data, "base64").toString("utf8") };
    } catch (error) {
      if (error instanceof RpcError && error.code === "SESSION_NOT_FOUND") return null;
      throw error;
    }
  }));
  return { threads: threads.filter((thread): thread is FleetThread => thread !== null) };
}

export function createFleetState(snapshot: FleetSnapshot, fallbackCwd = process.cwd()): FleetState {
  return {
    selectedSessionId: orderedThreads(snapshot)[0]?.record.id,
    fallbackCwd,
    draft: "",
    launchProfiles: {},
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
    case "cancelled": return thread.record.exitCode === null ? "Stopping" : "Stopped";
    case "active": {
      const activity = providerTerminalActivity(thread.record.provider, thread.replay);
      if (activity === "working") return "Working";
      if (activity === "needs-input") return "Needs input";
      return "Done";
    }
  }
}

export function transitionFleet(
  current: FleetState,
  snapshot: FleetSnapshot,
  key: string,
  now = Date.now(),
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
  const selected = threads.find(({ record }) => record.id === state.selectedSessionId);

  if (key === "ctrl+s") {
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

  if (state.workerPicker !== undefined) {
    return transitionWorkerPicker(state, key);
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

  if (key === "ctrl+g") {
    return {
      state: { ...state, helpOpen: false, notice: undefined },
      action: { type: "change-directory", cwd: composerCwd(state, snapshot) },
    };
  }

  if (key === "ctrl+]") {
    if (selected?.record.kind !== "orchestrator") {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: "Select a detached orchestrator to attach to the cockpit",
          noticeTone: "neutral",
        },
      };
    }
    if (selected.record.attachmentState === "controlled") {
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
        sessionId: selected.record.id,
        cockpitCwd: state.fallbackCwd,
        requiresResume: selected.record.executionState !== "active"
          && selected.record.executionState !== "starting",
      },
    };
  }

  if (key === "?" && state.draft === "") {
    return { state: { ...state, helpOpen: state.helpOpen !== true, notice: undefined } };
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
            deleteConfirmation: undefined,
            notice: undefined,
          },
          action: openAction(target.record),
        };
  }

  if (key === "ctrl+x" && selected !== undefined) {
    const tree = sessionTree(snapshot, selected.record.id);
    const terminal = tree.filter(({ record }) => isTerminalSession(record)).length;
    const stopAcknowledged = state.stopAcknowledgement?.sessionId === selected.record.id;
    if (terminal !== tree.length || !stopAcknowledged) {
      return {
        state: {
          ...state,
          stopAcknowledgement: { sessionId: selected.record.id },
          deleteConfirmation: undefined,
          notice: stoppingTreeNotice(selected.record, tree.length - 1, terminal, tree.length),
          noticeTone: "warning",
        },
        action: { type: "stop-tree", sessionId: selected.record.id },
      };
    }
    if (state.deleteConfirmation?.sessionId === selected.record.id) {
      return {
        state: { ...state, deleteConfirmation: undefined, notice: undefined },
        action: { type: "delete-tree", sessionId: selected.record.id },
      };
    }
    return {
      state: {
        ...state,
        deleteConfirmation: {
          sessionId: selected.record.id,
          expiresAt: now + DELETE_CONFIRMATION_MS,
        },
        notice: deleteTreeConfirmation(selected.record, tree.length - 1),
        noticeTone: "confirmation",
      },
    };
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
    return startTransition(state, undefined, initialPrompt);
  }
  if (key === "up" || key === "down") {
    const currentIndex = Math.max(0, threads.findIndex(({ record }) => record.id === state.selectedSessionId));
    const delta = key === "up" ? -1 : 1;
    const nextIndex = Math.max(0, Math.min(threads.length - 1, currentIndex + delta));
    return {
      state: {
        ...state,
        selectedSessionId: threads[nextIndex]?.record.id,
        deleteConfirmation: undefined,
        notice: undefined,
      },
    };
  }
  if (key === "backspace") {
    return { state: { ...state, draft: [...state.draft].slice(0, -1).join(""), notice: undefined } };
  }
  if (key === "ctrl+j") {
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
  const state = normalizeState(current, snapshot, now);
  if (state.workerPicker !== undefined) {
    return renderWorkerPicker(state, { width, height, now, color, home });
  }
  if (state.orchestratorPicker !== undefined) {
    return renderOrchestratorPicker(snapshot, state, { width, height, now, color, home });
  }
  return renderFleetList(snapshot, state, { width, height, now, color, home });
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

function renderWorkerPicker(state: FleetState, options: ResolvedFleetRenderOptions): string {
  const picker = state.workerPicker!;
  const choice = WORKER_MODEL_CHOICES[picker.modelIndex]!;
  const lines = renderHeader([], state, options);
  lines.push("");
  if (picker.step === "model") {
    lines.push("Choose a model", "");
    lines.push(...WORKER_MODEL_CHOICES.map((model, index) =>
      pickerRow(`${model.label}  ${paint(model.provider, "dim", options.color)}`, index === picker.modelIndex, options.color)));
  } else {
    lines.push(`${choice.label} effort`, "");
    lines.push(...choice.efforts.map((effort, index) =>
      pickerRow(friendlyEffort(effort), index === picker.effortIndex, options.color)));
  }
  const footer = [
    paint("─".repeat(options.width), "dim", options.color),
    paint(fit(`${choice.label} · ${shortPath(picker.cwd, options.home)}`, options.width), "cyan", options.color),
    paint(fit("↑↓ select · enter apply/next · esc back", options.width), "dim", options.color),
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
  const lines = [...renderHeader(threads, state, options), ""];

  const groups = groupThreads(threads);
  if (groups.length === 0) {
    lines.push("No durable agent threads yet.");
  } else {
    for (const group of groups) {
      lines.push(paint(shortPath(group.cwd, options.home), "blue", options.color));
      for (const thread of group.threads) {
        lines.push(renderThreadRow(thread, state, options));
      }
      lines.push("");
    }
  }

  const selected = threads.find(({ record }) => record.id === state.selectedSessionId);
  const selectedTree = selected === undefined ? [] : sessionTree(snapshot, selected.record.id);
  const terminal = selected !== undefined
    && selectedTree.every(({ record }) => isTerminalSession(record));
  const stopAcknowledged = selected !== undefined
    && state.stopAcknowledgement?.sessionId === selected.record.id;
  const destructiveHint = terminal && stopAcknowledged ? "ctrl+x delete thread" : "ctrl+x stop agent";
  const cwd = composerCwd(state, snapshot);
  const profile = state.launchProfiles[cwd];
  const composerLines = renderComposerLines(
    state.rename?.draft ?? state.draft,
    state.rename !== undefined,
    options,
  );
  const launchContext = profile === undefined
    ? `▶ /model required · ${selected?.record.sandbox ?? "read-only"} · cwd ${shortPath(cwd, options.home)} · ctrl+g change`
    : `▶ ${friendlyModel(profile.provider, profile.model)} · ${friendlyEffort(profile.effort ?? "provider-managed")} · ${selected?.record.sandbox ?? "read-only"} · cwd ${shortPath(cwd, options.home)} · ctrl+g change`;
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
    paint(fit(`enter open/start · ctrl+[ detach · ctrl+] reattach · ctrl+g cwd · space reply · /model · /fable-workers · /caveman-workers · ? shortcuts · ${destructiveHint}`, options.width), "dim", options.color),
  ];
  const bodyHeight = Math.max(0, options.height - footer.length);
  const body = lines.slice(0, bodyHeight);
  while (body.length < bodyHeight) body.push("");
  return [...body, ...footer].join("\n");
}

function renderHeader(
  threads: readonly FleetThread[],
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string[] {
  const statuses = threads.map(threadStatus);
  const count = (status: ThreadStatus) => statuses.filter((candidate) => candidate === status).length;
  const counts = [
    `${threads.length} agents`,
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
  const textLines = [
    paint("Cyberdeck", "bold", options.color),
    paint(fit(context, Math.max(1, options.width - 10)), "dim", options.color),
    paint(fit(counts, Math.max(1, options.width - 10)), "dim", options.color),
  ];
  if (options.width < 64) return textLines;
  const logo = [" ▄████▄", "▟█▄██▄█▙", "▌▌▌▌▐▐▐▐"];
  return textLines.map((line, index) =>
    `${paint(pad(logo[index] ?? "", 8), "purple", options.color)}  ${line}`);
}

function shortcutHelp(width: number, destructive: "stop" | "delete"): string[] {
  const entries = [
    "shift+↑↓ reorder", "ctrl+s switch views", "@ mention", "alt+1–9 open", "esc back/clear",
    "ctrl+r rename", "ctrl+j newline", "ctrl+[ detach · ctrl+] reattach", "ctrl+g cwd", "ctrl+t pin to top", `ctrl+x ${destructive}`, "? close",
  ];
  if (width >= 110) return [entries.slice(0, 5).join("   "), entries.slice(5).join("   ")];
  if (width >= 70) return [entries.slice(0, 3).join("   "), entries.slice(3, 6).join("   "), entries.slice(6).join("   ")];
  return entries;
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
          requiresResume: selectedExisting.executionState !== "active",
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
      : [paint(fit(`${selection.provider.label} · ${selection.model} · ${selection.effort ?? "Provider managed"}`, options.width), "cyan", options.color)]),
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
        || (
          record.executionState === "cancelled"
          && record.attentionState === "interrupted"
        )
      ));
}

function existingOrchestratorLabel(record: SessionRecord, color: boolean): string {
  const name = record.name ?? `${friendlyModel(record.provider, record.model)} orchestrator`;
  const lifecycle = record.attachmentState === "controlled"
    ? paint("in use", "yellow", color)
    : record.executionState === "active"
      ? paint("available", "green", color)
      : paint("reconnect", "yellow", color);
  return `${name}  ${paint(record.id.slice(0, 8), "dim", color)}  ${lifecycle}`;
}

function pickerRow(value: string, selected: boolean, color: boolean): string {
  return `${paint(selected ? "›" : "·", selected ? "bold" : "dim", color)} ${selected ? paint(value, "bold", color) : value}`;
}

function boundedIndex(value: number, length: number): number {
  return Math.max(0, Math.min(length - 1, value));
}

function renderThreadRow(
  thread: FleetThread,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const selected = thread.record.id === state.selectedSessionId;
  const prefix = selected ? "*" : "·";
  const baseTitle = thread.record.name ?? thread.record.role ?? `Untitled ${thread.record.id.slice(0, 8)}`;
  const title = `${thread.record.pinned === true ? "⌃ " : ""}${baseTitle}`;
  const identity = `${friendlyModel(thread.record.provider, thread.record.model)} · ${friendlyEffort(thread.record.effort ?? "provider-managed")}`;
  const status = threadStatus(thread);
  const preview = latestTerminalPreview(thread.record.latestPreview ?? thread.replay)
    .replace(/\s+/gu, " ")
    .trim();
  const age = relativeTime(thread.record.meaningfulUpdatedAt ?? thread.record.updatedAt, options.now);
  const showIdentity = options.width >= 80;
  const titleWidth = showIdentity
    ? Math.min(38, Math.max(22, Math.floor(options.width * 0.28)))
    : Math.min(28, Math.max(16, Math.floor(options.width * 0.38)));
  const identityWidth = showIdentity
    ? Math.min(20, Math.max(12, Math.floor(options.width * 0.15)))
    : 0;
  const statusWidth = 11;
  const fixedWidth = 12 + titleWidth + statusWidth + (showIdentity ? identityWidth + 1 : 0);
  const previewWidth = Math.max(1, options.width - fixedWidth);
  return [
    `  ${statusMarker(prefix, status, selected, options.color)}`,
    selected ? paint(pad(title, titleWidth), "bold", options.color) : pad(title, titleWidth),
    ...(showIdentity ? [paint(pad(identity, identityWidth), "dim", options.color)] : []),
    statusText(pad(status, statusWidth), false, options.color),
    paint(pad(preview, previewWidth), "dim", options.color),
    padStart(age, 5),
  ].join(" ");
}

function statusMarker(
  marker: string,
  status: ThreadStatus,
  selected: boolean,
  color: boolean,
): string {
  const tone = status === "Done"
    ? "green"
    : status === "Needs input"
      ? "yellow"
      : selected
        ? "bold"
        : "dim";
  const painted = paint(marker, tone, color);
  return selected && tone !== "bold" ? paint(painted, "bold", color) : painted;
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
  try {
    state = {
      ...state,
      launchProfiles: await client.request<Record<string, LaunchProfile>>("fleet.preferences", {}),
    };
  } catch {
    // Older brokers and isolated presentation tests have no persisted preference surface.
  }
  if (input.isTTY !== true) {
    output.write(`${renderFleet(snapshot, state, { color: false, width: output.columns, height: output.rows })}\n`);
    client.close();
    return;
  }

  const previousRawMode = input.isRaw === true;
  let stopped = false;
  let attaching = false;
  let wake: (() => void) | undefined;
  let inputQueue = Promise.resolve();
  const keyDecoder = new FleetKeyDecoder();
  let decoderFlushTimer: ReturnType<typeof setTimeout> | undefined;
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
    const transition = transitionFleet(state, snapshot, key);
    state = transition.state;
    const action = transition.action;
    if (action?.type === "quit") {
      stop();
      return;
    }
    try {
      if (action?.type === "stop-tree") {
        const progress = await client.request<SessionTreeProgress>("session.stop", { sessionId: action.sessionId });
        state = {
          ...state,
          notice: progress.terminal === progress.total
            ? stoppedTreeNotice(progress)
            : stoppingProgressNotice(progress),
          noticeTone: progress.terminal === progress.total ? "neutral" : "warning",
        };
      } else if (action?.type === "delete-tree") {
        const selectedIndex = Math.max(
          0,
          orderedThreads(snapshot).findIndex(({ record }) => record.id === action.sessionId),
        );
        const progress = await client.request<SessionTreeProgress>("session.deleteTree", { sessionId: action.sessionId });
        snapshot = await collectFleetSnapshot(client);
        const remaining = orderedThreads(snapshot);
        state = {
          ...state,
          selectedSessionId: remaining[selectedIndex]?.record.id ?? remaining[selectedIndex - 1]?.record.id,
          notice: deletedTreeNotice(progress),
          noticeTone: "neutral",
        };
      } else if (action?.type === "attach") {
        await openNativeThread(action.sessionId);
      } else if (action?.type === "resume") {
        await client.request<SessionRecord>("session.resume", { sessionId: action.sessionId });
        snapshot = await collectFleetSnapshot(client);
        await openNativeThread(action.sessionId);
      } else if (action?.type === "start") {
        const record = await client.request<SessionRecord>("session.startWithPrompt", action.request);
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
        state = { ...state, notice: fableWorkersNotice(result), noticeTone: "neutral" };
      } else if (action?.type === "caveman-workers") {
        const result = await client.request<CavemanWorkersResult>(
          "orchestrator.cavemanWorkers",
          action.request,
        );
        state = { ...state, notice: cavemanWorkersNotice(result), noticeTone: "neutral" };
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
        && action.type !== "delete-tree"
      ) {
        snapshot = await collectFleetSnapshot(client);
      }
    } catch (error) {
      state = {
        ...state,
        ...(action?.type === "start" ? { draft: action.request.initialPrompt } : {}),
        notice: error instanceof RpcError && error.code === "METHOD_NOT_FOUND"
          ? "Restart the Cyberdeck broker to enable this fleet action"
          : error instanceof Error ? error.message : String(error),
        noticeTone: "error",
      };
    }
    notify();
  };
  const queueKeys = (keys: readonly string[]) => {
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
  signals.on("SIGINT", onSigint);
  signals.on("SIGTERM", stop);
  output.write(ENTER_FLEET_SCREEN);

  try {
    while (!stopped) {
      if (attaching) {
        await waitForRefresh((resume) => { wake = resume; }, () => { wake = undefined; });
        continue;
      }
      snapshot = await collectFleetSnapshot(client);
      state = normalizeState(state, snapshot, Date.now());
      const height = Math.max(16, output.rows ?? 32);
      const width = Math.max(50, output.columns ?? 120);
      if (state.view === "diagnostics") {
        const diagnostics = renderDashboard(await collectDashboardSnapshot(client)).split("\n");
        const footer = [
          ...(state.notice === undefined ? [] : [renderNotice(state.notice, state.noticeTone, width, output.isTTY === true)]),
          paint("─".repeat(width), "dim", output.isTTY === true),
          "ctrl+s Fleet · ctrl+c twice to exit",
        ];
        const body = diagnostics.slice(0, Math.max(0, height - footer.length));
        while (body.length < height - footer.length) body.push("");
        output.write(`\u001b[2J\u001b[H${[...body, ...footer].join("\n")}\u001b[?25l`);
      } else {
        const rendered = renderFleet(snapshot, state, {
          color: output.isTTY === true,
          width,
          height,
        });
        const cursor = composerCursor(rendered, state, width);
        output.write(`\u001b[2J\u001b[H${rendered}\u001b[${cursor.row};${cursor.column}H\u001b[?25h`);
      }
      await waitForRefresh((resume) => { wake = resume; }, () => { wake = undefined; });
    }
    await inputQueue;
  } finally {
    unsubscribeClose();
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", stop);
    input.off("data", onInput);
    input.pause?.();
    input.setRawMode?.(previousRawMode);
    if (decoderFlushTimer !== undefined) clearTimeout(decoderFlushTimer);
    output.write(LEAVE_FLEET_SCREEN);
    client.close();
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
      ["\u001b[13u", "enter"],
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
      index += csi[0].length;
      continue;
    }
    if (rest === "\u001b") {
      this.pending = rest;
      break;
    }
    const altDigit = /^\u001b([1-9])/u.exec(rest);
    if (altDigit !== null) {
      keys.push(`alt+${altDigit[1]}`);
      index += altDigit[0].length;
      continue;
    }
    const code = value.charCodeAt(index);
    if (code === 0x03) keys.push("ctrl+c");
    else if (code === 0x07) keys.push("ctrl+g");
    else if (code === 0x0a) keys.push("ctrl+j");
    else if (code === 0x0f) keys.push("ctrl+o");
    else if (code === 0x12) keys.push("ctrl+r");
    else if (code === 0x13) keys.push("ctrl+s");
    else if (code === 0x14) keys.push("ctrl+t");
    else if (code === 0x18) keys.push("ctrl+x");
    else if (code === 0x1d) keys.push("ctrl+]");
    else if (code === 0x1b) keys.push("escape");
    else if (code === 0x0d) keys.push("enter");
    else if (code === 0x7f || code === 0x08) keys.push("backspace");
    else if (code >= 0x20) keys.push(value[index]!);
    index += 1;
  }
  return keys;
  }
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
    stopAcknowledgement,
    deleteConfirmation,
    quitConfirmation,
    ...(confirmationExpired
      ? { notice: undefined }
      : {}),
  };
}

function isTerminalSession(record: SessionRecord): boolean {
  if (record.executionState === "active" || record.executionState === "starting") return false;
  return record.exitCode !== null;
}

function orderedThreads(snapshot: FleetSnapshot): FleetThread[] {
  return groupThreads(snapshot.threads)
    .flatMap(({ threads }) => threads);
}

function sessionTree(snapshot: FleetSnapshot, rootSessionId: string): FleetThread[] {
  const byId = new Map(snapshot.threads.map((thread) => [thread.record.id, thread]));
  const tree: FleetThread[] = [];
  const visited = new Set<string>();
  const visit = (sessionId: string) => {
    if (visited.has(sessionId)) return;
    visited.add(sessionId);
    const thread = byId.get(sessionId);
    if (thread === undefined) return;
    tree.push(thread);
    for (const childId of thread.record.childIds) visit(childId);
  };
  visit(rootSessionId);
  return tree;
}

function stoppingTreeNotice(
  root: SessionRecord,
  childCount: number,
  terminal: number,
  total: number,
): string {
  return `Stopping ${treeSubject(root.kind ?? "worker", childCount, "worker")} · ${terminal}/${total} stopped`;
}

function deleteTreeConfirmation(root: SessionRecord, childCount: number): string {
  if (root.kind !== "orchestrator") return "Delete thread? press ctrl+x again";
  if (childCount === 0) return "Delete orchestrator? press ctrl+x again";
  return `Delete ${treeSubject("orchestrator", childCount, "child thread")}? press ctrl+x again`;
}

function stoppingProgressNotice(progress: SessionTreeProgress): string {
  return `Stopping ${treeSubject(progress.rootKind, progress.childCount, "worker")} · ${progress.terminal}/${progress.total} stopped`;
}

function stoppedTreeNotice(progress: SessionTreeProgress): string {
  return `Stopped ${treeSubject(progress.rootKind, progress.childCount, "worker")}`;
}

function deletedTreeNotice(progress: SessionTreeProgress): string {
  if (progress.rootKind !== "orchestrator") return "Deleted thread";
  if (progress.childCount === 0) return "Deleted orchestrator";
  return `Deleted ${treeSubject(progress.rootKind, progress.childCount, "child thread")}`;
}

function treeSubject(
  rootKind: "worker" | "orchestrator",
  childCount: number,
  childLabel: "worker" | "child thread",
): string {
  const root = rootKind === "orchestrator" ? "orchestrator" : "agent";
  if (childCount === 0) return root;
  return `${root} + ${childCount} ${childLabel}${childCount === 1 ? "" : "s"}`;
}

function groupThreads(threads: readonly FleetThread[]): Array<{ cwd: string; threads: FleetThread[] }> {
  const groups = new Map<string, FleetThread[]>();
  for (const thread of threads) {
    const group = groups.get(thread.record.cwd) ?? [];
    group.push(thread);
    groups.set(thread.record.cwd, group);
  }
  return [...groups.entries()]
    .map(([cwd, entries]) => ({
      cwd,
      threads: entries.sort((left, right) => {
        if (left.record.pinned !== right.record.pinned) return left.record.pinned === true ? -1 : 1;
        const leftOrder = left.record.displayOrder ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = right.record.displayOrder ?? Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return left.record.createdAt.localeCompare(right.record.createdAt);
      }),
    }))
    .sort((left, right) => {
      const leftCreated = left.threads.reduce(
        (earliest, thread) => earliest === "" || thread.record.createdAt < earliest
          ? thread.record.createdAt
          : earliest,
        "",
      );
      const rightCreated = right.threads.reduce(
        (earliest, thread) => earliest === "" || thread.record.createdAt < earliest
          ? thread.record.createdAt
          : earliest,
        "",
      );
      return leftCreated.localeCompare(rightCreated);
    });
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

function friendlyModel(provider: string, model: string | undefined): string {
  if (model === undefined) return `${titleCase(provider)} Native`;
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
  return {
    state: { ...state, draft: "", deleteConfirmation: undefined, notice: undefined },
    action: {
      type: "start",
      request: {
        provider: profile.provider,
        model: profile.model,
        ...(profile.effort === undefined ? {} : { effort: profile.effort }),
        cwd,
        sandbox: selected?.sandbox ?? "read-only",
        detached: true,
        name: taskName(initialPrompt),
        initialPrompt,
      },
    },
  };
}

function fableWorkersTransition(
  state: FleetState,
  snapshot: FleetSnapshot,
  command: string,
): FleetTransition | undefined {
  if (!command.startsWith("/fable-workers")) return undefined;
  const match = /^\/fable-workers(?:\s+(status|on|off))?$/u.exec(command);
  if (match === null) {
    return {
      state: {
        ...state,
        draft: "",
        notice: "Usage: /fable-workers status|on|off",
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
      type: "fable-workers",
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

function workerPolicyTransition(
  state: FleetState,
  snapshot: FleetSnapshot,
  command: string,
): FleetTransition | undefined {
  return fableWorkersTransition(state, snapshot, command)
    ?? cavemanWorkersTransition(state, snapshot, command);
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

function fableWorkersNotice(result: FableWorkersResult): string {
  if (!result.configured) return `Fable workers: OFF · no orchestrator bound for ${result.key}`;
  return `Fable workers: ${result.enabled ? "ON" : "OFF"} · ${result.key} · ${result.sessionId}`;
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
  if (pendingDelete || label === "Failed") return paint(status, "red", color);
  if (label === "Done") return paint(status, "green", color);
  if (label === "Needs input" || label === "Stopping") return paint(status, "yellow", color);
  if (label === "Working") return paint(status, "cyan", color);
  return paint(status, "gray", color);
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
  if (tone === "warning") return paint(value, "yellow", color);
  if (tone === "error" || tone === "confirmation") return paint(value, "red", color);
  return value;
}

function renderComposerLines(
  value: string,
  renaming: boolean,
  options: ResolvedFleetRenderOptions,
): string[] {
  if (value === "") {
    return [
      `${renaming ? "Rename ›" : "›"} ${paint(renaming ? "Rename thread" : "Describe a task for a new session", "dim", options.color)}`,
    ];
  }

  const rows: string[] = [];
  const logicalLines = value.split("\n");
  for (const logicalLine of logicalLines) {
    const characters = [...logicalLine];
    let offset = 0;
    do {
      const prefix = rows.length === 0
        ? renaming ? "Rename › " : "› "
        : "  ";
      const capacity = Math.max(1, options.width - [...prefix].length - 1);
      const segment = characters.slice(offset, offset + capacity).join("");
      rows.push(`${prefix}${segment}`);
      offset += capacity;
    } while (offset < characters.length);
  }

  const maximumRows = Math.max(1, Math.min(12, Math.floor(options.height / 3)));
  if (rows.length <= maximumRows) return rows;
  const visibleRows = rows.slice(-maximumRows);
  visibleRows[0] = `… ${(visibleRows[0] ?? "").slice(2)}`;
  return visibleRows;
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
