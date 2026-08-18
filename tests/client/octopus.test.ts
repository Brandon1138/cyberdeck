import { describe, expect, it } from "vitest";

import {
  MARK_FRAME_INTERVAL_MS,
  OCTOPUS_MARK_FRAMES,
  OCTOPUS_SPLASH,
  asciiArtHeight,
  asciiArtWidth,
  octopusMarkFrame,
  renderAsciiArt,
} from "../../src/client/octopus.js";

/** Every escape stripped, leaving only what the terminal would actually show. */
function plain(line: string): string {
  return line.replaceAll(/\u001b\[[\d;]*m/gu, "");
}

const ALL_ART = [...OCTOPUS_MARK_FRAMES, OCTOPUS_SPLASH];

describe("octopus", () => {
  it("keeps every frame rectangular so a row never renders short", () => {
    for (const art of ALL_ART) {
      const width = asciiArtWidth(art);
      expect(art.map((row) => row.length)).toEqual(art.map(() => width));
    }
  });

  it("gives every mark frame the same footprint so the header cannot jitter", () => {
    // This is the invariant the animation rests on: the arms move, the bay does not. A frame one
    // column wider would shift the text beside it twice a second.
    const [rest] = OCTOPUS_MARK_FRAMES;
    for (const frame of OCTOPUS_MARK_FRAMES) {
      expect([asciiArtWidth(frame), asciiArtHeight(frame)])
        .toEqual([asciiArtWidth(rest!), asciiArtHeight(rest!)]);
    }
  });

  it("holds the mantle and eyes still, moving only the arms", () => {
    // A head that shifted between frames would read as the header flickering rather than as an
    // octopus swimming, so only the last row is allowed to differ.
    const [rest] = OCTOPUS_MARK_FRAMES;
    for (const frame of OCTOPUS_MARK_FRAMES) {
      expect(frame.slice(0, -1)).toEqual(rest!.slice(0, -1));
    }
    expect(new Set(OCTOPUS_MARK_FRAMES.map((frame) => frame.at(-1))).size).toBeGreaterThan(1);
  });

  it("draws the mark into the header's bay and the splash large enough to read", () => {
    // Eight by three is the bay DESIGN.md reserves, and the smallest an octopus can be drawn and
    // still read as one. The splash is the only surface that can afford more.
    const [rest] = OCTOPUS_MARK_FRAMES;
    expect([asciiArtWidth(rest!), asciiArtHeight(rest!)]).toEqual([8, 3]);
    expect([asciiArtWidth(OCTOPUS_SPLASH), asciiArtHeight(OCTOPUS_SPLASH)]).toEqual([29, 10]);
  });

  it("renders every row to exactly the art's width, coloured or not", () => {
    for (const art of ALL_ART) {
      const width = asciiArtWidth(art);
      for (const color of [true, false]) {
        const lines = renderAsciiArt(art, color);
        expect(lines).toHaveLength(asciiArtHeight(art));
        // A row that measured wrong would push the header text out of alignment, or soft-wrap the
        // splash into a fragment line the viewport never counted.
        expect(lines.map((line) => [...plain(line)].length)).toEqual(lines.map(() => width));
      }
    }
  });

  it("carries the shape into a colourless terminal as the glyphs themselves", () => {
    // The ramp is the drawing, so there is nothing to fall back to — the art comes back verbatim.
    for (const art of ALL_ART) {
      expect(renderAsciiArt(art, false)).toEqual([...art]);
    }
  });

  it("paints no background so the art sits on the operator's own", () => {
    for (const line of renderAsciiArt(OCTOPUS_SPLASH, true)) {
      expect(line).not.toContain("48;2;");
    }
  });

  it("closes every coloured row so no attribute leaks into the text beside it", () => {
    for (const art of ALL_ART) {
      for (const line of renderAsciiArt(art, true)) {
        expect(line.endsWith("\u001b[0m")).toBe(true);
      }
    }
  });

  it("pins the rest pose whenever nothing is working", () => {
    for (const now of [0, 1, 500, 12_345, Date.now()]) {
      expect(octopusMarkFrame({ now, animated: false })).toBe(OCTOPUS_MARK_FRAMES[0]);
    }
  });

  it("takes its frame from the clock alone, so one instant always draws one octopus", () => {
    expect(octopusMarkFrame({ now: 7_000, animated: true }))
      .toBe(octopusMarkFrame({ now: 7_000, animated: true }));
  });

  it("advances exactly one frame per interval and wraps", () => {
    const frames = OCTOPUS_MARK_FRAMES.length;
    const at = (step: number) =>
      octopusMarkFrame({ now: step * MARK_FRAME_INTERVAL_MS, animated: true });
    for (let step = 0; step < frames; step += 1) {
      expect(at(step)).toBe(OCTOPUS_MARK_FRAMES[step]);
    }
    expect(at(frames)).toBe(OCTOPUS_MARK_FRAMES[0]);
    // A clock behind the epoch is not a real Fleet, but a negative modulo would index off the end.
    expect(at(-1)).toBe(OCTOPUS_MARK_FRAMES.at(-1));
  });

  it("holds a frame across the whole interval rather than sliding within it", () => {
    expect(octopusMarkFrame({ now: MARK_FRAME_INTERVAL_MS / 2, animated: true }))
      .toBe(octopusMarkFrame({ now: 0, animated: true }));
  });
});
