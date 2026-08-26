/**
 * The Cyberdeck octopus, and the half-block renderer that puts it in a terminal.
 *
 * The art is stored as a grid of ink and ground rather than as pre-composed glyphs, because a
 * terminal has no square pixel: the renderer pairs two grid rows into one text row using `▀`, with
 * the upper pixel as the foreground and the lower one as the background. That is what makes a cell
 * roughly square, and it is why every grid here has an even-ish row count — the art's height in
 * *pixels* is twice its height in rows on screen.
 *
 * `.` is the ground. It paints nothing at all, not white: the octopus sits on whatever background
 * the operator's terminal has. `x` is the ink, and there is exactly one of it. That is the whole
 * design: a shaded animal carries a lighting model, and a lighting model assumes a ground — which
 * is why the four-purple version needed a second palette for light terminals and still read as the
 * dark drawing, dimmed. A silhouette assumes nothing. The same bytes go to a black terminal and a
 * white one, and the eyes are cut out of the ink rather than painted, so they invert for free.
 *
 * The terminal's background is still worth asking for (`terminal-background.ts`), but it no longer
 * chooses anything: it only feathers the silhouette's edge. An unknown background costs one pixel
 * of softening and nothing else.
 */

import type { TerminalBackground } from "./terminal-background.js";

type Rgb = readonly [number, number, number];

/**
 * The one ink, sampled from the reference artwork's lit purple rather than chosen here.
 *
 * It has to clear both grounds unaided, and it does: 4.18:1 against a black terminal, 4.65:1
 * against white, either side of the 3:1 floor for a non-text graphic. The artwork's other purples
 * do not — the mid tone reads beautifully on paper and vanishes on black, which is the asymmetry
 * that made two palettes necessary in the first place.
 *
 * This is the logo's colour and no state may borrow it, the same reservation `ANSI.brand` carries
 * in `fleet.ts` — a status hue that happened to match the octopus would read as the octopus meaning
 * something.
 */
const INK: Rgb = [158, 84, 196];

/** Ink or ground, per grid character. One entry, deliberately. */
const PALETTE: Readonly<Record<string, Rgb>> = { x: INK };

/**
 * How far a silhouette pixel leans toward the terminal's background. High enough that the perimeter
 * stops ringing against the ground, low enough that the edge is still an edge and not a smear.
 */
const EDGE_FEATHER = 0.3;

const RESET = "\u001b[0m";
/** Ground as a *background* is the terminal's own, never an explicit colour. */
const DEFAULT_BACKGROUND = "\u001b[49m";

/**
 * The full octopus, at the size below which it stops being itself.
 *
 * This is the reference artwork's own outline — the silhouette the four-tone version was painted
 * inside, kept exactly, with the lighting thrown away. Nothing is lost in the trade that the shape
 * was not already carrying: the gaps between the arms are ground in the grid, not a darker purple,
 * so they survive flattening. The eyes are the one addition, cut back out to the ground the shading
 * used to imply. Narrower than about 32 columns the animal collapses, which is why this is the
 * splash and not the header mark.
 */
export const OCTOPUS_SPLASH: readonly string[] = [
  ".............xxxxxx.............",
  "...........xxxxxxxxxx...........",
  "..........xxxxxxxxxxxx..........",
  "....xxx...xxxxxxxxxxxx...xxx....",
  "...xxxxxx.xx..xxxx..xx.xxxxxx...",
  "..xxxxxxx.xx..xxxx..xx.xxxxxxx..",
  "..xxxxxxx.xxxxxxxxxxxx.xxxxxxx..",
  "...x..xxxx.xxxxxxxxxx.xxxx..x...",
  ".....xxxxxxxxxxxxxxxxxxxxxx.....",
  ".....xxxxxxxxxxxxxxxxxxxxxx.....",
  ".xxxx.xxxxxxxxxxxxxxxxxxxx.xxxx.",
  "xxxxxx.xxxxxxxxxxxxxxxxxx.xxxxxx",
  "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "xx.xxxxxxxxxxxxxxxxxxxxxxxxxx.xx",
  "....xxxxxxxxxxxxxxxxxxxxxxxx....",
  "......xxxxxxxxxxxxxxxxxxxx......",
  "....xxxxxxxxxxx..xxxxxxxxxxx....",
  "..xxxxxxxxxxxx....xxxxxxxxxxx...",
  "..xxxxx.xxxxx......xxxxxxxxxxx..",
  "..xxxx..xxxxxx....xxxxxx..xxxx..",
  "..xxxx...xxxxxx..xxxxxx...xxxx..",
  "...xxxxx.xxxxxx..xxxxx..xxxxx...",
  "....xxx....xxxxxxxxxx....xxx....",
  "........xx.xxxxxxxxxx.xx........",
  "........xxxxxxx..xxxxxxx........",
  ".........xxxxx....xxxx..........",
];

/**
 * The header mark: the same animal, drawn small.
 *
 * Hand-drawn rather than downsampled, and it has to be. Four mechanical reductions of the splash
 * were tried and all four landed on the same silhouette — flat head over a stubby fringe, a space
 * invader — because eight arms need pixels this row does not have. What survives at this size is a
 * mantle wide enough to hang from, eyes, and four arms a side reduced to single strokes with the
 * outer pair flicking away from the body. Eight pixel rows is the floor; four terminal rows is what
 * that costs the header.
 */
export const OCTOPUS_MARK: readonly string[] = [
  "...xxxxxxx...",
  "..xxxxxxxxx..",
  ".xxx.xxx.xxx.",
  ".xxxxxxxxxxx.",
  "xxxxxxxxxxxxx",
  "x.x.xxxxx.x.x",
  "x.x..x.x..x.x",
  ".x...x.x...x.",
];

/** Width in terminal columns, which is the grid's width — one column per pixel. */
export function pixelArtWidth(art: readonly string[]): number {
  return art.reduce((widest, row) => Math.max(widest, row.length), 0);
}

/** Height in terminal rows, which is half the grid's — two pixels share one row. */
export function pixelArtHeight(art: readonly string[]): number {
  return Math.ceil(art.length / 2);
}

/**
 * Renders a grid into terminal rows, each exactly `pixelArtWidth` columns wide.
 *
 * A known `background` buys exactly one thing: it feathers the silhouette — every ink pixel with
 * open ground beside it leans `EDGE_FEATHER` of the way toward the background, which is the
 * one-pixel anti-aliasing a half-block canvas has room for. No background means hard edges, and
 * hard edges are only a slightly noisier version of the same drawing, never a different one.
 *
 * Without colour the palette is gone but the shape is not, so the glyph alone carries it: a cell
 * with ink above and below is full, one with ink on a single side is that half. The rows are still
 * the right width, which is what lets the caller lay text out beside them either way.
 */
export function renderPixelArt(
  art: readonly string[],
  color: boolean,
  background?: TerminalBackground,
): string[] {
  const width = pixelArtWidth(art);
  const ink = resolveInk(art, width, background);
  const lines: string[] = [];
  for (let row = 0; row < art.length; row += 2) {
    let line = "";
    for (let column = 0; column < width; column += 1) {
      line += renderCell(ink[row]?.[column], ink[row + 1]?.[column], color);
    }
    lines.push(color ? `${line}${RESET}` : line);
  }
  return lines;
}

/**
 * Every pixel's colour, decided before any cell is composed — a cell borrows two pixels that may
 * each be pure ink, feathered edge, or ground, and pairing them is the renderer's job, not this
 * one's.
 */
function resolveInk(
  art: readonly string[],
  width: number,
  background: TerminalBackground | undefined,
): (Rgb | undefined)[][] {
  const inkAt = (row: number, column: number): Rgb | undefined =>
    PALETTE[art[row]?.[column] ?? ""];
  return art.map((rowPixels, row) =>
    Array.from({ length: width }, (_, column): Rgb | undefined => {
      const pixel = PALETTE[rowPixels[column] ?? ""];
      if (pixel === undefined || background === undefined) return pixel;
      const onSilhouette = inkAt(row - 1, column) === undefined
        || inkAt(row + 1, column) === undefined
        || inkAt(row, column - 1) === undefined
        || inkAt(row, column + 1) === undefined;
      return onSilhouette ? feather(pixel, background) : pixel;
    }));
}

function feather([red, green, blue]: Rgb, background: TerminalBackground): Rgb {
  const lean = (ink: number, ground: number) => Math.round(ink + (ground - ink) * EDGE_FEATHER);
  return [lean(red, background.red), lean(green, background.green), lean(blue, background.blue)];
}

/**
 * One text cell, from the two pixels stacked inside it.
 *
 * Every coloured cell re-states both of its own attributes after a reset rather than trusting what
 * the previous cell left set. A ground cell emits no colour at all, and inheriting the neighbour's
 * background would paint it — a trail of purple behind the tentacles.
 */
function renderCell(above: Rgb | undefined, below: Rgb | undefined, color: boolean): string {
  if (!color) {
    if (above !== undefined && below !== undefined) return "█";
    if (above !== undefined) return "▀";
    if (below !== undefined) return "▄";
    return " ";
  }
  if (above === undefined && below === undefined) return `${RESET} `;
  if (above === undefined) return `${RESET}${foreground(below!)}${DEFAULT_BACKGROUND}▄`;
  if (below === undefined) return `${RESET}${foreground(above)}${DEFAULT_BACKGROUND}▀`;
  return `${RESET}${foreground(above)}${background(below)}▀`;
}

function foreground([red, green, blue]: Rgb): string {
  return `\u001b[38;2;${red};${green};${blue}m`;
}

function background([red, green, blue]: Rgb): string {
  return `\u001b[48;2;${red};${green};${blue}m`;
}
