import { describe, expect, it } from "vitest";
import {
  NVIM_SOCKET_DIRECTORY_PREFIX,
  nvimServerAddress,
  nvimSocketDirectory,
} from "../../src/nvim/server-address.js";

describe("nvimSocketDirectory", () => {
  it("puts the uid in the directory so two operators never share a parent", () => {
    expect(nvimSocketDirectory(501)).toBe(`${NVIM_SOCKET_DIRECTORY_PREFIX}501`);
    expect(nvimSocketDirectory(0)).not.toBe(nvimSocketDirectory(501));
  });
});

describe("nvimServerAddress", () => {
  it("derives one socket per tmux pane", () => {
    expect(nvimServerAddress("%7", 501)).toBe(`${NVIM_SOCKET_DIRECTORY_PREFIX}501/pane-7.sock`);
    expect(nvimServerAddress(" %12 ", 501)).toBe(`${NVIM_SOCKET_DIRECTORY_PREFIX}501/pane-12.sock`);
  });

  it("refuses anything that is not a pane id rather than normalizing it", () => {
    expect(() => nvimServerAddress("7", 501)).toThrow(/Not a tmux pane id/u);
    expect(() => nvimServerAddress("%main", 501)).toThrow(/Not a tmux pane id/u);
    expect(() => nvimServerAddress("$3", 501)).toThrow(/Not a tmux pane id/u);
  });

  it("matches what the shipped Lua module derives for the same pane", () => {
    // contrib/nvim/lua/cyberdeck/init.lua builds `<prefix><uid>/pane-<index>.sock` from $TMUX_PANE.
    // If this expectation changes, that file changes with it or every request lands on a dead socket.
    expect(nvimServerAddress("%0", 1000)).toBe("/tmp/cyberdeck-nvim-1000/pane-0.sock");
  });
});
