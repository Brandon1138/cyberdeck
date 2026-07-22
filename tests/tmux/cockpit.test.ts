import { describe, expect, it, vi } from "vitest";
import {
  detachCockpit,
  cockpitSessionName,
  inspectCockpitPanes,
  launchCockpit,
  type SpawnSyncLike,
} from "../../src/tmux/cockpit.js";

describe("launchCockpit", () => {
  const cwd = "/repo/one";
  const target = cockpitSessionName(cwd);
  const orchestratorSessionId = "11111111-1111-4111-8111-111111111111";

  it("creates a dashboard pane and attaches the broker-owned orchestrator in the right pane", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return args[0] === "-V"
        ? { status: 0, stdout: "tmux 3.5a" }
        : { status: args[0] === "has-session" ? 1 : 0 };
    });
    launchCockpit({
      cliPath: "/absolute/dist/src/cli.js",
      nodePath: "/absolute/node",
      cwd,
      orchestratorSessionId,
      spawnSync,
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
      ],
    });
    expect(calls.at(-1)).toEqual({
      command: "tmux",
      args: ["attach-session", "-t", target],
    });
    expect(JSON.stringify(calls)).not.toMatch(/send-keys/);
  });

  it("reuses an existing cyberdeck tmux session", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    });
    launchCockpit({ cliPath: "/absolute/cli.js", nodePath: "/absolute/node", cwd, orchestratorSessionId, spawnSync });
    expect(calls).toEqual([
      { command: "tmux", args: ["-V"] },
      { command: "tmux", args: ["has-session", "-t", target] },
      { command: "tmux", args: ["attach-session", "-t", target] },
    ]);
  });

  it("never issues a tmux verb that would terminate a session, pane, or server", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return { status: args[0] === "has-session" ? 1 : 0 };
    });
    launchCockpit({ cliPath: "/absolute/cli.js", nodePath: "/absolute/node", cwd, orchestratorSessionId, spawnSync });

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
});

describe("detachCockpit", () => {
  it("detaches presentation only and never kills the broker-owned session", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    });

    detachCockpit({ spawnSync });

    expect(calls).toEqual([
      { command: "tmux", args: ["detach-client", "-s", "cyberdeck"] },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/kill|terminate|stop|signal/);
  });

  it("treats a missing cockpit session as already detached rather than an error", () => {
    const spawnSync = vi.fn<SpawnSyncLike>(() => ({ status: 1 }));
    expect(() => detachCockpit({ spawnSync })).not.toThrow();
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
