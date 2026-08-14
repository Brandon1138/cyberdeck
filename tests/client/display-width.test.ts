import { describe, expect, it } from "vitest";
import { displayWidth, graphemeWidth, graphemes } from "../../src/client/display-width.js";

describe("displayWidth", () => {
  it("counts plain text one cell per character", () => {
    expect(displayWidth("cyberdeck")).toBe(9);
    expect(displayWidth("")).toBe(0);
  });

  it("counts an ideograph as the two cells the terminal draws", () => {
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("ab日")).toBe(4);
  });

  it("counts an emoji as two cells whether or not it is a single code point", () => {
    expect(displayWidth("\u{1f419}")).toBe(2);
    expect(displayWidth("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}")).toBe(2);
    expect(displayWidth("\u{1f1f7}\u{1f1f4}")).toBe(2);
    expect(displayWidth("\u2764\uFE0F")).toBe(2);
  });

  it("counts a BMP character with default emoji presentation as two cells", () => {
    expect(displayWidth("\u231A")).toBe(2); // \u231A draws as emoji without any variation selector
    expect(displayWidth("\u231B")).toBe(2); // \u231B likewise
    expect(displayWidth("\u2194")).toBe(1); // \u2194 defaults to text presentation and stays narrow
  });

  it("counts a combining mark with the character it decorates", () => {
    expect(displayWidth("\u00e9")).toBe(1);
    expect(displayWidth("e\u0301")).toBe(1);
  });

  it("counts control bytes as nothing, because they print nothing", () => {
    expect(displayWidth("\u0007")).toBe(0);
    expect(displayWidth("a\u0007b")).toBe(2);
  });

  it("splits into the units the terminal draws one at a time", () => {
    expect(graphemes("a\u{1f419}")).toEqual(["a", "\u{1f419}"]);
    expect(graphemes("e\u0301x")).toEqual(["e\u0301", "x"]);
    expect(graphemeWidth("\u{1f419}")).toBe(2);
    expect(graphemeWidth("x")).toBe(1);
  });
});
