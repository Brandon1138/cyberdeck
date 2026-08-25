import { describe, expect, it } from "vitest";

import {
  OCTOPUS_MARK,
  OCTOPUS_SPLASH,
  pixelArtHeight,
  pixelArtWidth,
  renderPixelArt,
} from "../../src/client/octopus.js";

/** Every visible byte stripped, leaving only what the terminal would actually show. */
function plain(line: string): string {
  return line.replaceAll(/\u001b\[[\d;]*m/gu, "");
}

describe("octopus", () => {
  it("keeps both grids rectangular so a row never renders short", () => {
    for (const art of [OCTOPUS_MARK, OCTOPUS_SPLASH]) {
      const width = pixelArtWidth(art);
      expect(art.map((row) => row.length)).toEqual(art.map(() => width));
    }
  });

  it("pairs two pixel rows into one terminal row", () => {
    expect(pixelArtHeight(OCTOPUS_MARK)).toBe(OCTOPUS_MARK.length / 2);
    // The splash has an odd pixel height, so its last row carries a top pixel and nothing under it.
    expect(OCTOPUS_SPLASH.length % 2).toBe(1);
    expect(pixelArtHeight(OCTOPUS_SPLASH)).toBe((OCTOPUS_SPLASH.length + 1) / 2);
  });

  it("renders every row to exactly the art's width, coloured or not", () => {
    for (const art of [OCTOPUS_MARK, OCTOPUS_SPLASH]) {
      const width = pixelArtWidth(art);
      for (const color of [true, false]) {
        const lines = renderPixelArt(art, color);
        expect(lines).toHaveLength(pixelArtHeight(art));
        // A row that measured wrong would push the header text out of alignment, or soft-wrap the
        // splash into a fragment line the viewport never counted.
        expect(lines.map((line) => [...plain(line)].length)).toEqual(lines.map(() => width));
      }
    }
  });

  it("leaves the ground uncoloured so the art sits on the operator's own background", () => {
    const [firstRow] = renderPixelArt(["....", "...."], true);
    expect(plain(firstRow!)).toBe("    ");
    expect(firstRow).not.toContain("48;2;");
  });

  it("closes every coloured row so no attribute leaks into the text beside it", () => {
    for (const line of renderPixelArt(OCTOPUS_MARK, true)) {
      expect(line.endsWith("\u001b[0m")).toBe(true);
    }
  });

  it("carries the shape into a colourless terminal with half blocks alone", () => {
    // Ink above and below is a full cell; ink on one side is that half; neither is blank.
    expect(renderPixelArt(["x.x.", ".xx."], false)).toEqual(["▀▄█ "]);
    expect(renderPixelArt(["xxxx"], false)).toEqual(["▀▀▀▀"]);
  });

  it("inks the animal the same on any ground, and on none", () => {
    // One ink is the whole point of MIK-160: an unanswered OSC 11 query, a black terminal and a
    // white one all get the same purple, so there is no palette left to pick wrongly.
    const solid = ["xxx", "xxx", "xxx"];
    const interior = "48;2;158;84;196";
    expect(renderPixelArt(solid, true).join("\n")).toContain(interior);
    expect(renderPixelArt(solid, true, { red: 255, green: 255, blue: 255 }).join("\n"))
      .toContain(interior);
    expect(renderPixelArt(solid, true, { red: 0, green: 0, blue: 0 }).join("\n"))
      .toContain(interior);
  });

  it("cuts the eyes out of the ink rather than painting them", () => {
    // The eyes are ground, which is what lets them invert for free: on a white terminal they are
    // white, on a black one black, and no second colour is involved either way.
    const row = OCTOPUS_MARK[2]!;
    expect(row).toMatch(/x{2,}\.x+\.x{2,}/u);
    for (const art of [OCTOPUS_MARK, OCTOPUS_SPLASH]) {
      expect(art.every((line) => /^[.x]+$/u.test(line))).toBe(true);
    }
  });

  it("feathers silhouette pixels toward a known background and leaves the interior alone", () => {
    const solid = ["xxx", "xxx", "xxx"];
    const [first] = renderPixelArt(solid, true, { red: 0, green: 0, blue: 0 });
    // Top-left pixel has open ground above and left: 30% of the way to black from [158, 84, 196].
    expect(first).toContain("38;2;111;59;137");
    // The centre pixel, walled in on all four sides, keeps the ink untouched.
    expect(first).toContain("48;2;158;84;196");
  });

  it("keeps the ground unpainted even when the background is known", () => {
    const background = { red: 255, green: 255, blue: 255 };
    const [blank] = renderPixelArt(["....", "...."], true, background);
    expect(blank).not.toContain("48;2;");
    // A half-ground cell still rides the terminal's own background, never an explicit colour.
    const [mixed] = renderPixelArt(["x...", "...."], true, background);
    expect(mixed).toContain("[49m");
  });

  it("holds every row to the art's width with a background in play", () => {
    const background = { red: 255, green: 255, blue: 255 };
    for (const art of [OCTOPUS_MARK, OCTOPUS_SPLASH]) {
      const lines = renderPixelArt(art, true, background);
      expect(lines.map((line) => [...plain(line)].length)).toEqual(lines.map(() => pixelArtWidth(art)));
    }
  });

  it("draws the mark small enough for a header and the splash large enough to read", () => {
    // Eight pixel rows is the floor at which the octopus is still the octopus. Four terminal rows
    // is what that costs the header, and the splash is the only surface that can afford more.
    expect([pixelArtWidth(OCTOPUS_MARK), pixelArtHeight(OCTOPUS_MARK)]).toEqual([13, 4]);
    expect([pixelArtWidth(OCTOPUS_SPLASH), pixelArtHeight(OCTOPUS_SPLASH)]).toEqual([32, 14]);
  });
});
