import { homedir } from "node:os";
import type {
  CavemanWorkersRequest,
  CavemanWorkersResult,
  EnsureOrchestratorRequest,
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

export type OrchestratorPickerStep = "model" | "effort";

export interface OrchestratorPickerState {
  step: OrchestratorPickerStep;
  choiceIndex: number;
  effortIndex: number;
}

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
  draft: string;
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
  | { type: "orchestrator"; request: EnsureOrchestratorRequest }
  | { type: "fable-workers"; request: FableWorkersRequest }
  | { type: "caveman-workers"; request: CavemanWorkersRequest }
  | { type: "rename"; sessionId: string; name: string }
  | { type: "pin"; sessionId: string }
  | { type: "reorder"; sessionId: string; direction: "up" | "down" }
  | { type: "profile"; cwd: string; profile: LaunchProfile }
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
  openOrchestrator?: ((request: EnsureOrchestratorRequest) => Promise<void>) | undefined;
}

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
      if (activity === "blocked") return "Needs input";
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
    return transitionOrchestratorPicker(state, key);
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
      : { state: { ...state, selectedSessionId: target.record.id }, action: openAction(target.record) };
  }

  if (key === "ctrl+x" && selected !== undefined) {
    const tree = sessionTree(snapshot, selected.record.id);
    const terminal = tree.filter(({ record }) => isTerminalSession(record)).length;
    if (terminal !== tree.length) {
      return {
        state: {
          ...state,
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
    return renderOrchestratorPicker(state, { width, height, now, color, home });
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
  const destructiveHint = terminal ? "ctrl+x delete thread" : "ctrl+x stop agent";
  const cwd = composerCwd(state, snapshot);
  const profile = state.launchProfiles[cwd];
  const draftLines = (state.rename?.draft ?? state.draft).split("\n").slice(-3);
  const composerLines = draftLines.length === 1 && draftLines[0] === ""
    ? [`› ${paint(state.rename === undefined ? "Describe a task for a new session" : "Rename thread", "dim", options.color)}`]
    : draftLines.map((line, index) => `${index === 0 ? state.rename === undefined ? "›" : "Rename ›" : "  "} ${fit(line ?? "", Math.max(1, options.width - 3))}`);
  const launchContext = profile === undefined
    ? `▶ /model required · ${selected?.record.sandbox ?? "read-only"} · ${shortPath(cwd, options.home)}`
    : `▶ ${friendlyModel(profile.provider, profile.model)} · ${friendlyEffort(profile.effort ?? "provider-managed")} · ${selected?.record.sandbox ?? "read-only"} · ${shortPath(cwd, options.home)}`;
  const helpLines = state.helpOpen === true
    ? shortcutHelp(options.width, terminal ? "delete" : "stop")
    : [];
  const footer = [
    ...(state.notice === undefined ? [] : [renderNotice(state.notice, state.noticeTone, options.width, options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    ...composerLines,
    paint("─".repeat(options.width), "dim", options.color),
    ...helpLines.map((line) => paint(fit(line, options.width), "dim", options.color)),
    paint(fit(launchContext, options.width), "dim", options.color),
    paint(fit(`enter open/start · space reply · /model · /fable-workers · /caveman-workers · ? shortcuts · ${destructiveHint}`, options.width), "dim", options.color),
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
    "ctrl+r rename", "ctrl+j newline", "ctrl+t pin to top", `ctrl+x ${destructive}`, "? close",
  ];
  if (width >= 110) return [entries.slice(0, 5).join("   "), entries.slice(5).join("   ")];
  if (width >= 70) return [entries.slice(0, 3).join("   "), entries.slice(3, 6).join("   "), entries.slice(6).join("   ")];
  return entries;
}

function transitionOrchestratorPicker(state: FleetState, key: string): FleetTransition {
  const picker = state.orchestratorPicker!;
  if (key === "escape") {
    return {
      state: {
        ...state,
        orchestratorPicker: picker.step === "effort" ? { ...picker, step: "model" } : undefined,
        notice: undefined,
      },
    };
  }

  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    if (picker.step === "model") {
      return {
        state: {
          ...state,
          orchestratorPicker: {
            ...picker,
            choiceIndex: boundedIndex(picker.choiceIndex + delta, ORCHESTRATOR_MODEL_CHOICES.length),
            effortIndex: 0,
          },
        },
      };
    }
    const choice = ORCHESTRATOR_MODEL_CHOICES[picker.choiceIndex]!;
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
  if (picker.step === "model") {
    return { state: { ...state, orchestratorPicker: { ...picker, step: "effort" } } };
  }

  const selection = orchestratorSelection(picker);
  return {
    state: { ...state, orchestratorPicker: undefined, notice: undefined },
    action: {
      type: "orchestrator",
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
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const picker = state.orchestratorPicker!;
  const selection = orchestratorSelection(picker);
  const stepNumber = picker.step === "model" ? 1 : 2;
  const lines = [...renderHeader([], state, options), "", paint(`Orchestrator  ${stepNumber} of 2`, "dim", options.color), ""];

  if (picker.step === "model") {
    lines.push("Choose an orchestrator model", "");
    lines.push(...ORCHESTRATOR_MODEL_CHOICES.map((choice, index) =>
      pickerRow(`${choice.label}  ${paint(choice.provider.label, "dim", options.color)}`, index === picker.choiceIndex, options.color)));
  } else {
    lines.push(`${selection.provider.label} effort`, "");
    lines.push(...selection.provider.efforts.map((effort, index) =>
      pickerRow(effort === "native-default" ? "Provider managed" : effort, index === picker.effortIndex, options.color)));
  }

  const footer = [
    ...(state.notice === undefined ? [] : [renderNotice(state.notice, state.noticeTone, options.width, options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    paint(fit(`${selection.provider.label} · ${selection.model} · ${selection.effort ?? "Provider managed"}`, options.width), "cyan", options.color),
    paint(
      fit(picker.step === "effort" ? "↑↓ select · enter open · esc back" : "↑↓ select · enter next · esc back", options.width),
      "dim",
      options.color,
    ),
  ];
  const body = lines.slice(0, Math.max(0, options.height - footer.length));
  while (body.length < options.height - footer.length) body.push("");
  return [...body, ...footer].join("\n");
}

function orchestratorSelection(picker: OrchestratorPickerState) {
  const choice = ORCHESTRATOR_MODEL_CHOICES[picker.choiceIndex]!;
  const provider = choice.provider;
  const effort = provider.efforts[picker.effortIndex]!;
  return {
    provider,
    model: choice.model,
    effort: effort === "native-default" ? undefined : effort,
  };
}

function initialOrchestratorPicker(snapshot: FleetSnapshot, cwd: string): OrchestratorPickerState {
  const existing = orderedThreads(snapshot)
    .find((thread) => thread.record.kind === "orchestrator" && thread.record.orchestratorScope === "fleet")?.record
    ?? orderedThreads(snapshot)
      .find((thread) => thread.record.kind === "orchestrator" && thread.record.cwd === cwd)?.record;
  const choiceIndex = existing === undefined
    ? 0
    : Math.max(0, ORCHESTRATOR_MODEL_CHOICES.findIndex((choice) =>
      choice.provider.provider === existing.provider && choice.model === existing.model));
  const choice = ORCHESTRATOR_MODEL_CHOICES[choiceIndex]!;
  const effortIndex = Math.max(0, choice.provider.efforts.indexOf(existing?.effort ?? "native-default"));
  return { step: "model", choiceIndex, effortIndex };
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
  const preview = thread.record.latestPreview ?? latestTerminalPreview(thread.replay);
  const age = relativeTime(thread.record.meaningfulUpdatedAt ?? thread.record.updatedAt, options.now);

  if (options.width < 100) {
    const identityWidth = options.width < 60 ? 0 : Math.min(18, Math.max(10, Math.floor(options.width * 0.2)));
    const statusWidth = Math.min(11, status.length);
    const firstAvailable = Math.max(10, options.width - 4 - identityWidth - statusWidth - 7);
    const first = [
      `${paint(prefix, selected ? "bold" : "dim", options.color)} ${selected ? paint(fit(title, firstAvailable), "bold", options.color) : fit(title, firstAvailable)}`,
      ...(identityWidth === 0 ? [] : [paint(pad(identity, identityWidth), "dim", options.color)]),
      statusText(pad(status, statusWidth), false, options.color),
      age,
    ].join("  ");
    const second = `  ${paint(fit(preview, Math.max(8, options.width - 2)), "dim", options.color)}`;
    return `${first}\n${second}`;
  }

  const titleWidth = Math.min(38, Math.max(24, Math.floor(options.width * 0.28)));
  const identityWidth = Math.min(20, Math.max(12, Math.floor(options.width * 0.15)));
  const statusWidth = Math.min(11, Math.max(4, status.length));
  const fixed = 2 + titleWidth + 2 + identityWidth + 2 + statusWidth + 2 + 5;
  const previewWidth = Math.max(8, options.width - fixed);
  return [
    paint(prefix, selected ? "bold" : "dim", options.color),
    selected ? paint(pad(title, titleWidth), "bold", options.color) : pad(title, titleWidth),
    paint(pad(identity, identityWidth), "dim", options.color),
    statusText(pad(status, statusWidth), false, options.color),
    paint(fit(preview, previewWidth), "dim", options.color),
    padStart(age, 5),
  ].join(" ");
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

  const openOrchestrator = async (request: EnsureOrchestratorRequest) => {
    if (runtime.openOrchestrator === undefined) {
      state = { ...state, notice: "Orchestrator presentation is unavailable in this client", noticeTone: "error" };
      return;
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
      await runtime.openOrchestrator(request);
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
        const progress = await client.request<SessionTreeProgress>("session.deleteTree", { sessionId: action.sessionId });
        state = { ...state, notice: deletedTreeNotice(progress), noticeTone: "neutral" };
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
      } else if (action?.type === "orchestrator") {
        await openOrchestrator(action.request);
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
      }
      if (action !== undefined && action.type !== "attach" && action.type !== "resume" && action.type !== "start" && action.type !== "orchestrator") {
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
  const rowIndex = lines.findIndex((line) => {
    const plain = stripTerminalControl(line);
    return plain.startsWith("› ") || plain.startsWith("Rename › ");
  });
  const value = state.rename?.draft ?? state.draft;
  const lastLine = value.split("\n").at(-1) ?? "";
  const prefix = state.rename === undefined ? 2 : 9;
  return {
    row: Math.max(1, rowIndex + 1),
    column: Math.min(width, prefix + [...lastLine].length + 1),
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
    else if (code === 0x0a) keys.push("ctrl+j");
    else if (code === 0x0f) keys.push("ctrl+o");
    else if (code === 0x12) keys.push("ctrl+r");
    else if (code === 0x13) keys.push("ctrl+s");
    else if (code === 0x14) keys.push("ctrl+t");
    else if (code === 0x18) keys.push("ctrl+x");
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
  const deleteConfirmation = state.deleteConfirmation !== undefined && state.deleteConfirmation.expiresAt > now
    ? state.deleteConfirmation
    : undefined;
  const quitConfirmation = state.quitConfirmation !== undefined && state.quitConfirmation.expiresAt > now
    ? state.quitConfirmation
    : undefined;
  const confirmationExpired = (state.deleteConfirmation !== undefined && deleteConfirmation === undefined)
    || (state.quitConfirmation !== undefined && quitConfirmation === undefined);
  return {
    ...state,
    selectedSessionId: selectedExists ? state.selectedSessionId : threads[0]?.record.id,
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
        const leftAt = left.record.meaningfulUpdatedAt ?? left.record.updatedAt;
        const rightAt = right.record.meaningfulUpdatedAt ?? right.record.updatedAt;
        return rightAt.localeCompare(leftAt);
      }),
    }))
    .sort((left, right) => {
      const leftLatest = left.threads[0]?.record.meaningfulUpdatedAt ?? left.threads[0]?.record.updatedAt ?? "";
      const rightLatest = right.threads[0]?.record.meaningfulUpdatedAt ?? right.threads[0]?.record.updatedAt ?? "";
      return rightLatest.localeCompare(leftLatest);
    });
}

function taskName(instruction: string): string {
  const singleLine = instruction.replace(/\s+/gu, " ").trim();
  return fit(singleLine, 72);
}

function composerCwd(state: FleetState, snapshot: FleetSnapshot): string {
  return snapshot.threads.find(({ record }) => record.id === state.selectedSessionId)?.record.cwd
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
  const cwd = selected?.cwd ?? state.fallbackCwd;
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
  if (pendingDelete || status === "Failed") return paint(status, "red", color);
  if (status === "Done") return paint(status, "green", color);
  if (status === "Needs input" || status === "Stopping") return paint(status, "yellow", color);
  if (status === "Working") return paint(status, "cyan", color);
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
