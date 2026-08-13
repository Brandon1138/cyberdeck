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

  it("draws the mark small enough for a header and the splash large enough to read", () => {
    // Eight pixel rows is the floor at which the octopus is still the octopus. Four terminal rows
    // is what that costs the header, and the splash is the only surface that can afford more.
    expect([pixelArtWidth(OCTOPUS_MARK), pixelArtHeight(OCTOPUS_MARK)]).toEqual([12, 4]);
    expect([pixelArtWidth(OCTOPUS_SPLASH), pixelArtHeight(OCTOPUS_SPLASH)]).toEqual([32, 14]);
  });
});
