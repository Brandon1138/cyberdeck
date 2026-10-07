import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { displayWidth } from "../../src/client/display-width.js";
import { clampRowWidth, printedWidth } from "../../src/client/fleet/render-composer.js";
import {
  createTerminalMascot,
  graphicsEscape,
  imagePlacement,
  imageTransmission,
  MASCOT_COLUMNS,
  MASCOT_ROWS,
} from "../../src/client/terminal-mascot.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

beforeEach(() => { vi.mocked(spawnSync).mockReset(); });

describe("native terminal mascot", () => {
  it("transmits the complete PNG in bounded, quiet chunks without moving the cursor", () => {
    const png = Buffer.from(Array.from({ length: 9000 }, (_, index) => index % 256));
    const transmission = imageTransmission(png, 0x123456, false);
    const chunks = [...transmission.matchAll(/\u001b_G([^;]+);([A-Za-z0-9+/=]*)\u001b\\/gu)];
    expect(chunks).toHaveLength(3);
    expect(chunks[0]![1]).toContain("a=T,f=100,t=d,U=1,C=1,i=1193046");
    expect(chunks[0]![1]).toContain(`c=${MASCOT_COLUMNS},r=${MASCOT_ROWS}`);
    for (const chunk of chunks) {
      expect(chunk[1]).toContain("q=2");
      expect(chunk[2]!.length).toBeLessThanOrEqual(4096);
      expect(chunk[2]!.length % 4).toBe(0);
    }
    expect(chunks.at(-1)![1]).toContain("m=0");
    expect(Buffer.from(chunks.map((chunk) => chunk[2]).join(""), "base64")).toEqual(png);
  });

  it("escapes each graphics command for tmux while leaving placeholder text as normal text", () => {
    expect(graphicsEscape("a=d,d=I,i=42,q=2", true))
      .toBe("\u001bPtmux;\u001b\u001b_Ga=d,d=I,i=42,q=2\u001b\u001b\\\u001b\\");
    for (const row of imagePlacement(42).rows) expect(row).not.toContain("tmux;");
  });

  it("survives retained-row measurement and clipping without splitting image coordinates", () => {
    const placement = imagePlacement(0x123456);
    expect(placement.rows).toHaveLength(MASCOT_ROWS);
    for (const row of placement.rows) {
      expect(printedWidth(row)).toBe(MASCOT_COLUMNS);
      expect(clampRowWidth(row, MASCOT_COLUMNS)).toBe(row);
      const clipped = clampRowWidth(row, 5);
      expect(printedWidth(clipped)).toBe(5);
      expect(clipped.endsWith("\u001b[0m")).toBe(true);
      const plain = clipped.replace(/\u001b\[[\d;]*m/gu, "");
      expect(displayWidth(plain)).toBe(5);
      expect(plain.match(/\u{10EEEE}/gu)).toHaveLength(5);
    }
  });

  it("emits nothing for logs or terminals without native image support", () => {
    const write = vi.fn();
    expect(createTerminalMascot({ isTTY: false, write }, { TERM: "xterm-ghostty" })).toBeUndefined();
    expect(createTerminalMascot({ isTTY: true, write }, { TERM: "xterm-256color" })).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("hides only the cursor cells, keeping the chevron pixels and layout unchanged", () => {
    const visible = imagePlacement(42);
    const hidden = imagePlacement(42, false);
    expect(hidden.rows.slice(0, 3)).toEqual(visible.rows.slice(0, 3));
    const last = hidden.rows[3]!.replace(/\u001b\[[\d;]*m/gu, "");
    expect(last.match(/\u{10EEEE}/gu)).toHaveLength(5);
    expect(last.endsWith("     ")).toBe(true);
    expect(printedWidth(hidden.rows[3]!)).toBe(MASCOT_COLUMNS);
    expect(clampRowWidth(hidden.rows[3]!, MASCOT_COLUMNS)).toBe(hidden.rows[3]);
  });

  it("uploads once, changes cursor coverage without uploading, and deletes only its image", () => {
    const write = vi.fn();
    const mascot = createTerminalMascot({ isTTY: true, write }, { TERM: "xterm-ghostty" })!;
    const initial = mascot.placement;
    mascot.enter();
    const ids = [...write.mock.calls[0]![0].matchAll(/a=T,f=100[^;]*,i=(\d+),/gu)]
      .map((match) => match[1]);
    expect(ids).toHaveLength(1);
    mascot.setCursorVisible!(false);
    expect(mascot.placement).not.toEqual(initial);
    mascot.setCursorVisible!(true);
    expect(mascot.placement).toEqual(initial);
    expect(write).toHaveBeenCalledTimes(1);
    mascot.dispose();
    const deleted = [...write.mock.calls[1]![0].matchAll(/a=d,d=I,i=(\d+),q=2/gu)]
      .map((match) => match[1]);
    expect(deleted).toEqual(ids);
  });

  it("restores only its own pane's inherited passthrough setting", () => {
    let local = "";
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      const command = args as string[];
      let stdout = "";
      if (command[0] === "display-message") stdout = "xterm-ghostty";
      else if (command[0] === "show-options") {
        stdout = command.includes("-pAv") ? "off" : command.includes("-pv") ? "on" : local;
      } else if (command[0] === "set-option") local = "allow-passthrough on";
      return { status: 0, stdout } as ReturnType<typeof spawnSync>;
    });
    const write = vi.fn();
    const mascot = createTerminalMascot({ isTTY: true, write }, { TMUX: "/tmp/example,1,0", TMUX_PANE: "%7" });
    expect(mascot).toBeDefined();
    mascot!.enter();
    expect(write.mock.calls[0]![0]).toContain("a=T,f=100");
    mascot!.dispose();
    expect(write.mock.calls[1]![0]).toMatch(/a=d,d=I,i=\d+,q=2/u);
    const mutations = vi.mocked(spawnSync).mock.calls
      .map((call) => call[1] as string[]).filter((args) => args[0] === "set-option");
    expect(mutations).toEqual([
      ["set-option", "-p", "-t", "%7", "allow-passthrough", "on"],
      ["set-option", "-pu", "-t", "%7", "allow-passthrough"],
    ]);
  });
});
