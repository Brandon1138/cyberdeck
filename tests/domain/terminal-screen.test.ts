import { describe, expect, it } from "vitest";
import { InputScreen } from "../../src/domain/terminal-screen.js";

describe("scroll regions", () => {
  it("leaves visible cells and their write ordering intact when scrollback is cleared", () => {
    const screen = new InputScreen();
    screen.append("\u001b[H\u001b[2J› Ask Codex to do anything\u001b[3;1HGPT-6.1-Sol low · /tmp/repo");
    const before = screen.snapshot()!;
    screen.append("\u001b[3J");
    expect(screen.snapshot()?.text).toBe(before.text);
    expect(screen.snapshot()?.writtenAt(0, before.text.length)).toBe(before.writtenAt(0, before.text.length));
    expect(screen.snapshot()?.clearedAt).toBe(before.clearedAt);
  });

  it.each(["reverse index", "line feed"])("recovers after uncertain glyph cells leave a scroll region by %s", operation => {
    const screen = new InputScreen();
    screen.append("\u001b[1;3r" + (operation === "reverse index" ? "\u001b[3;1H" : "\u001b[1;1H") + "文言文");
    expect(screen.snapshot()).toBeUndefined();
    screen.append(operation === "reverse index" ? "\u001b[1;1H\u001bM" : "\u001b[3;1H\n");
    screen.append("\u001b[r\u001b[4;1H› Ask Codex to do anything\u001b[6;1HGPT-6.1-Sol low · /tmp/repo");
    expect(screen.snapshot()?.text).toContain("› Ask Codex to do anything");
  });

  it("recovers only after uncertain cells have been explicitly erased", () => {
    const screen = new InputScreen();
    screen.append("\u001b[1;1HAnswer 文\u001b[4;1H› \u001b[6;1H? for shortcuts");
    expect(screen.snapshot()).toBeUndefined();
    screen.append("\u001b[1;1H\u001b[2KAnswer");
    expect(screen.snapshot()?.text).toContain("Answer");
    screen.append("\u001b[1P\u001b[1;1H\u001b[2K");
    expect(screen.snapshot()).toBeUndefined();
  });

  it("keeps uncertainty outside a scroll region and across partial erasure", () => {
    const screen = new InputScreen();
    screen.append("\u001b[1;1H文\u001b[2;3r\u001b[3;1H\n\u001b[1;2H\u001b[K");
    expect(screen.snapshot()).toBeUndefined();
    screen.append("\u001b[3J");
    expect(screen.snapshot()).toBeUndefined();
    screen.append("\u001b[1;1H\u001b[K");
    expect(screen.snapshot()).toBeDefined();
  });

  it.each(["reverse index", "line feed"])("confines %s to the region and preserves outside write positions", operation => {
    const screen = new InputScreen();
    const initial = "\u001b[1;1Habove\u001b[8;1Htop\u001b[9;1Hmiddle\u001b[10;1Hbottom\u001b[11;1Hbelow";
    screen.append(initial);
    const outsideAt = screen.snapshot()!.writtenAt(screen.text().indexOf("below"), screen.text().length);
    screen.append("\u001b[8;10r" + (operation === "reverse index" ? "\u001b[8;1H\u001bM" : "\u001b[10;1H\n"));
    const rows = screen.text().split("\n");
    expect(rows[0]).toBe("above");
    expect(rows.slice(7, 10)).toEqual(operation === "reverse index" ? ["", "top", "middle"] : ["middle", "bottom", ""]);
    expect(rows[10]).toBe("below");
    expect(screen.snapshot()!.writtenAt(screen.text().indexOf("below"), screen.text().length)).toBe(outsideAt);
  });

  it.each(["\u001b[8;1H\u001bM", "\u001b[10;1H\n"])("keeps sparse rows in place inside the region (%s)", edit => {
    const screen = new InputScreen();
    screen.append("\u001b[1;1Habove\u001b[8;10r" + edit);
    screen.append("\u001b[r\u001b[11;1Hbelow");
    expect(screen.text().split("\n")[0]).toBe("above");
    expect(screen.text().split("\n")[10]).toBe("below");
  });
});
