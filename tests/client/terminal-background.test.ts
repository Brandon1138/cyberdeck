import { describe, expect, it } from "vitest";

import { queryTerminalBackground } from "../../src/client/terminal-background.js";

/** A tty double that records the raw-mode trail, writes, and what was handed back. */
class FakeTty {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];
  unshifted: Buffer[] = [];
  paused = false;
  private listeners = new Set<(chunk: Buffer | string) => void>();

  setRawMode(raw: boolean): void {
    this.isRaw = raw;
    this.rawModes.push(raw);
  }
  on(_event: "data", listener: (chunk: Buffer | string) => void): void {
    this.listeners.add(listener);
  }
  off(_event: "data", listener: (chunk: Buffer | string) => void): void {
    this.listeners.delete(listener);
  }
  resume(): void {}
  pause(): void {
    this.paused = true;
  }
  unshift(chunk: Buffer): void {
    this.unshifted.push(chunk);
  }
  emit(chunk: Buffer | string): void {
    for (const listener of [...this.listeners]) listener(chunk);
  }
}

function fakeOutput(): { isTTY: boolean; writes: string[]; write(chunk: string | Uint8Array): void } {
  return {
    isTTY: true,
    writes: [],
    write(chunk: string | Uint8Array) {
      this.writes.push(String(chunk));
    },
  };
}

describe("queryTerminalBackground", () => {
  it("parses an xterm 16-bit reply closed by ST", async () => {
    const input = new FakeTty();
    const output = fakeOutput();
    const pending = queryTerminalBackground(input, output);
    expect(output.writes).toEqual(["\u001b]11;?\u0007"]);
    input.emit(Buffer.from("\u001b]11;rgb:ffff/ffff/ffff\u001b\\", "latin1"));
    await expect(pending).resolves.toEqual({ red: 255, green: 255, blue: 255 });
  });

  it("parses short channels and the BEL close, scaling each width to full range", async () => {
    const input = new FakeTty();
    const pending = queryTerminalBackground(input, fakeOutput());
    input.emit("\u001b]11;rgb:1e/28/3c\u0007");
    await expect(pending).resolves.toEqual({ red: 30, green: 40, blue: 60 });
  });

  it("accepts urxvt's rgba dialect and a reply split across chunks", async () => {
    const input = new FakeTty();
    const pending = queryTerminalBackground(input, fakeOutput());
    input.emit("\u001b]11;rgba:f/");
    input.emit("f/f/8\u0007");
    await expect(pending).resolves.toEqual({ red: 255, green: 255, blue: 255 });
  });

  it("resolves unknown when the terminal never answers, restoring raw mode", async () => {
    const input = new FakeTty();
    await expect(queryTerminalBackground(input, fakeOutput(), 5)).resolves.toBeUndefined();
    // Raw went on for the read and came back off, because the caller inherits the tty as found.
    expect(input.rawModes).toEqual([true, false]);
    expect(input.paused).toBe(true);
  });

  it("hands back typed-ahead bytes that were not the reply", async () => {
    const input = new FakeTty();
    const pending = queryTerminalBackground(input, fakeOutput());
    input.emit("abc");
    input.emit("\u001b]11;rgb:00/00/00\u0007xyz");
    await expect(pending).resolves.toEqual({ red: 0, green: 0, blue: 0 });
    expect(Buffer.concat(input.unshifted).toString()).toBe("abcxyz");
  });

  it("asks nothing of a terminal that is not one", async () => {
    const input = new FakeTty();
    input.isTTY = false;
    const output = fakeOutput();
    await expect(queryTerminalBackground(input, output)).resolves.toBeUndefined();
    expect(output.writes).toEqual([]);
    expect(input.rawModes).toEqual([]);
  });
});
