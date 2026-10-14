import { describe, expect, it } from "vitest";
import { InputScreen } from "../../src/domain/terminal-screen.js";

describe("scroll regions", () => {
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
