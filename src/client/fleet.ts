import { homedir } from "node:os";
import type { SessionRecord, StartSessionRequest } from "../domain/session.js";
import { attachSession, type AttachTransport } from "./attach.js";
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

export interface FleetState {
  selectedSessionId?: string | undefined;
  fallbackCwd: string;
  draft: string;
  deleteConfirmation?: DeleteConfirmation | undefined;
  notice?: string | undefined;
}

export type FleetAction =
  | { type: "stop"; sessionId: string }
  | { type: "delete"; sessionId: string }
  | { type: "attach"; sessionId: string }
  | { type: "resume"; sessionId: string }
  | { type: "start"; request: StartSessionRequest & { initialPrompt: string } }
  | { type: "quit" };

export interface FleetTransition {
  state: FleetState;
  action?: FleetAction;
}

export type ThreadStatus = "Working" | "Needs input" | "Done" | "Stopping" | "Stopped" | "Failed";

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

const DELETE_CONFIRMATION_MS = 5_000;
const OSC_TITLE = /\u001b\]0;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/gu;
const OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu;
const HORIZONTAL_CURSOR_SEQUENCE = /\u001b\[(?:\d+)?[CG]/gu;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const OTHER_ESCAPE = /\u001b(?:[()][0-9A-Z]|[@-_])/gu;
const BRAILLE_SPINNER = /^[\u2800-\u28ff]/u;
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
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  gray: "\u001b[90m",
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
  };
}

export function threadStatus(thread: FleetThread): ThreadStatus {
  switch (thread.record.executionState) {
    case "starting": return "Working";
    case "exited": return "Done";
    case "failed": return "Failed";
    case "cancelled": return thread.record.exitCode === null ? "Stopping" : "Stopped";
    case "active": {
      const title = lastTerminalTitle(thread.replay);
      if (title !== undefined) return BRAILLE_SPINNER.test(title) ? "Working" : "Needs input";
      return /esc to interrupt/i.test(stripTerminalControl(thread.replay)) ? "Working" : "Needs input";
    }
  }
}

export function transitionFleet(
  current: FleetState,
  snapshot: FleetSnapshot,
  key: string,
  now = Date.now(),
): FleetTransition {
  const state = normalizeState(current, snapshot, now);
  const threads = orderedThreads(snapshot);
  const selected = threads.find(({ record }) => record.id === state.selectedSessionId);

  if (key === "ctrl+c") {
    return { state, action: { type: "quit" } };
  }

  if (key === "ctrl+x" && selected !== undefined) {
    if (selected.record.executionState === "active" || selected.record.executionState === "starting") {
      return {
        state: { ...state, deleteConfirmation: undefined, notice: undefined },
        action: { type: "stop", sessionId: selected.record.id },
      };
    }
    if (selected.record.exitCode === null) {
      return {
        state: {
          ...state,
          deleteConfirmation: undefined,
          notice: "Agent is still stopping",
        },
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
        notice: undefined,
      },
    };
  }

  if (key === "right" && selected !== undefined) {
    return {
      state: { ...state, draft: "", deleteConfirmation: undefined, notice: undefined },
      action: openAction(selected.record),
    };
  }
  if (key === "enter" && selected !== undefined) {
    const initialPrompt = state.draft.trim();
    if (initialPrompt === "") {
      return {
        state: { ...state, deleteConfirmation: undefined, notice: undefined },
        action: openAction(selected.record),
      };
    }
    return startTransition(state, selected.record, initialPrompt);
  }
  if (key === "enter" && selected === undefined && state.draft.trim() !== "") {
    return startTransition(state, undefined, state.draft.trim());
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
  if (key === "escape") {
    return { state: { ...state, draft: "", notice: undefined } };
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
  return renderFleetList(snapshot, state, { width, height, now, color, home });
}

function renderFleetList(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const threads = orderedThreads(snapshot);
  const statuses = threads.map(threadStatus);
  const working = statuses.filter((status) => status === "Working").length;
  const waiting = statuses.filter((status) => status === "Needs input").length;
  const completed = statuses.filter((status) => ["Done", "Stopped", "Failed"].includes(status)).length;
  const lines = [
    paint("CYBERDECK", "bold", options.color),
    paint(`${threads.length} agents · ${waiting} awaiting input · ${working} working · ${completed} completed`, "dim", options.color),
    "",
  ];

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
  const terminal = selected !== undefined
    && !["active", "starting"].includes(selected.record.executionState)
    && selected.record.exitCode !== null;
  const destructiveHint = terminal ? "ctrl+x delete thread" : "ctrl+x stop agent";
  const prompt = state.draft === ""
    ? paint(
      selected === undefined
        ? "Use /codex task or /claude:MODEL task"
        : "Describe a task for a new session",
      "dim",
      options.color,
    )
    : fit(state.draft, Math.max(1, options.width - 2));
  const explicitLaunch = parseExplicitLaunch(state.draft.trim(), state.fallbackCwd);
  const launchContext = explicitLaunch !== undefined
    ? `new: ${explicitLaunch.provider} · ${explicitLaunch.model ?? "native-default"} · read-only · ${shortPath(explicitLaunch.cwd, options.home)}`
    : selected === undefined
      ? `new: explicit slash provider · read-only · ${shortPath(state.fallbackCwd, options.home)}`
      : `new: ${selected.record.provider} · ${selected.record.model ?? "native-default"} · ${selected.record.sandbox} · ${shortPath(selected.record.cwd, options.home)}`;
  const footer = [
    ...(state.notice === undefined ? [] : [paint(fit(state.notice, options.width), "red", options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    `› ${prompt}`,
    paint(fit(launchContext, options.width), "dim", options.color),
    paint(fit(`↑↓ select · enter open/start · → open · esc clear · ${destructiveHint} · ctrl+c quit`, options.width), "dim", options.color),
  ];
  const bodyHeight = Math.max(0, options.height - footer.length);
  const body = lines.slice(0, bodyHeight);
  while (body.length < bodyHeight) body.push("");
  return [...body, ...footer].join("\n");
}

function renderThreadRow(
  thread: FleetThread,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const selected = thread.record.id === state.selectedSessionId;
  const prefix = selected ? "›" : "·";
  const title = thread.record.name ?? thread.record.role ?? `${thread.record.provider} ${thread.record.id.slice(0, 8)}`;
  const identity = [thread.record.provider, thread.record.model ?? "native-default", thread.record.role]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  const pendingDelete = state.deleteConfirmation?.sessionId === thread.record.id;
  const status = pendingDelete ? "press ctrl+x again to delete" : threadStatus(thread);
  const preview = latestPreview(thread.replay);
  const age = relativeTime(thread.record.updatedAt, options.now);

  if (options.width < 96) {
    const firstAvailable = Math.max(10, options.width - 4 - 31 - 7);
    const first = `${paint(prefix, selected ? "bold" : "dim", options.color)} ${fit(title, firstAvailable)}  ${statusText(status, pendingDelete, options.color)}  ${age}`;
    const second = `  ${paint(fit(identity, 28), "dim", options.color)} · ${fit(preview, Math.max(8, options.width - 34))}`;
    return `${first}\n${second}`;
  }

  const titleWidth = Math.min(32, Math.max(22, Math.floor(options.width * 0.23)));
  const identityWidth = Math.min(48, Math.max(22, Math.floor(options.width * 0.31)));
  const statusWidth = 31;
  const fixed = 2 + titleWidth + 2 + identityWidth + 2 + statusWidth + 2 + 6;
  const previewWidth = Math.max(8, options.width - fixed);
  return [
    paint(prefix, selected ? "bold" : "dim", options.color),
    pad(title, titleWidth),
    paint(pad(identity, identityWidth), "dim", options.color),
    statusText(pad(status, statusWidth), pendingDelete, options.color),
    fit(preview, previewWidth),
    padStart(age, 5),
  ].join(" ");
}

export async function runFleet(
  client: InteractiveFleetTransport,
  input: FleetInput = process.stdin,
  output: FleetOutput = process.stdout,
  signals: FleetSignals = process,
): Promise<void> {
  let snapshot = await collectFleetSnapshot(client);
  let state = createFleetState(snapshot);
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
      if (status !== 0) state = { ...state, notice: "Provider attachment closed unexpectedly" };
    } catch (error) {
      state = { ...state, notice: error instanceof Error ? error.message : String(error) };
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
      if (action?.type === "stop") {
        await client.request("session.stop", { sessionId: action.sessionId });
      } else if (action?.type === "delete") {
        await client.request("session.delete", { sessionId: action.sessionId });
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
      }
      if (action !== undefined && action.type !== "attach" && action.type !== "resume" && action.type !== "start") {
        snapshot = await collectFleetSnapshot(client);
      }
    } catch (error) {
      state = {
        ...state,
        ...(action?.type === "start" ? { draft: action.request.initialPrompt } : {}),
        notice: error instanceof RpcError && error.code === "METHOD_NOT_FOUND"
          ? "Restart the Cyberdeck broker to enable this fleet action"
          : error instanceof Error ? error.message : String(error),
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
  signals.on("SIGINT", stop);
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
      const composerColumn = Math.min(width, 3 + [...state.draft].length);
      output.write(`\u001b[2J\u001b[H${renderFleet(snapshot, state, {
        color: output.isTTY === true,
        width,
        height,
      })}\u001b[${height - 2};${composerColumn}H\u001b[?25h`);
      await waitForRefresh((resume) => { wake = resume; }, () => { wake = undefined; });
    }
    await inputQueue;
  } finally {
    unsubscribeClose();
    signals.off("SIGINT", stop);
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
    const code = value.charCodeAt(index);
    if (code === 0x03) keys.push("ctrl+c");
    else if (code === 0x18) keys.push("ctrl+x");
    else if (code === 0x1b) keys.push("escape");
    else if (code === 0x0d || code === 0x0a) keys.push("enter");
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
  return {
    ...state,
    selectedSessionId: selectedExists ? state.selectedSessionId : threads[0]?.record.id,
    deleteConfirmation,
  };
}

function orderedThreads(snapshot: FleetSnapshot): FleetThread[] {
  return groupThreads(snapshot.threads)
    .flatMap(({ threads }) => threads);
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
      threads: entries.sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt)),
    }))
    .sort((left, right) => {
      const leftLatest = left.threads[0]?.record.updatedAt ?? "";
      const rightLatest = right.threads[0]?.record.updatedAt ?? "";
      return rightLatest.localeCompare(leftLatest);
    });
}

function taskName(instruction: string): string {
  const singleLine = instruction.replace(/\s+/gu, " ").trim();
  return fit(singleLine, 72);
}

function startTransition(
  state: FleetState,
  selected: SessionRecord | undefined,
  draft: string,
): FleetTransition {
  const explicit = parseExplicitLaunch(draft, state.fallbackCwd);
  if (draft.startsWith("/") && explicit === undefined) {
    return {
      state: {
        ...state,
        notice: "Use /codex task, /codex:MODEL task, or /claude:MODEL task",
      },
    };
  }
  if (explicit === undefined && selected === undefined) {
    return {
      state: {
        ...state,
        notice: "Select a thread or name an explicit provider with /codex or /claude:MODEL",
      },
    };
  }

  const initialPrompt = explicit?.initialPrompt ?? draft;
  const context = explicit ?? {
    provider: selected!.provider,
    cwd: selected!.cwd,
    sandbox: selected!.sandbox,
    ...(selected!.model === undefined ? {} : { model: selected!.model }),
    initialPrompt,
  };
  return {
    state: { ...state, draft: "", deleteConfirmation: undefined, notice: undefined },
    action: {
      type: "start",
      request: {
        ...context,
        detached: true,
        name: taskName(initialPrompt),
      },
    },
  };
}

function parseExplicitLaunch(
  draft: string,
  cwd: string,
): Pick<StartSessionRequest, "provider" | "cwd" | "sandbox" | "model"> & { initialPrompt: string } | undefined {
  const match = /^\/(codex|claude)(?::([^\s]+))?\s+([\s\S]+)$/u.exec(draft);
  if (match === null) return undefined;
  const [, provider, model, initialPrompt] = match;
  if (
    (provider !== "codex" && provider !== "claude")
    || initialPrompt === undefined
    || initialPrompt.trim() === ""
  ) return undefined;
  if (provider === "claude" && model === undefined) return undefined;
  return {
    provider,
    cwd,
    sandbox: "read-only",
    ...(model === undefined ? {} : { model }),
    initialPrompt: initialPrompt.trim(),
  };
}

function lastTerminalTitle(replay: string): string | undefined {
  let last: string | undefined;
  for (const match of replay.matchAll(OSC_TITLE)) last = match[1];
  return last;
}

function terminalLines(replay: string): string[] {
  const stripped = stripTerminalControl(replay.replace(HORIZONTAL_CURSOR_SEQUENCE, " "))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const lines: string[] = [];
  for (const raw of stripped.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "" || lines.at(-1) === line) continue;
    lines.push(line);
  }
  return lines;
}

function stripTerminalControl(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(OTHER_ESCAPE, "")
    .replace(/[\u000f]/g, "");
}

function latestPreview(replay: string): string {
  const lines = terminalLines(replay);
  const meaningful = lines.filter((line) => !isTerminalChrome(line));
  return meaningful.at(-1) ?? lines.at(-1) ?? "No output yet";
}

function isTerminalChrome(line: string): boolean {
  return /^(CYBERDECK|Claude Code|OpenAI Codex|Tips for getting|What's new|Use \/skills|Try \"|← for agents|Working|Starting MCP|Running .* hook|No output yet)/i.test(line)
    || /esc to interrupt|ctrl\+g to edit|permission mode|plan mode on/i.test(line)
    || /^[-─━═╭╰│┌└┐┘ ]+$/u.test(line);
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
  if (status === "Needs input") return paint(status, "yellow", color);
  if (status === "Working") return paint(status, "cyan", color);
  return paint(status, "gray", color);
}

function paint(value: string, tone: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[tone]}${value}${ANSI.reset}` : value;
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
