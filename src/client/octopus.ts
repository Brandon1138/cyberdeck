/**
 * The Cyberdeck octopus, and the half-block renderer that puts it in a terminal.
 *
 * The art is stored as a grid of palette indices rather than as pre-composed glyphs, because a
 * terminal has no square pixel: the renderer pairs two grid rows into one text row using `▀`, with
 * the upper pixel as the foreground and the lower one as the background. That is what makes a cell
 * roughly square, and it is why every grid here has an even-ish row count — the art's height in
 * *pixels* is twice its height in rows on screen.
 *
 * `.` is the ground. It paints nothing at all, not white: the octopus sits on whatever background
 * the operator's terminal has, so the same grid reads on a light and a dark theme.
 */

/**
 * The reference artwork's own purples, sampled from it rather than chosen here.
 *
 * These are the logo's palette and no state may borrow them, the same reservation `ANSI.brand`
 * carries in `fleet.ts` — a status hue that happened to match the octopus would read as the octopus
 * meaning something.
 */
const PALETTE: Readonly<Record<string, readonly [number, number, number]>> = {
  /** Outline and the deep shadow inside every tentacle. */
  "1": [35, 9, 69],
  /** The body's mid tone. */
  "2": [108, 52, 140],
  /** Lit tentacle and the dome's body. */
  "3": [158, 84, 196],
  /** The dome's highlight, and the only near-pink in the piece. */
  "4": [196, 130, 232],
};

const RESET = "\u001b[0m";
/** Ground as a *background* is the terminal's own, never an explicit colour. */
const DEFAULT_BACKGROUND = "\u001b[49m";

/**
 * The full octopus, at the size below which it stops being itself.
 *
 * Derived from the reference by snapping it to the palette above at full resolution and then taking
 * the most common ink per cell — averaging instead loses the one-pixel outlines that separate the
 * tentacles, and the whole animal collapses into a purple blob. Narrower than about 24 columns it
 * collapses anyway, which is why this is the splash and not the header mark.
 */
export const OCTOPUS_SPLASH: readonly string[] = [
  ".............111111.............",
  "...........1133333211...........",
  "..........113333333311..........",
  "....111...122333333221...111....",
  "...133211.123233332221.113331...",
  "..1322331.122223322211.1332231..",
  "..1111231.111222222111.3311111..",
  "...1..1221.1111221111.1321..1...",
  ".....1123111121221211112211.....",
  ".....1122111111221111122211.....",
  ".1111.11222112222221122211.1111.",
  "123331.111112222222211111.133321",
  "12123311111223211222221111332121",
  "11112332332133211231133323321111",
  "11.11223211132111123112232211.11",
  "....111111132111111231111111....",
  "......11113221111112231111......",
  "....11111223111..11132211111....",
  "..113221122211....11132111231...",
  "..13211.12211......11321111231..",
  "..1311..112211....112211..1111..",
  "..1121...122111..111221...1211..",
  "...11111.111211..11211..11111...",
  "....111....1121111211....111....",
  "........11.1131111311.11........",
  "........1111111..1111111........",
  ".........11111....1111..........",
];

/**
 * The header mark: the same animal, drawn small.
 *
 * This one is hand-drawn rather than downsampled. Below eight pixels of height the reference's
 * tentacles have nowhere to hang and every mechanical reduction reads as a space invader — a flat
 * head over a stubby fringe. What survives at this size is the silhouette, so that is what this
 * keeps: the domed mantle, arms thrown wide, and the notch of open ground between the front pair.
 */
export const OCTOPUS_MARK: readonly string[] = [
  "....3443....",
  "..13444431..",
  "111344443111",
  "131222222131",
  "113122221311",
  "31122..22113",
  "1.11....11.1",
  "..11....11..",
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
 * Without colour the palette is gone but the shape is not, so the glyph alone carries it: a cell
 * with ink above and below is full, one with ink on a single side is that half. The rows are still
 * the right width, which is what lets the caller lay text out beside them either way.
 */
export function renderPixelArt(art: readonly string[], color: boolean): string[] {
  const width = pixelArtWidth(art);
  const lines: string[] = [];
  for (let row = 0; row < art.length; row += 2) {
    let line = "";
    for (let column = 0; column < width; column += 1) {
      line += renderCell(art[row]?.[column], art[row + 1]?.[column], color);
    }
    lines.push(color ? `${line}${RESET}` : line);
  }
  return lines;
}

/**
 * One text cell, from the two pixels stacked inside it.
 *
 * Every coloured cell re-states both of its own attributes after a reset rather than trusting what
 * the previous cell left set. A ground cell emits no colour at all, and inheriting the neighbour's
 * background would paint it — a trail of purple behind the tentacles.
 */
function renderCell(upper: string | undefined, lower: string | undefined, color: boolean): string {
  const above = PALETTE[upper ?? ""];
  const below = PALETTE[lower ?? ""];
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

function foreground([red, green, blue]: readonly [number, number, number]): string {
  return `\u001b[38;2;${red};${green};${blue}m`;
}

function background([red, green, blue]: readonly [number, number, number]): string {
  return `\u001b[48;2;${red};${green};${blue}m`;
}
