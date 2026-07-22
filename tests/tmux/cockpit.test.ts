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
      { command: "tmux", args: ["attach-session", "-t", target] },
    ]);
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
