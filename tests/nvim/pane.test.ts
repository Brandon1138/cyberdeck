import { describe, expect, it, vi } from "vitest";
import type { SpawnSyncLike } from "../../src/tmux/cockpit.js";
import { discoverNvimPane, findNvimPane } from "../../src/nvim/pane.js";

function tmux(panes: string, windowId = "@4"): SpawnSyncLike {
  return vi.fn<SpawnSyncLike>((_command, args) => {
    if (args[0] === "display-message") return { status: 0, stdout: `${windowId}\n` };
    return { status: 0, stdout: panes };
  });
}

describe("findNvimPane", () => {
  it("names the live nvim pane", () => {
    expect(findNvimPane("%1\t0\tzsh\n%2\t0\tnvim\n%3\t0\tnode\n")).toBe("%2");
  });

  it("skips a dead pane still advertising nvim", () => {
    expect(findNvimPane("%1\t1\tnvim\n%2\t0\tnvim\n")).toBe("%2");
  });

  it("does not match a pane whose foreground process is something nvim spawned", () => {
    // `pane_current_command` reports the child, and a busy nvim has nothing listening for us.
    expect(findNvimPane("%1\t0\tgit\n%2\t0\tzsh\n")).toBeUndefined();
  });
});

describe("discoverNvimPane", () => {
  it("only ever lists the window the caller occupies", () => {
    const spawnSync = tmux("%2\t0\tnvim\n", "@9");
    const pane = discoverNvimPane({ spawnSync, hostPaneId: "%1", uid: 501 });

    expect(pane).toEqual({ paneId: "%2", address: "/tmp/cyberdeck-nvim-501/pane-2.sock" });
    expect(spawnSync).toHaveBeenCalledWith(
      "tmux",
      ["list-panes", "-t", "@9", "-F", "#{pane_id}\t#{pane_dead}\t#{pane_current_command}"],
      { encoding: "utf8" },
    );
  });

  it("reports no nvim as an actionable error instead of falling back", () => {
    const calls: string[][] = [];
    const spawnSync: SpawnSyncLike = (_command, args) => {
      calls.push(args);
      if (args[0] === "display-message") return { status: 0, stdout: "@4\n" };
      return { status: 0, stdout: "%1\t0\tzsh\n" };
    };
    let thrown: unknown;
    try {
      discoverNvimPane({ spawnSync, hostPaneId: "%1", uid: 501 });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { code?: string }).code).toBe("NVIM_NOT_IN_WINDOW");
    expect(String(thrown)).toMatch(/Open nvim here/u);
    // No nvim is spawned and no other window is searched: two tmux reads and then the error.
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toMatch(/new-window|split-window|nvim/u);
  });
});
