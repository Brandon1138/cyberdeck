import { basename } from "node:path";
import { displayWidth } from "../display-width.js";
import { OCTOPUS_MARK, OCTOPUS_SPLASH, pixelArtHeight, pixelArtWidth, renderPixelArt, } from "../octopus.js";
import { pullRequestLabel } from "../pr-status.js";
import { PULL_REQUEST_CELL_WIDTH, WORKTREE_TAG_WIDTH } from "./constants.js";
import { scrollFocusedRowIntoView } from "./list-groups.js";
import { fleetListRows, isTerminalSession, orderedThreads } from "./list-rows.js";
import { composerCwd, friendlyEffort, friendlyModel } from "./model-labels.js";
import { clampRowWidth, contextLine, fit, renderComposerLines } from "./render-composer.js";
import { renderFolderRow, renderShowMoreRow, renderThreadRow, renderWorkerCoordinationRow, rowGutter, threadListScrollbar } from "./render-rows.js";
import { ResolvedFleetRenderOptions } from "./runtime-options.js";
import { paint, renderNotice, shortPath } from "./slash-commands.js";
import { FleetSnapshot, FleetState, FleetThread, ShellModeState, ThreadStatus } from "./state.js";
import { threadStatus } from "./transport.js";

export function renderFleetList(
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
export function renderShellTranscript(
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
export function shellTranscriptScrollOffset(shell: ShellModeState, viewportHeight: number): number {
  const lineCount = shell.transcript.length - (shell.transcript.at(-1) === "" ? 1 : 0);
  return Math.max(0, lineCount - Math.max(0, viewportHeight));
}

export function renderFleetFooter(
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
export function shellName(): string {
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
export function renderEmptyFleet(
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

export function renderHeader(
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

export function shortcutHelp(width: number, destructive: "stop" | "delete"): string[] {
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
