/**
 * The Cyberdeck octopus, drawn in ASCII, and the renderer that tones it.
 *
 * The art is plain text — one art row is one terminal row, and what you read in this file is what
 * the terminal shows. That is the whole argument for the idiom: a density ramp carries the volume
 * (`.:-` recede, `=+*` sit mid, `#%@` catch the light), so the shape survives a terminal with no
 * colour at all rather than collapsing into a violet blob the way stacked half-blocks do.
 *
 * Colour is therefore derived from the glyph rather than stored beside it. There is no parallel
 * palette grid and no `<c>` markup to keep in sync with the drawing: to edit the animal you edit
 * the animal, and the tone follows. A space paints nothing — never a background — so the octopus
 * sits on whatever the operator's terminal has and reads on a light theme and a dark one.
 */

/**
 * Three tones of the logo's violet, in the ramp's own order.
 *
 * These are the mark's hues and no state may borrow them, the same reservation `ANSI.brand` used to
 * carry in `fleet.ts` — a status colour that happened to match the octopus would read as the
 * octopus meaning something.
 *
 * All three are legible standing alone. That is a real constraint the half-block art did not have:
 * there, the near-black outline was always adjacent to a lit pixel and read as an edge, but an
 * ASCII glyph sits by itself on the terminal's own background, where a near-black violet is simply
 * gone on a dark theme.
 */
const TONES = {
  /** Recessed: the mantle's rim, the shadow under the arms, and the eyes. */
  shade: [124, 66, 158],
  /** The body's mid tone, and every structural stroke that draws an edge. */
  body: [158, 96, 208],
  /** Lit: the top of the mantle and the fill that catches the light. Octo Violet. */
  lit: [182, 158, 255],
} as const satisfies Record<string, readonly [number, number, number]>;

/**
 * Which tone each glyph carries.
 *
 * The ramp is ordered by ink, so the mapping is a ramp too. Structural strokes take the mid tone
 * because they are the drawing's edges, and `o` — the eye — takes the deepest so it reads as a
 * socket in a lit head rather than as another highlight.
 */
const GLYPH_TONE: Readonly<Record<string, keyof typeof TONES>> = {
  ".": "shade", ":": "shade", "-": "shade", "'": "shade", ",": "shade", "`": "shade",
  o: "shade",
  "=": "body", "+": "body", "*": "body",
  "(": "body", ")": "body", "{": "body", "}": "body",
  "/": "body", "\\": "body", "|": "body", _: "body",
  "#": "lit", "%": "lit", "@": "lit",
};

const RESET = "\u001b[0m";

/**
 * How long one frame of the mark holds, in milliseconds.
 *
 * 500 ms is Fleet's own idle cadence — the loop already wakes that often and already declines to
 * write a frame identical to the one on screen, so an animation on this beat costs one repaint per
 * tick and needs no timer of its own. It also sets the tempo: at two frames a second the arms make
 * a deliberate two-second curl, which is a movement 2 FPS flatters. Anything faster would only
 * expose the cadence as stutter.
 */
export const MARK_FRAME_INTERVAL_MS = 500;

/**
 * The header mark: four frames of the same octopus, 8 columns by 3 rows.
 *
 * Eight by three is the bay `DESIGN.md` has reserved all along. At that size the animal is a domed
 * mantle, two eyes, and eight arms, and nothing else fits — which is why the mantle and the eyes
 * are byte-identical across all four frames and only the arm row moves. A head that shifted even
 * one cell between frames would read as the header jittering rather than as an octopus swimming.
 *
 * The cycle is a four-beat paddle: neutral, arms flared out, neutral, arms tucked in. Frame 0 is
 * the rest pose, and it is what the mark holds whenever no thread is working.
 */
export const OCTOPUS_MARK_FRAMES: readonly (readonly string[])[] = [
  [
    " .-==-. ",
    "(o%##%o)",
    ")}{}{}{(",
  ],
  [
    " .-==-. ",
    "(o%##%o)",
    "\\{}{}{}/",
  ],
  [
    " .-==-. ",
    "(o%##%o)",
    ")}{}{}{(",
  ],
  [
    " .-==-. ",
    "(o%##%o)",
    "/{}{}{}\\",
  ],
];

/**
 * The empty fleet's octopus: the same animal with room to be drawn properly.
 *
 * This one does not animate, and that is not an omission. The splash renders only when the fleet is
 * empty, and an empty fleet has no thread that could be working — there is no state here for motion
 * to mean. Spending nothing on frames is what buys the drawing its size.
 */
export const OCTOPUS_SPLASH: readonly string[] = [
  "        .:-=+***+=-:.        ",
  "     .:+*#%@@@@@@@%#*+:.     ",
  "    :*#%@@@@@@@@@@@@@%#*:    ",
  "   .#%@@@(o)@@@@@(o)@@@%#.   ",
  "   :*%@@@@@@@@@@@@@@@@@%*:   ",
  "    '+*#%@@@@@@@@@@@%#*+'    ",
  "   .:)}{*#%@@@@@@@%#*}{(:.   ",
  "  /}{}{)   '=+*+='   (}{}{\\  ",
  " (  }{  '           '  }{  ) ",
  "  '  '                 '  '  ",
];

/** Width in terminal columns, which is the art's own width — one glyph per column. */
export function asciiArtWidth(art: readonly string[]): number {
  return art.reduce((widest, row) => Math.max(widest, row.length), 0);
}

/** Height in terminal rows, which is the art's own height — one art row per row. */
export function asciiArtHeight(art: readonly string[]): number {
  return art.length;
}

/**
 * Which frame of the mark is showing at `now`.
 *
 * The phase is taken from the wall clock rather than from a counter Fleet would have to hold and
 * advance, which is what keeps rendering a pure function of its inputs: the same `now` always draws
 * the same frame, in Fleet and in a test alike. Paints do not land exactly on the interval, so a
 * frame is occasionally held or skipped by one — invisible inside a two-second curl, and the price
 * of not inventing a clock.
 *
 * `animated` false pins the rest pose. Successive frames are then byte-identical, so Fleet's
 * repaint declines to write them and an idle fleet costs exactly what it did before.
 */
export function octopusMarkFrame(options: { now: number; animated: boolean }): readonly string[] {
  if (!options.animated) return OCTOPUS_MARK_FRAMES[0]!;
  const phase = Math.floor(options.now / MARK_FRAME_INTERVAL_MS);
  const index = ((phase % OCTOPUS_MARK_FRAMES.length) + OCTOPUS_MARK_FRAMES.length)
    % OCTOPUS_MARK_FRAMES.length;
  return OCTOPUS_MARK_FRAMES[index]!;
}

/**
 * Renders art into terminal rows, each exactly `asciiArtWidth` columns wide.
 *
 * Without colour the art is returned as it stands — the glyphs were always the drawing, so there is
 * nothing to fall back to. With colour, a run of like-toned glyphs shares one escape rather than
 * paying for one per cell, and every row is closed with a reset: a row that let its tone run on
 * would tint the header text laid out beside it.
 */
export function renderAsciiArt(art: readonly string[], color: boolean): string[] {
  const width = asciiArtWidth(art);
  return art.map((row) => {
    const padded = row.padEnd(width, " ");
    if (!color) return padded;
    let line = "";
    let open: keyof typeof TONES | undefined;
    for (const glyph of padded) {
      const tone = GLYPH_TONE[glyph];
      if (tone !== open) {
        line += tone === undefined ? RESET : foreground(TONES[tone]);
        open = tone;
      }
      line += glyph;
    }
    return `${line}${RESET}`;
  });
}

function foreground([red, green, blue]: readonly [number, number, number]): string {
  return `\u001b[38;2;${red};${green};${blue}m`;
}
