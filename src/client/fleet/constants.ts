import { ORCHESTRATOR_CATALOG } from "../../orchestration/orchestrator-catalog.js";
import { capabilityModelEfforts, fallbackWorkerCapabilities, type ResolvedWorkerCapability, } from "../../orchestration/worker-capabilities.js";
import { type ConfigurablePermissionProvider, type ProviderPermissionPolicy } from "../permission-policy.js";
import { friendlyModel } from "./model-labels.js";
import { OrchestratorModelChoice, SlashCommandDefinition, WorkerModelCatalog, WorkerModelChoice } from "./runtime-options.js";

export const DELETE_CONFIRMATION_MS = 5_000;
export const QUIT_CONFIRMATION_MS = 5_000;
export const QUIT_CONFIRMATION_NOTICE = "Press ctrl+c again to exit";
export const COMMAND_PALETTE_VISIBLE_ROWS = 3;
export const ORCS_SECTION_LABEL = "Orcs";
/**
 * The Orcs roster folds and caps like a folder, so it answers to the same collapsed and expanded
 * arrays under a key of its own. It is shaped like an absolute path because that is what those
 * arrays hold, and no folder can ever be called this.
 */
export const ORCS_SECTION_KEY = "/@orcs";
export const UNREGISTERED_SECTION_LABEL = "Unregistered";
/**
 * Threads under no registered project. It folds under a sentinel of the same impossible shape as
 * the Orcs roster, and starts folded: it is where work goes to be found again, not a list the
 * operator reads every time they open the fleet.
 */
export const UNREGISTERED_SECTION_KEY = "/@unregistered";
export const WORKERS_SECTION_LABEL = "Workers";
/** An older broker has no registry, so the list is still grouped one folder per directory. */
export const PROJECTS_UNAVAILABLE_NOTICE = "Project registry unavailable on this broker";
/** How much of a worktree path a row spends naming itself before the name is trimmed. */
export const WORKTREE_TAG_WIDTH = 22;
/** The state label's column. Fixed, because the state is one of a known set of words. */
export const STATUS_CELL_WIDTH = 11;
/**
 * A row at this width or more can afford the full layout. Below it the row keeps every column it
 * can pay for and yields the rest, in the order `threadRowLayout` spends its width.
 */
export const WIDE_ROW_WIDTH = 80;
/**
 * Model and effort in a narrow pane. Wide enough that the model name itself survives — the effort
 * after it is what a cut takes — because the model is the half of the cell an operator scans for.
 */
export const NARROW_IDENTITY_CELL_WIDTH = 14;
/** The floors title and preview shrink to before the supplementary columns start dropping out. */
export const MIN_TITLE_CELL_WIDTH = 8;
export const MIN_PREVIEW_CELL_WIDTH = 6;
/**
 * The most a row will ever spend on a pull-request number: `#` plus six digits,
 * which is more than any repository this fleet dispatches into will reach. The
 * column is normally four or five cells wide, and only as wide as it must be.
 */
export const PULL_REQUEST_CELL_WIDTH = 7;
/** Workers shown per folder before the rest go behind a show-more row. */
export const FOLDER_THREAD_CAP = 5;
export const DEFAULT_PERMISSION_POLICIES: Readonly<Record<ConfigurablePermissionProvider, ProviderPermissionPolicy>> = {
  codex: "permissioned",
  claude: "permissioned",
  cursor: "permissioned",
  antigravity: "permissioned",
};
export const PERMISSION_POLICIES: readonly ProviderPermissionPolicy[] = [
  "permissioned",
  "automatic",
];
export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
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
export const UNQUERIED_WORKER_MODELS: WorkerModelCatalog = workerModelCatalog(
  fallbackWorkerCapabilities("Fleet has not read provider capabilities from the broker"),
);
export const ORCHESTRATOR_MODEL_CHOICES: readonly OrchestratorModelChoice[] = ORCHESTRATOR_CATALOG.flatMap((provider) =>
  provider.models.map((model) => ({
    provider,
    model,
    label: friendlyModel(provider.provider, model),
  })),
);
export const DISABLE_INHERITED_TERMINAL_INPUT_MODES = [
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
export const ENTER_FLEET_SCREEN = `${DISABLE_INHERITED_TERMINAL_INPUT_MODES}\u001b[?1049h\u001b[?25l`;
export const LEAVE_FLEET_SCREEN = `${DISABLE_INHERITED_TERMINAL_INPUT_MODES}\u001b[?25h\u001b[?1049l`;

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
export const ANSI = {
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
export const SELECTION_RULE = "▌";
/** One cell wide, so a marked row and an unmarked one still measure the same. */
export const HANDOFF_MARK = "✓";
export const ROW_GUTTER = "  ";

/**
 * One list poll's worth of broker truth, and nothing that scales with worker output.
 *
 * The thread list renders exclusively from session records: `attentionState` for the status dot
 * and `latestPreview` for the preview cell, both of which the broker maintains event-driven as
 * provider output arrives. Fleet used to also pull every non-settled session's full PTY replay
 * here to re-derive the same two answers client-side, which cost each working agent its whole
 * replay buffer on every 100ms tick — encode, transfer, decode, and regex, twice over, across two
 * processes. Raw replay bytes now flow only through `session.attach`, when the operator actually
 * enters a thread.
 */
