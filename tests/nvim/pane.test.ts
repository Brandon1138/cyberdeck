import { describe, expect, it, vi } from "vitest";
import type { SpawnSyncLike } from "../../src/tmux/cockpit.js";
import {
  discoverNvimPane,
  findNvimPane,
  rightmostPane,
  type NvimSpawnOptions,
} from "../../src/nvim/pane.js";

function tmux(panes: string, windowId = "@4"): SpawnSyncLike {
  return vi.fn<SpawnSyncLike>((_command, args) => {
    if (args[0] === "display-message") return { status: 0, stdout: `${windowId}\n` };
    return { status: 0, stdout: panes };
  });
}

/**
 * A window with no nvim. `list-panes` answers in whichever format was asked for, so the layout read
 * and the command read stay distinguishable, and `split-window` reports the pane it created.
 */
function tmuxWithoutNvim(options: {
  windowId?: string;
  commands?: string;
  layout?: string;
  createdPaneId?: string;
  splitStatus?: number;
} = {}): { calls: string[][]; spawnSync: SpawnSyncLike } {
  const calls: string[][] = [];
  const spawnSync: SpawnSyncLike = (_command, args) => {
    calls.push(args);
    if (args[0] === "display-message") return { status: 0, stdout: `${options.windowId ?? "@4"}\n` };
    if (args[0] === "list-panes") {
      return args.includes("#{pane_id}\t#{pane_dead}\t#{pane_right}")
        ? { status: 0, stdout: options.layout ?? "%1\t0\t79\n%2\t0\t159\n" }
        : { status: 0, stdout: options.commands ?? "%1\t0\tzsh\n%2\t0\tnode\n" };
    }
    return {
      status: options.splitStatus ?? 0,
      stdout: `${options.createdPaneId ?? "%7"}\n`,
    };
  };
  return { calls, spawnSync };
}

/** Never sleeps for real: the injected clock is what moves, one poll interval per wait. */
function fakeWait(socketAppearsAfter: number): NvimSpawnOptions & { polls: () => number } {
  let clock = 1_000;
  let polls = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    socketExists: () => polls++ >= socketAppearsAfter,
    polls: () => polls,
  };
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

describe("rightmostPane", () => {
  it("names the pane furthest right rather than the first or last listed", () => {
    expect(rightmostPane("%1\t0\t79\n%3\t0\t239\n%2\t0\t159\n")).toBe("%3");
  });

  it("skips a dead pane tmux is only holding open", () => {
    expect(rightmostPane("%1\t0\t79\n%9\t1\t239\n")).toBe("%1");
  });

  it("keeps the first of two panes stacked at the same right edge", () => {
    expect(rightmostPane("%1\t0\t79\n%2\t0\t159\n%3\t0\t159\n")).toBe("%2");
  });

  it("has nothing to say about a window it cannot parse", () => {
    expect(rightmostPane("")).toBeUndefined();
  });
});

describe("discoverNvimPane", () => {
  it("only ever lists the window the caller occupies", async () => {
    const spawnSync = tmux("%2\t0\tnvim\n", "@9");
    const pane = await discoverNvimPane({ spawnSync, hostPaneId: "%1", uid: 501 });

    expect(pane).toEqual({ paneId: "%2", address: "/tmp/cyberdeck-nvim-501/pane-2.sock" });
    expect(spawnSync).toHaveBeenCalledWith(
      "tmux",
      ["list-panes", "-t", "@9", "-F", "#{pane_id}\t#{pane_dead}\t#{pane_current_command}"],
      { encoding: "utf8" },
    );
  });

  it("uses the nvim already in the window and starts nothing", async () => {
    const calls: string[][] = [];
    const spawnSync: SpawnSyncLike = (_command, args) => {
      calls.push(args);
      if (args[0] === "display-message") return { status: 0, stdout: "@4\n" };
      return { status: 0, stdout: "%1\t0\tzsh\n%2\t0\tnvim\n" };
    };

    const pane = await discoverNvimPane({ spawnSync, hostPaneId: "%1", uid: 501 });

    expect(pane.paneId).toBe("%2");
    expect(JSON.stringify(calls)).not.toMatch(/split-window|new-window/u);
  });

  it("splits the rightmost pane, not Fleet's, when the window has no nvim", async () => {
    const { calls, spawnSync } = tmuxWithoutNvim({
      windowId: "@9",
      layout: "%1\t0\t79\n%2\t0\t159\n",
      createdPaneId: "%7",
    });

    const pane = await discoverNvimPane({
      spawnSync,
      hostPaneId: "%1",
      uid: 501,
      spawn: fakeWait(0),
    });

    // The orchestrator attachment already sits right of Fleet; nvim goes beyond it, not between.
    expect(calls).toContainEqual([
      "split-window", "-h", "-P", "-F", "#{pane_id}", "-t", "%2", "nvim",
    ]);
    expect(calls.filter((args) => args[0] === "split-window")).toHaveLength(1);
    // The address is derived from the id tmux reported for the pane it made, never guessed.
    expect(pane).toEqual({ paneId: "%7", address: "/tmp/cyberdeck-nvim-501/pane-7.sock" });
  });

  it("falls back to Fleet's own pane when the window reports no live pane to split", async () => {
    const { calls, spawnSync } = tmuxWithoutNvim({ layout: "%1\t1\t79\n" });

    await discoverNvimPane({ spawnSync, hostPaneId: "%1", uid: 501, spawn: fakeWait(0) });

    expect(calls).toContainEqual([
      "split-window", "-h", "-P", "-F", "#{pane_id}", "-t", "%1", "nvim",
    ]);
  });

  it("waits for the socket the spawned nvim has not created yet", async () => {
    const { spawnSync } = tmuxWithoutNvim({ createdPaneId: "%7" });
    const wait = fakeWait(3);

    const pane = await discoverNvimPane({
      spawnSync,
      hostPaneId: "%1",
      uid: 501,
      spawn: { ...wait, pollIntervalMs: 10, timeoutMs: 5_000 },
    });

    expect(pane.address).toBe("/tmp/cyberdeck-nvim-501/pane-7.sock");
    expect(wait.polls()).toBe(4);
  });

  it("reports a spawned nvim that never listens instead of talking to nobody", async () => {
    const { calls, spawnSync } = tmuxWithoutNvim({ createdPaneId: "%7" });
    let clock = 0;
    let thrown: unknown;

    try {
      await discoverNvimPane({
        spawnSync,
        hostPaneId: "%1",
        uid: 501,
        spawn: {
          now: () => clock,
          sleep: async (ms: number) => {
            clock += ms;
          },
          socketExists: () => false,
          pollIntervalMs: 100,
          timeoutMs: 1_000,
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { code?: string }).code).toBe("NVIM_SPAWN_NOT_SERVING");
    expect(String(thrown)).toMatch(/pane-7\.sock/u);
    expect(String(thrown)).toMatch(/require\("cyberdeck"\)\.listen\(\)/u);
    expect(clock).toBeGreaterThanOrEqual(1_000);
    // No `--remote-expr` was attempted against the dead address.
    expect(JSON.stringify(calls)).not.toMatch(/remote-expr/u);
  });

  it("surfaces a tmux split that failed rather than deriving an address from nothing", async () => {
    const { spawnSync } = tmuxWithoutNvim({ splitStatus: 1 });

    await expect(discoverNvimPane({
      spawnSync,
      hostPaneId: "%1",
      uid: 501,
      spawn: fakeWait(0),
    })).rejects.toThrow(/tmux failed to open an nvim pane/u);
  });

  it("refuses to continue when tmux does not name the pane it created", async () => {
    const { spawnSync } = tmuxWithoutNvim({ createdPaneId: "" });
    let thrown: unknown;

    try {
      await discoverNvimPane({ spawnSync, hostPaneId: "%1", uid: 501, spawn: fakeWait(0) });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { code?: string }).code).toBe("NVIM_SPAWN_UNIDENTIFIED");
  });
});
