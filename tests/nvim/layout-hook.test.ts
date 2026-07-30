import { describe, expect, it, vi } from "vitest";
import type { SpawnSyncLike } from "../../src/tmux/cockpit.js";
import {
  createFleetNvimLayoutHooks,
  FLEET_COMMAND_WINDOW_OPTION,
  FLEET_PANE_WINDOW_OPTION,
  rebalanceNvimLayoutFromHook,
} from "../../src/nvim/layout-hook.js";

function layoutTmux(calls: string[][]): SpawnSyncLike {
  return vi.fn<SpawnSyncLike>((_command, args) => {
    calls.push(args);
    if (args[0] === "display-message" && args.at(-1) === "#{window_id}") {
      return { status: 0, stdout: "@4\n" };
    }
    if (args[0] === "display-message" && args.at(-1) === "#{pane_current_command}") {
      return { status: 0, stdout: "node\n" };
    }
    if (args[0] === "display-message") return { status: 0, stdout: "235\t40\t0\n" };
    if (args[0] === "list-panes") {
      return {
        status: 0,
        stdout: [
          "%1\t0\t0\t0\t40\t117\tnode\t/opt/cyberdeck",
          "%3\t0\t118\t0\t40\t117\tnvim\tnvim",
        ].join("\n"),
      };
    }
    return { status: 0 };
  });
}

describe("Fleet nvim layout hook", () => {
  it("installs exact window-scoped pane-exited hook and records Fleet pane identity", () => {
    const calls: string[][] = [];
    const hooks = createFleetNvimLayoutHooks({
      spawnSync: layoutTmux(calls),
      preflight: () => ({
        tmuxVersion: "tmux 3.6a",
        presentationCommand: "switch-client",
        hostPaneId: "%1",
      }),
      cliPath: "/opt/cyberdeck",
    });

    hooks.install([]);

    expect(calls).toContainEqual([
      "set-option", "-w", "-t", "@4", FLEET_PANE_WINDOW_OPTION, "%1",
    ]);
    expect(calls).toContainEqual([
      "set-option", "-w", "-t", "@4", FLEET_COMMAND_WINDOW_OPTION, "node",
    ]);
    expect(calls).toContainEqual([
      "set-hook",
      "-w",
      "-t",
      "@4",
      "pane-exited",
      'run-shell -b "/opt/cyberdeck nvim-layout rebalance -w @4"',
    ]);
    expect(calls).toContainEqual([
      "set-hook",
      "-w",
      "-t",
      "@4",
      "after-kill-pane",
      'run-shell -b "/opt/cyberdeck nvim-layout rebalance -w @4"',
    ]);
  });

  it("removes the window hook and Fleet pane option", () => {
    const calls: string[][] = [];
    const hooks = createFleetNvimLayoutHooks({
      spawnSync: layoutTmux(calls),
      preflight: () => ({
        tmuxVersion: "tmux 3.6a",
        presentationCommand: "switch-client",
        hostPaneId: "%1",
      }),
      cliPath: "/opt/cyberdeck",
    });

    hooks.remove();

    expect(calls).toContainEqual([
      "set-hook", "-u", "-w", "-t", "@4", "pane-exited",
    ]);
    expect(calls).toContainEqual([
      "set-hook", "-u", "-w", "-t", "@4", "after-kill-pane",
    ]);
    expect(calls).toContainEqual([
      "set-option", "-u", "-w", "-t", "@4", FLEET_PANE_WINDOW_OPTION,
    ]);
    expect(calls).toContainEqual([
      "set-option", "-u", "-w", "-t", "@4", FLEET_COMMAND_WINDOW_OPTION,
    ]);
  });

  it("does nothing quietly after the hooked window becomes stale", () => {
    const spawnSync = vi.fn<SpawnSyncLike>(() => ({ status: 1, stdout: "missing window" }));

    expect(rebalanceNvimLayoutFromHook({
      spawnSync,
      windowId: "@404",
      cliPath: "/opt/cyberdeck",
    })).toBeUndefined();
    expect(spawnSync.mock.calls.some(([, args]) => args[0] === "resize-pane")).toBe(false);
  });

  it("does nothing quietly when the surviving window has an unrecognized pane", () => {
    const spawnSync = vi.fn<SpawnSyncLike>((_command, args) => {
      if (args[0] === "show-options") {
        return {
          status: 0,
          stdout: args.at(-1) === FLEET_PANE_WINDOW_OPTION ? "%1\n" : "node\n",
        };
      }
      if (args[0] === "display-message") return { status: 0, stdout: "235\t40\t0\n" };
      if (args[0] === "list-panes") {
        return {
          status: 0,
          stdout: [
            "%1\t0\t0\t0\t40\t117\tnode\t/opt/cyberdeck",
            "%9\t0\t118\t0\t40\t117\tzsh\tzsh",
          ].join("\n"),
        };
      }
      return { status: 0 };
    });

    expect(rebalanceNvimLayoutFromHook({
      spawnSync,
      windowId: "@4",
      cliPath: "/opt/cyberdeck",
    })).toBeUndefined();
    expect(spawnSync.mock.calls.some(([, args]) => args[0] === "resize-pane")).toBe(false);
  });

  it("does nothing quietly when SIGKILL returns Fleet's saved pane to its shell", () => {
    const spawnSync = vi.fn<SpawnSyncLike>((_command, args) => {
      if (args[0] === "show-options") {
        return {
          status: 0,
          stdout: args.at(-1) === FLEET_PANE_WINDOW_OPTION ? "%1\n" : "node\n",
        };
      }
      if (args[0] === "display-message") return { status: 0, stdout: "235\t40\t0\n" };
      if (args[0] === "list-panes") {
        return {
          status: 0,
          stdout: [
            "%1\t0\t0\t0\t40\t117\tzsh\tzsh",
            "%3\t0\t118\t0\t40\t117\tnvim\tnvim",
          ].join("\n"),
        };
      }
      return { status: 0 };
    });

    expect(rebalanceNvimLayoutFromHook({
      spawnSync,
      windowId: "@4",
      cliPath: "/opt/cyberdeck",
    })).toBeUndefined();
    expect(spawnSync.mock.calls.some(([, args]) => args[0] === "resize-pane")).toBe(false);
  });

  it("uses the bounded attach predicate when the pane-exit process has no Orc session id", () => {
    const spawnSync = vi.fn<SpawnSyncLike>((_command, args) => {
      if (args[0] === "show-options") {
        return {
          status: 0,
          stdout: args.at(-1) === FLEET_PANE_WINDOW_OPTION ? "%1\n" : "node\n",
        };
      }
      if (args[0] === "display-message") return { status: 0, stdout: "235\t40\t0\n" };
      if (args[0] === "list-panes") {
        return {
          status: 0,
          stdout: [
            "%1\t0\t0\t0\t40\t64\tnode\t/opt/cyberdeck",
            "%2\t0\t65\t0\t40\t52\tnode\t/opt/cyberdeck attach 11111111-1111-4111-8111-111111111111",
            "%3\t0\t118\t0\t40\t117\tnvim\tnvim",
          ].join("\n"),
        };
      }
      return { status: 0 };
    });

    expect(rebalanceNvimLayoutFromHook({
      spawnSync,
      windowId: "@4",
      cliPath: "/opt/cyberdeck",
    })?.state).toBe("fleet-orc-nvim");
    expect(spawnSync.mock.calls.filter(([, args]) => args[0] === "resize-pane")
      .map(([, args]) => args)).toEqual([
        ["resize-pane", "-t", "%1", "-x", "64"],
        ["resize-pane", "-t", "%2", "-x", "52"],
      ]);
  });
});
