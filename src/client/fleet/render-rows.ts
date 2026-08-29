import type { FleetWorkerCoordinationView } from "../../broker/worker-coordination-view.js";
import { conversationPreview } from "../../domain/conversation-preview.js";
import { leaseCustody, leaseCustodyBadge, type LeaseCustodyBadge } from "../lease-custody.js";
import { pullRequestLabel, pullRequestTone, type PullRequestSummary } from "../pr-status.js";
import { ANSI, HANDOFF_MARK, MIN_PREVIEW_CELL_WIDTH, MIN_TITLE_CELL_WIDTH, NARROW_IDENTITY_CELL_WIDTH, ROW_GUTTER, SELECTION_RULE, STATUS_CELL_WIDTH, WIDE_ROW_WIDTH } from "./constants.js";
import { isCollapsed, threadFocusInert } from "./list-rows.js";
import { threadIdentity } from "./model-labels.js";
import { isHandoffMarked } from "./picker-handoff.js";
import { displayThreadName, fit, pad, padStart } from "./render-composer.js";
import { ResolvedFleetRenderOptions } from "./runtime-options.js";
import { paint, relativeTime, shortPath, statusText } from "./slash-commands.js";
import { FleetSnapshot, FleetState, FleetThread, ThreadStatus } from "./state.js";
import { threadStatus } from "./transport.js";

export function boundedIndex(value: number, length: number): number {
  return Math.max(0, Math.min(length - 1, value));
}

/**
 * Left gutter shared by folder and thread rows. The focused row carries a rule
 * rather than a color change, so the bar reads the same with color disabled.
 */
export function rowGutter(
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

export function threadListScrollbar(
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
export function renderFolderRow(
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
export function renderShowMoreRow(
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
  return `${rowGutter(focused, options.color, scrollbar)}${focused ? paint(label, "bold", options.color) : paint(label, "dim", options.color)
    }`;
}

export function renderThreadRow(
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
    `${rowGutter(selected, options.color, scrollbar, isHandoffMarked(state, thread.record.id))
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
export function threadRowLayout(
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
export function titleCell(title: string, selected: boolean, color: boolean): string {
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
export function ownerSigilCell(sigil: string | undefined, width: number, color: boolean): string {
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
export function dimRow(row: string, color: boolean): string {
  if (!color) return row;
  return `${ANSI.dim}${row.split(ANSI.reset).join(`${ANSI.reset}${ANSI.dim}`)}${ANSI.reset}`;
}

/**
 * A worker's lease custody, at the width of the longest badge on screen. A thread with
 * nothing to report holds the column open and shows nothing, exactly as the pull-request
 * column does.
 */
export function leaseBadgeCell(
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
export function renderWorkerCoordinationRow(
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
export function pullRequestCell(
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
 * because records persisted by earlier versions hold raw TUI chrome. It is also the only source:
 * the broker maintains it event-driven for every provider, so re-deriving a preview from raw PTY
 * bytes here would repeat, at poll frequency, work already done once on arrival. A session with
 * no reply yet shows the placeholder until its first result lands.
 */
export function threadPreview(thread: FleetThread, width: number): string {
  return conversationPreview({
    storedPreview: thread.record.latestPreview,
    maxLength: width,
  }).text;
}

/**
 * The status dot. Finished, blocked, failing and live threads each take their own
 * hue, and `Working` also takes the filled glyph so the live thread stays findable
 * with color off. The focused row is already marked by the selection rule, so
 * focus adds weight alone.
 */
export function statusMarker(
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

export function layoutOrchestratorSessionIds(
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
