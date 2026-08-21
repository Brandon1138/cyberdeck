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
    expect(renderPixelArt(["1.1.", ".11."], false)).toEqual(["▀▄█ "]);
    expect(renderPixelArt(["1111"], false)).toEqual(["▀▀▀▀"]);
  });

  it("renders without a background exactly as it always has", () => {
    // Dark outline throughout, no light-palette outline, no feathering: an unanswered OSC 11
    // query must cost nothing visually.
    const lines = renderPixelArt(OCTOPUS_MARK, true).join("\n");
    expect(lines).toContain("38;2;35;9;69");
    expect(lines).not.toContain("38;2;74;43;110");
  });

  it("swaps to the light palette when the terminal says its background is light", () => {
    // 3x3 solid outline: the centre pixel is interior, so it carries the palette colour pure.
    const solid = ["111", "111", "111"];
    const light = renderPixelArt(solid, true, { red: 255, green: 255, blue: 255 }).join("\n");
    expect(light).toContain("48;2;74;43;110");
    expect(light).not.toContain("35;9;69");
    const dark = renderPixelArt(solid, true, { red: 0, green: 0, blue: 0 }).join("\n");
    expect(dark).toContain("48;2;35;9;69");
    expect(dark).not.toContain("74;43;110");
  });

  it("feathers silhouette pixels toward a known background and leaves the interior alone", () => {
    const solid = ["111", "111", "111"];
    const [first] = renderPixelArt(solid, true, { red: 0, green: 0, blue: 0 });
    // Top-left pixel has open ground above and left: 30% of the way to black from [35, 9, 69].
    expect(first).toContain("38;2;25;6;48");
    // The centre pixel, walled in on all four sides, keeps the palette colour untouched.
    expect(first).toContain("48;2;35;9;69");
  });

  it("keeps the ground unpainted even when the background is known", () => {
    const background = { red: 255, green: 255, blue: 255 };
    const [blank] = renderPixelArt(["....", "...."], true, background);
    expect(blank).not.toContain("48;2;");
    // A half-ground cell still rides the terminal's own background, never an explicit colour.
    const [mixed] = renderPixelArt(["1...", "...."], true, background);
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
    expect([pixelArtWidth(OCTOPUS_MARK), pixelArtHeight(OCTOPUS_MARK)]).toEqual([12, 4]);
    expect([pixelArtWidth(OCTOPUS_SPLASH), pixelArtHeight(OCTOPUS_SPLASH)]).toEqual([32, 14]);
  });
});
