import { describe, expect, it, vi } from "vitest";
import { launchCockpit, type SpawnSyncLike } from "../../src/tmux/cockpit.js";

describe("launchCockpit", () => {
  it("creates a dashboard pane through the current Node executable and a plain shell pane", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return { status: args[0] === "has-session" ? 1 : 0 };
    });
    launchCockpit({
      cliPath: "/absolute/dist/src/cli.js",
      nodePath: "/absolute/node",
      spawnSync,
    });

    expect(calls).toContainEqual({
      command: "tmux",
      args: [
        "new-session", "-d", "-s", "cyberdeck",
        "/absolute/node", "/absolute/dist/src/cli.js", "dashboard",
      ],
    });
    expect(calls).toContainEqual({
      command: "tmux",
      args: ["split-window", "-h", "-t", "cyberdeck"],
    });
    expect(calls.at(-1)).toEqual({
      command: "tmux",
      args: ["attach-session", "-t", "cyberdeck"],
    });
    expect(JSON.stringify(calls)).not.toMatch(/claude|codex/);
  });

  it("reuses an existing cyberdeck tmux session", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    });
    launchCockpit({ cliPath: "/absolute/cli.js", nodePath: "/absolute/node", spawnSync });
    expect(calls).toEqual([
      { command: "tmux", args: ["has-session", "-t", "cyberdeck"] },
      { command: "tmux", args: ["attach-session", "-t", "cyberdeck"] },
    ]);
  });
});
