import { displayWidth, graphemeWidth, graphemes } from "../display-width.js";
import { ANSI } from "./constants.js";
import { ResolvedFleetRenderOptions } from "./runtime-options.js";
import { paint } from "./slash-commands.js";

export type ComposerMode = "task" | "rename" | "project" | "shell";

/**
 * Shell mode announces itself with a red `!` and nothing else — no border, no frame. The prefix is
 * painted after the row's width is measured, because escape sequences cost no columns and counting
 * them would shorten every wrap.
 */
export const COMPOSER_PROMPTS: Readonly<Record<ComposerMode, {
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

export function renderComposerLines(
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
export const ANSI_SEQUENCE = /(\u001b\[[0-9;]*m)/u;

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
export function cutToWidth(value: string, width: number): string {
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
export function printedWidth(value: string): number {
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
export function clampRowWidth(value: string, width: number): string {
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
export function displayThreadName(name: string): string {
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
export function contextLine(prefix: string, path: string, hints: string, width: number): string {
  const line = `${prefix} · cwd ${path} · ${hints}`;
  if (displayWidth(line) <= width) return line;
  const room = width - displayWidth(`${prefix} · cwd  · ${hints}`);
  // No width even for a one-cell path: nothing to save, so cut the whole line the ordinary way.
  if (room < 1) return fit(line, width);
  return `${prefix} · cwd ${elideLeading(path, room)} · ${hints}`;
}

/** A path narrowed to `width` from the front, dropping whole segments while any remain to drop. */
export function elideLeading(path: string, width: number): string {
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
export function cutToWidthFromEnd(value: string, width: number): string {
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
export function fit(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  if (width <= 1) return cutToWidth(value, width);
  return `${cutToWidth(value, width - 1)}…`;
}

export function pad(value: string, width: number): string {
  const fitted = fit(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - displayWidth(fitted)))}`;
}

export function padStart(value: string, width: number): string {
  return `${" ".repeat(Math.max(0, width - displayWidth(value)))}${value}`;
}
