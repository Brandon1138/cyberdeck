import { findLiveOrchestratorPane, type SpawnSyncLike } from "../tmux/cockpit.js";

export const MINIMUM_LAYOUT_USABLE_COLUMNS = 120;
export const NVIM_LAYOUT_WINDOW_FORMAT =
  "#{window_width}\t#{window_height}\t#{window_zoomed_flag}";

export type WindowLayoutRole = "fleet" | "orc" | "nvim";
export type WindowLayoutState =
  | "fleet"
  | "fleet-orc"
  | "fleet-nvim"
  | "fleet-orc-nvim";

export interface WindowLayoutPane {
  paneId: string;
  dead: boolean;
  left: number;
  top: number;
  height: number;
  width: number;
  currentCommand: string;
  startCommand: string;
  role?: WindowLayoutRole | undefined;
}

export interface WindowLayoutInput {
  windowWidth: number;
  windowHeight: number;
  windowZoomed: boolean;
  panes: readonly WindowLayoutPane[];
}

export interface WindowLayoutResize {
  paneId: string;
  width: number;
}

export interface WindowLayoutPlan {
  state: WindowLayoutState;
  usableWidth: number;
  panes: readonly WindowLayoutPane[];
  resizes: readonly WindowLayoutResize[];
}

const STATES: Readonly<Record<string, {
  state: WindowLayoutState;
  ratios: readonly number[];
}>> = {
  fleet: { state: "fleet", ratios: [1] },
  "fleet,orc": { state: "fleet-orc", ratios: [0.5, 0.5] },
  "fleet,nvim": { state: "fleet-nvim", ratios: [0.5, 0.5] },
  "fleet,orc,nvim": { state: "fleet-orc-nvim", ratios: [0.275, 0.225, 0.5] },
};

/**
 * Plan only the four cockpit states Cyberdeck owns.
 *
 * 120 usable columns is a refusal floor, not a responsive breakpoint. Below it, the 27.5% Fleet
 * pane falls under 33 columns and both Fleet text and nvim become meaningfully cramped; guessing a
 * more compact ratio would silently invent a fifth layout state. Leaving the operator's existing
 * widths alone is safer and keeps the opt-in from making a narrow window worse.
 */
export function planWindowLayout(input: WindowLayoutInput): WindowLayoutPlan | undefined {
  if (
    input.windowZoomed
    || !Number.isInteger(input.windowWidth)
    || !Number.isInteger(input.windowHeight)
    || input.windowWidth <= 0
    || input.windowHeight <= 0
    || input.panes.length < 1
    || input.panes.length > 3
  ) return undefined;

  const panes = [...input.panes].sort((left, right) => left.left - right.left);
  if (panes.some((pane) =>
    pane.dead
    || pane.role === undefined
    || !Number.isInteger(pane.left)
    || pane.left < 0
    || pane.top !== 0
    || pane.height !== input.windowHeight
  )) return undefined;

  const usableWidth = input.windowWidth - (panes.length - 1);
  if (usableWidth < MINIMUM_LAYOUT_USABLE_COLUMNS) return undefined;

  const state = STATES[panes.map(({ role }) => role).join(",")];
  if (state === undefined) return undefined;

  return {
    state: state.state,
    usableWidth,
    panes,
    // tmux applies each width against the same window. The rightmost pane is deliberately omitted:
    // it absorbs separator rounding and the remainder without a second resize moving its left edge.
    resizes: panes.slice(0, -1).map((pane, index) => ({
      paneId: pane.paneId,
      width: Math.round(usableWidth * state.ratios[index]!),
    })),
  };
}

export interface RebalanceNvimWindowOptions {
  spawnSync: SpawnSyncLike;
  windowId: string;
  paneFormat: string;
  hostPaneId: string;
  /** Hook subprocess guard: Fleet's pane must still be running the command seen at installation. */
  expectedHostCommand?: string | undefined;
  orchestratorSessionIds?: readonly string[] | undefined;
  /** Used only by the pane-exit subprocess, which has no broker session id to compare. */
  cliPath?: string | undefined;
  quiet?: boolean | undefined;
}

/**
 * Inspect, classify, plan, then apply one cockpit window.
 *
 * In-process calls name Fleet's pane and every possible Orc session exactly. The pane-exit process
 * still gets Fleet's exact pane id from a window option, but its Orc test is necessarily looser:
 * the pane must be live and its immutable start command must run this exact CLI path's `attach`
 * verb with one UUID and no unrelated options. The embedded UUID is enough for the strict finder
 * to name the same pane if it were available; only comparison with the absent expected UUID is
 * relaxed. A shell, nvim child, another checkout, or lookalike command cannot match, and any extra
 * or duplicate classified pane makes the planner refuse the whole window.
 */
export function rebalanceNvimWindow(
  options: RebalanceNvimWindowOptions,
): WindowLayoutPlan | undefined {
  try {
    const window = options.spawnSync(
      "tmux",
      ["display-message", "-p", "-t", options.windowId, NVIM_LAYOUT_WINDOW_FORMAT],
      { encoding: "utf8" },
    );
    if (window.status !== 0) return undefined;
    const [widthText, heightText, zoomedText] = (window.stdout ?? "").trim().split("\t");
    const windowWidth = Number(widthText);
    const windowHeight = Number(heightText);
    if (!Number.isInteger(windowWidth) || !Number.isInteger(windowHeight)) return undefined;

    const listed = options.spawnSync(
      "tmux",
      ["list-panes", "-t", options.windowId, "-F", options.paneFormat],
      { encoding: "utf8" },
    );
    if (listed.status !== 0) return undefined;
    const panes = parseLayoutPanes(listed.stdout ?? "");
    if (panes === undefined) return undefined;

    const strictOrcPaneIds = strictOrchestratorPaneIds(
      panes,
      options.orchestratorSessionIds ?? [],
    );
    const classified = panes.map((pane): WindowLayoutPane => ({
      ...pane,
      role: pane.paneId === options.hostPaneId
          && (
            options.expectedHostCommand === undefined
            || pane.currentCommand === options.expectedHostCommand
          )
        ? "fleet"
        : !pane.dead && pane.currentCommand === "nvim"
          ? "nvim"
          : strictOrcPaneIds.has(pane.paneId)
            ? "orc"
            : options.cliPath !== undefined
                && !pane.dead
                && startsThisCliAttach(pane.startCommand, options.cliPath)
              ? "orc"
              : undefined,
    }));
    const plan = planWindowLayout({
      windowWidth,
      windowHeight,
      // `window_zoomed_flag` is normally empty or `Z`; accepting `0` keeps injected seams plain.
      windowZoomed: zoomedText !== undefined
        && zoomedText.trim() !== ""
        && zoomedText.trim() !== "0",
      panes: classified,
    });
    if (plan === undefined) return undefined;

    for (const resize of plan.resizes) {
      const result = options.spawnSync(
        "tmux",
        ["resize-pane", "-t", resize.paneId, "-x", String(resize.width)],
        { stdio: "ignore" },
      );
      if (result.status !== 0 && options.quiet !== true) {
        throw new Error(`tmux failed to resize ${resize.paneId}`);
      }
      if (result.status !== 0) return undefined;
    }
    return plan;
  } catch (error) {
    if (options.quiet === true) return undefined;
    throw error;
  }
}

function parseLayoutPanes(output: string): WindowLayoutPane[] | undefined {
  const panes: WindowLayoutPane[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const [paneId, dead, left, top, height, width, currentCommand, ...start] = line.split("\t");
    if (
      paneId === undefined
      || dead === undefined
      || left === undefined
      || top === undefined
      || height === undefined
      || width === undefined
      || currentCommand === undefined
    ) return undefined;
    const parsed = {
      left: Number(left),
      top: Number(top),
      height: Number(height),
      width: Number(width),
    };
    if (Object.values(parsed).some((value) => !Number.isInteger(value))) return undefined;
    panes.push({
      paneId: paneId.trim(),
      dead: dead.trim() !== "0",
      ...parsed,
      currentCommand: currentCommand.trim(),
      startCommand: start.join("\t").trim(),
    });
  }
  return panes;
}

function strictOrchestratorPaneIds(
  panes: readonly WindowLayoutPane[],
  sessionIds: readonly string[],
): Set<string> {
  const output = panes
    .map((pane) => `${pane.paneId}\t${pane.dead ? "1" : "0"}\t${pane.startCommand}`)
    .join("\n");
  return new Set(sessionIds.flatMap((sessionId) => {
    const paneId = findLiveOrchestratorPane(output, sessionId);
    return paneId === undefined ? [] : [paneId];
  }));
}

/**
 * Parse enough POSIX shell syntax to compare argv tmux stored for `pane_start_command`.
 *
 * No command is executed and no expansion is attempted. Unsupported syntax returns no words, so a
 * stale hook refuses rather than treating shell metacharacters as an attach command.
 */
function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  let started = false;
  for (const character of command) {
    if (escaping) {
      word += character;
      escaping = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    if (/[;&|<>`$(){}]/u.test(character)) return undefined;
    word += character;
    started = true;
  }
  if (escaping || quote !== undefined) return undefined;
  if (started) words.push(word);
  return words;
}

export function startsThisCliAttach(startCommand: string, cliPath: string): boolean {
  const words = shellWords(startCommand);
  if (words === undefined) return false;
  const cliIndex = words.indexOf(cliPath);
  if (cliIndex === -1 || words[cliIndex + 1] !== "attach") return false;
  const sessionId = words[cliIndex + 2];
  if (
    sessionId === undefined
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)
  ) return false;
  const remainder = words.slice(cliIndex + 3);
  return remainder.length === 0
    || (
      remainder.length === 2
      && remainder[0] === "--cockpit-return"
      && (remainder[1] === "detach" || remainder[1] === "switch")
    );
}
