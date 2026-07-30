import { describe, expect, it, vi } from "vitest";
import {
  detachCockpit,
  cockpitSessionName,
  inspectCockpitPanes,
  launchCockpit,
  preflightCockpit,
  type SpawnSyncLike,
} from "../../src/tmux/cockpit.js";

describe("launchCockpit", () => {
  const cwd = "/repo/one";
  const target = cockpitSessionName(cwd);
  const orchestratorSessionId = "11111111-1111-4111-8111-111111111111";
  const outsideTmux = { tmuxVersion: "tmux 3.5a", presentationCommand: "attach-session" as const };

  it("creates a dashboard pane and attaches the broker-owned orchestrator in the right pane", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return { status: args[0] === "has-session" ? 1 : 0 };
    });
    launchCockpit({
      cliPath: "/absolute/dist/src/cli.js",
      nodePath: "/absolute/node",
      cwd,
      orchestratorSessionId,
      spawnSync,
      preflight: outsideTmux,
    });

    expect(calls).toContainEqual({
      command: "tmux",
      args: [
        "new-session", "-d", "-s", target,
        "/absolute/node", "/absolute/dist/src/cli.js", "dashboard",
      ],
    });
    expect(calls).toContainEqual({
      command: "tmux",
      args: [
        "split-window", "-h", "-t", target,
        "/absolute/node", "/absolute/dist/src/cli.js", "attach", orchestratorSessionId,
        "--cockpit-return", "detach",
      ],
    });
    expect(calls.at(-1)).toEqual({
      command: "tmux",
      args: ["attach-session", "-t", target],
    });
    expect(JSON.stringify(calls)).not.toMatch(/send-keys/);
  });

  it("shortens the tmux escape window so Esc and Option chords are not held by tmux", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return { status: args[0] === "has-session" ? 1 : 0 };
    });
    launchCockpit({
      cliPath: "/absolute/dist/src/cli.js",
      nodePath: "/absolute/node",
      cwd,
      orchestratorSessionId,
      spawnSync,
      preflight: outsideTmux,
    });

    expect(calls).toContainEqual({
      command: "tmux",
      args: ["set-option", "-s", "escape-time", "10"],
    });
  });

  it("reuses an existing cyberdeck tmux session", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      if (args[0] === "list-panes") {
        return {
          status: 0,
          stdout: `%7\t/absolute/node /absolute/cli.js attach ${orchestratorSessionId} --cockpit-return detach\n`,
        };
      }
      return { status: 0 };
    });
    launchCockpit({
      cliPath: "/absolute/cli.js",
      nodePath: "/absolute/node",
      cwd,
      orchestratorSessionId,
      spawnSync,
      preflight: outsideTmux,
    });
    expect(calls).toEqual([
      { command: "tmux", args: ["has-session", "-t", target] },
      { command: "tmux", args: ["list-panes", "-t", target, "-F", "#{pane_id}\t#{pane_start_command}"] },
      { command: "tmux", args: ["select-pane", "-t", "%7"] },
      { command: "tmux", args: ["attach-session", "-t", target] },
    ]);
  });

  it("recreates a closed orchestrator pane in an existing cockpit", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      if (args[0] === "list-panes") {
        return { status: 0, stdout: "%0\t/absolute/node /absolute/cli.js dashboard\n" };
      }
      return { status: 0 };
    });

    launchCockpit({
      cliPath: "/absolute/cli.js",
      nodePath: "/absolute/node",
      cwd,
      orchestratorSessionId,
      spawnSync,
      preflight: outsideTmux,
    });

    expect(calls).toContainEqual({
      command: "tmux",
      args: [
        "split-window", "-h", "-t", target,
        "/absolute/node", "/absolute/cli.js", "attach", orchestratorSessionId,
        "--cockpit-return", "detach",
      ],
    });
  });

  it("multiplexes another orchestrator without replacing the existing cockpit panes", () => {
    const otherSessionId = "22222222-2222-4222-8222-222222222222";
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      if (args[0] === "list-panes") {
        return {
          status: 0,
          stdout: [
            "%0\t/absolute/node /absolute/cli.js dashboard",
            `%1\t/absolute/node /absolute/cli.js attach ${otherSessionId} --cockpit-return detach`,
          ].join("\n"),
        };
      }
      return { status: 0 };
    });

    launchCockpit({
      cliPath: "/absolute/cli.js",
      nodePath: "/absolute/node",
      cwd,
      orchestratorSessionId,
      spawnSync,
      preflight: outsideTmux,
    });

    expect(calls).toContainEqual({
      command: "tmux",
      args: [
        "split-window", "-h", "-t", target,
        "/absolute/node", "/absolute/cli.js", "attach", orchestratorSessionId,
        "--cockpit-return", "detach",
      ],
    });
    expect(calls.some(({ args }) => args[0] === "kill-pane" || args[0] === "respawn-pane")).toBe(false);
  });

  it("never terminates presentation state on a successful launch", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return { status: args[0] === "has-session" ? 1 : 0 };
    });
    launchCockpit({
      cliPath: "/absolute/cli.js",
      nodePath: "/absolute/node",
      cwd,
      orchestratorSessionId,
      spawnSync,
      preflight: outsideTmux,
    });

    const verbs = calls.map((call) => call.args[0]);
    expect(verbs).not.toContain("kill-session");
    expect(verbs).not.toContain("kill-pane");
    expect(verbs).not.toContain("kill-server");
    expect(verbs).not.toContain("respawn-pane");
    expect(JSON.stringify(calls)).not.toMatch(/send-keys/);
  });

  it("fails clearly when native tmux is unavailable", () => {
    const spawnSync = vi.fn<SpawnSyncLike>(() => ({ status: 127 }));
    expect(() => launchCockpit({
      cliPath: "/absolute/cli.js",
      cwd,
      orchestratorSessionId,
      spawnSync,
    })).toThrow("Native tmux is required");
  });

  it("switches the current client when invoked inside tmux", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return args[0] === "-V" ? { status: 0, stdout: "tmux 3.5a\n" } : { status: 0 };
    });
    const preflight = preflightCockpit({ spawnSync, insideTmux: true });

    launchCockpit({ cliPath: "/absolute/cli.js", cwd, orchestratorSessionId, spawnSync, preflight });

    expect(preflight).toEqual({ tmuxVersion: "tmux 3.5a", presentationCommand: "switch-client" });
    expect(calls).toContainEqual({
      command: "tmux",
      args: [
        "split-window", "-h", "-t", target,
        process.execPath, "/absolute/cli.js", "attach", orchestratorSessionId,
        "--cockpit-return", "switch",
      ],
    });
    expect(calls.at(-1)).toEqual({ command: "tmux", args: ["switch-client", "-t", target] });
    expect(calls.some(({ args }) => args[0] === "attach-session")).toBe(false);
  });

  it("attaches a new client when invoked outside tmux", () => {
    const spawnSync = vi.fn<SpawnSyncLike>((_command, args) =>
      args[0] === "-V" ? { status: 0, stdout: "tmux 3.5a\n" } : { status: 0 });
    const preflight = preflightCockpit({ spawnSync, insideTmux: false });

    launchCockpit({ cliPath: "/absolute/cli.js", cwd, orchestratorSessionId, spawnSync, preflight });

    expect(preflight.presentationCommand).toBe("attach-session");
    expect(spawnSync).toHaveBeenLastCalledWith(
      "tmux",
      ["attach-session", "-t", target],
      { stdio: "inherit" },
    );
  });

  it("removes only a newly created cockpit when final presentation fails", () => {
    const calls: string[][] = [];
    const spawnSync = vi.fn<SpawnSyncLike>((_command, args) => {
      calls.push(args);
      if (args[0] === "has-session" || args[0] === "attach-session") return { status: 1 };
      return { status: 0 };
    });

    expect(() => launchCockpit({
      cliPath: "/absolute/cli.js",
      cwd,
      orchestratorSessionId,
      spawnSync,
      preflight: outsideTmux,
    })).toThrow("tmux failed to attach cyberdeck tmux session");
    expect(calls.at(-1)).toEqual(["kill-session", "-t", target]);
    expect(calls.flat()).not.toContain("kill-server");
  });

  it("preserves a pre-existing cockpit when final presentation fails", () => {
    const calls: string[][] = [];
    const spawnSync = vi.fn<SpawnSyncLike>((_command, args) => {
      calls.push(args);
      return { status: args[0] === "attach-session" ? 1 : 0 };
    });

    expect(() => launchCockpit({
      cliPath: "/absolute/cli.js",
      cwd,
      orchestratorSessionId,
      spawnSync,
      preflight: outsideTmux,
    })).toThrow("tmux failed to attach cyberdeck tmux session");
    expect(calls.some(([verb]) => verb === "kill-session")).toBe(false);
  });

  it("keeps presentation failure primary when cockpit rollback also fails", () => {
    const spawnSync = vi.fn<SpawnSyncLike>((_command, args) => {
      if (args[0] === "has-session" || args[0] === "attach-session" || args[0] === "kill-session") {
        return { status: 1 };
      }
      return { status: 0 };
    });

    expect(() => launchCockpit({
      cliPath: "/absolute/cli.js",
      cwd,
      orchestratorSessionId,
      spawnSync,
      preflight: outsideTmux,
    })).toThrow(
      "tmux failed to attach cyberdeck tmux session; cleanup also failed: tmux failed to remove the newly created cockpit session",
    );
  });
});

describe("detachCockpit", () => {
  it("switches a tmux client back to its previous Fleet session", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    });

    detachCockpit({ spawnSync, returnMode: "switch" });

    expect(calls).toEqual([
      { command: "tmux", args: ["switch-client", "-l"] },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/kill|terminate|stop|signal/);
  });

  it("detaches a client that entered the cockpit from outside tmux", () => {
    const calls: string[][] = [];
    const spawnSync = vi.fn<SpawnSyncLike>((_command, args) => {
      calls.push(args);
      return { status: args[0] === "switch-client" ? 1 : 0 };
    });

    detachCockpit({ spawnSync, returnMode: "detach" });

    expect(calls).toEqual([["detach-client"]]);
    expect(calls.flat()).not.toContain("kill-session");
  });

  it("treats a missing cockpit client as already detached rather than an error", () => {
    const spawnSync = vi.fn<SpawnSyncLike>(() => ({ status: 1 }));
    expect(() => detachCockpit({ spawnSync, returnMode: "switch" })).not.toThrow();
  });
});

describe("inspectCockpitPanes", () => {
  it("inspects pane metadata with a read-only tmux format query", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: "%0 0 node dashboard\n%1 1 zsh\n" };
    });

    const panes = inspectCockpitPanes({ spawnSync });

    expect(calls).toEqual([{
      command: "tmux",
      args: ["list-panes", "-t", "cyberdeck", "-F", "#{pane_id} #{pane_index} #{pane_current_command}"],
    }]);
    expect(panes).toEqual([
      { paneId: "%0", index: 0, command: "node dashboard" },
      { paneId: "%1", index: 1, command: "zsh" },
    ]);
  });

  it("returns no panes when the cockpit session does not exist", () => {
    const spawnSync = vi.fn<SpawnSyncLike>(() => ({ status: 1 }));
    expect(inspectCockpitPanes({ spawnSync })).toEqual([]);
  });
});

describe("launchCockpit inside the window Fleet already occupies", () => {
  const cwd = "/repo/one";
  const hostPane = "%3";
  const hostWindow = "@1";
  const orchestratorSessionId = "11111111-1111-4111-8111-111111111111";
  const otherSessionId = "22222222-2222-4222-8222-222222222222";
  const insideTmux = {
    tmuxVersion: "tmux 3.5a",
    presentationCommand: "switch-client" as const,
    hostPaneId: hostPane,
  };
  const paneFormat = "#{pane_id}\t#{pane_dead}\t#{pane_start_command}";

  function tmuxWith(panesByWindow: Record<string, string>, windowStatus = 0) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      if (args[0] === "display-message") {
        return windowStatus === 0 ? { status: 0, stdout: `${hostWindow}\n` } : { status: windowStatus };
      }
      if (args[0] === "list-panes") {
        return { status: 0, stdout: panesByWindow[args[args.indexOf("-t") + 1] ?? ""] ?? "" };
      }
      return { status: 0 };
    });
    return { calls, spawnSync };
  }

  function present(spawnSync: SpawnSyncLike): void {
    launchCockpit({
      cliPath: "/absolute/cli.js",
      nodePath: "/absolute/node",
      cwd,
      orchestratorSessionId,
      spawnSync,
      preflight: insideTmux,
    });
  }

  it("splits Fleet's own pane instead of switching to a session named after a cwd", () => {
    const { calls, spawnSync } = tmuxWith({
      [hostWindow]: [
        `${hostPane}\t0\t/absolute/node /absolute/cli.js`,
        `%4\t0\t/absolute/node /absolute/cli.js attach ${otherSessionId}`,
      ].join("\n"),
    });

    present(spawnSync);

    expect(calls).toEqual([
      { command: "tmux", args: ["display-message", "-p", "-t", hostPane, "#{window_id}"] },
      { command: "tmux", args: ["list-panes", "-t", hostWindow, "-F", paneFormat] },
      {
        command: "tmux",
        args: [
          "split-window", "-h", "-t", hostPane,
          "/absolute/node", "/absolute/cli.js", "attach", orchestratorSessionId,
        ],
      },
    ]);
    const flattened = calls.flatMap(({ args }) => args);
    expect(flattened).not.toContain(cockpitSessionName(cwd));
    // The client belongs to the operator, so an explicit detach must not move or end it.
    expect(flattened).not.toContain("--cockpit-return");
  });

  it("adds exactly one pane and emits no session, window, or terminating verb", () => {
    const { calls, spawnSync } = tmuxWith({
      [hostWindow]: [
        `%1\t0\tvim`,
        `${hostPane}\t0\t/absolute/node /absolute/cli.js`,
        `%4\t0\t/absolute/node /absolute/cli.js attach ${otherSessionId}`,
      ].join("\n"),
    });

    present(spawnSync);

    const verbs = calls.map(({ args }) => args[0]);
    expect(verbs.filter((verb) => verb === "split-window")).toHaveLength(1);
    for (const forbidden of [
      "has-session", "new-session", "new-window", "switch-client", "attach-session",
      "kill-session", "kill-pane", "kill-window", "kill-server", "respawn-pane", "select-layout",
    ]) {
      expect(verbs).not.toContain(forbidden);
    }
    expect(JSON.stringify(calls)).not.toMatch(/send-keys/);
  });

  it("focuses a live pane that already carries this orchestrator", () => {
    const { calls, spawnSync } = tmuxWith({
      [hostWindow]: [
        `${hostPane}\t0\t/absolute/node /absolute/cli.js`,
        `%9\t0\t/absolute/node /absolute/cli.js attach ${orchestratorSessionId}`,
      ].join("\n"),
    });

    present(spawnSync);

    expect(calls.at(-1)).toEqual({ command: "tmux", args: ["select-pane", "-t", "%9"] });
    expect(calls.map(({ args }) => args[0])).not.toContain("split-window");
  });

  it("refuses a dead pane still advertising this orchestrator", () => {
    const { calls, spawnSync } = tmuxWith({
      [hostWindow]: [
        `${hostPane}\t0\t/absolute/node /absolute/cli.js`,
        `%9\t1\t/absolute/node /absolute/cli.js attach ${orchestratorSessionId}`,
      ].join("\n"),
    });

    present(spawnSync);

    const verbs = calls.map(({ args }) => args[0]);
    expect(verbs).toContain("split-window");
    expect(verbs).not.toContain("select-pane");
  });

  it("refuses a matching pane that lives in another window", () => {
    const { calls, spawnSync } = tmuxWith({
      [hostWindow]: `${hostPane}\t0\t/absolute/node /absolute/cli.js`,
      "@2": `%9\t0\t/absolute/node /absolute/cli.js attach ${orchestratorSessionId}`,
    });

    present(spawnSync);

    expect(calls.filter(({ args }) => args[0] === "list-panes")).toEqual([
      { command: "tmux", args: ["list-panes", "-t", hostWindow, "-F", paneFormat] },
    ]);
    const verbs = calls.map(({ args }) => args[0]);
    expect(verbs).toContain("split-window");
    expect(verbs).not.toContain("select-pane");
  });

  it("leaves the client alone when tmux cannot name the window Fleet is in", () => {
    const { calls, spawnSync } = tmuxWith({ [hostWindow]: "" }, 1);

    expect(() => present(spawnSync)).toThrow("tmux failed to locate the window Fleet is running in");
    const verbs = calls.map(({ args }) => args[0]);
    for (const forbidden of ["switch-client", "attach-session", "split-window", "kill-session"]) {
      expect(verbs).not.toContain(forbidden);
    }
  });
});

describe("preflightCockpit host pane discovery", () => {
  it("carries the caller's pane so presentation happens in place", () => {
    const spawnSync = vi.fn<SpawnSyncLike>(() => ({ status: 0, stdout: "tmux 3.5a\n" }));
    expect(preflightCockpit({ spawnSync, insideTmux: true, hostPaneId: "%4" })).toEqual({
      tmuxVersion: "tmux 3.5a",
      presentationCommand: "switch-client",
      hostPaneId: "%4",
    });
  });

  it("asks tmux for the pane when the caller does not name one", () => {
    const spawnSync = vi.fn<SpawnSyncLike>((_command, args) =>
      args[0] === "-V" ? { status: 0, stdout: "tmux 3.5a\n" } : { status: 0, stdout: "%5\n" });
    expect(preflightCockpit({ spawnSync, insideTmux: true }).hostPaneId).toBe("%5");
  });

  it("ignores an answer that does not name a pane", () => {
    const spawnSync = vi.fn<SpawnSyncLike>((_command, args) =>
      args[0] === "-V" ? { status: 0, stdout: "tmux 3.5a\n" } : { status: 0, stdout: "no such pane\n" });
    expect(preflightCockpit({ spawnSync, insideTmux: true }).hostPaneId).toBeUndefined();
  });

  it("keeps the managed cockpit session for a client outside tmux", () => {
    const spawnSync = vi.fn<SpawnSyncLike>(() => ({ status: 0, stdout: "tmux 3.5a\n" }));
    expect(preflightCockpit({ spawnSync, insideTmux: false })).toEqual({
      tmuxVersion: "tmux 3.5a",
      presentationCommand: "attach-session",
    });
  });
});
