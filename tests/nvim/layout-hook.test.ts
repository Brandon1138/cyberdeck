import { describe, expect, it, vi } from "vitest";
import type { SpawnSyncLike } from "../../src/tmux/cockpit.js";
import {
  createFleetNvimLayoutHooks,
  FLEET_PANE_WINDOW_OPTION,
  FLEET_PROCESS_WINDOW_OPTION,
  rebalanceNvimLayoutFromHook,
} from "../../src/nvim/layout-hook.js";

const FLEET_PID = 4_321;
const FLEET_FINGERPRINT =
  "Thu Jul 30 20:00:00 2026 /usr/bin/node /pnpm/global/cyberdeck/dist/src/cli.js";
const FLEET_IDENTITY = JSON.stringify({
  pid: FLEET_PID,
  cliPath: "/opt/cyberdeck",
  fingerprint: FLEET_FINGERPRINT,
});

function layoutTmux(calls: string[][]): SpawnSyncLike {
  return vi.fn<SpawnSyncLike>((command, args) => {
    calls.push(args);
    if (command === "ps") return { status: 0, stdout: `${FLEET_FINGERPRINT}\n` };
    if (args[0] === "display-message" && args.at(-1) === "#{window_id}") {
      return { status: 0, stdout: "@4\n" };
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
  it("records Fleet identity when ps and the hook spell the symlinked CLI differently", () => {
    const calls: string[][] = [];
    const hooks = createFleetNvimLayoutHooks({
      spawnSync: layoutTmux(calls),
      preflight: () => ({
        tmuxVersion: "tmux 3.6a",
        presentationCommand: "switch-client",
        hostPaneId: "%1",
      }),
      nodePath: "/usr/bin/node",
      cliPath: "/opt/cyberdeck",
      hookPath: "/opt/homebrew/bin:/usr/bin:/bin",
      fleetPid: FLEET_PID,
    });

    hooks.install([]);

    expect(calls).toContainEqual([
      "-ww", "-p", String(FLEET_PID), "-o", "lstart=", "-o", "command=",
    ]);
    expect(calls).toContainEqual([
      "set-option", "-w", "-t", "@4", FLEET_PANE_WINDOW_OPTION, "%1",
    ]);
    expect(calls).toContainEqual([
      "set-option", "-w", "-t", "@4", FLEET_PROCESS_WINDOW_OPTION, FLEET_IDENTITY,
    ]);
    expect(calls).toContainEqual([
      "set-hook",
      "-w",
      "-t",
      "@4",
      "pane-exited",
      'run-shell -b "/usr/bin/env \'PATH=/opt/homebrew/bin:/usr/bin:/bin\' /usr/bin/node /opt/cyberdeck nvim-layout rebalance -w @4"',
    ]);
    expect(calls).toContainEqual([
      "set-hook",
      "-w",
      "-t",
      "@4",
      "after-kill-pane",
      'run-shell -b "/usr/bin/env \'PATH=/opt/homebrew/bin:/usr/bin:/bin\' /usr/bin/node /opt/cyberdeck nvim-layout rebalance -w @4"',
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
      fleetPid: FLEET_PID,
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
      "set-option", "-u", "-w", "-t", "@4", FLEET_PROCESS_WINDOW_OPTION,
    ]);
  });

  it("attempts every hook and option cleanup before reporting failures", () => {
    const calls: string[][] = [];
    const spawnSync: SpawnSyncLike = (_command, args) => {
      calls.push(args);
      if (args[0] === "display-message") return { status: 0, stdout: "@4\n" };
      if (args.includes("pane-exited") || args.includes(FLEET_PROCESS_WINDOW_OPTION)) {
        return { status: 1 };
      }
      return { status: 0 };
    };
    const hooks = createFleetNvimLayoutHooks({
      spawnSync,
      preflight: () => ({
        tmuxVersion: "tmux 3.6a",
        presentationCommand: "switch-client",
        hostPaneId: "%1",
      }),
      cliPath: "/opt/cyberdeck",
      fleetPid: FLEET_PID,
    });

    expect(() => hooks.remove()).toThrow(
      "tmux failed to clean up nvim layout: pane-exited hook, Fleet process option",
    );
    expect(calls.slice(-4)).toEqual([
      ["set-hook", "-u", "-w", "-t", "@4", "pane-exited"],
      ["set-hook", "-u", "-w", "-t", "@4", "after-kill-pane"],
      ["set-option", "-u", "-w", "-t", "@4", FLEET_PANE_WINDOW_OPTION],
      ["set-option", "-u", "-w", "-t", "@4", FLEET_PROCESS_WINDOW_OPTION],
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
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      if (command === "ps") return { status: 0, stdout: `${FLEET_FINGERPRINT}\n` };
      if (args[0] === "show-options") {
        return {
          status: 0,
          stdout: args.at(-1) === FLEET_PANE_WINDOW_OPTION ? "%1\n" : `${FLEET_IDENTITY}\n`,
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

  it("does nothing when the same pane and node command belong to a replacement process", () => {
    const replacementFingerprint =
      "Thu Jul 30 21:00:00 2026 /usr/bin/node /tmp/unrelated-service.js";
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      if (command === "ps") return { status: 0, stdout: `${replacementFingerprint}\n` };
      if (args[0] === "show-options") {
        return {
          status: 0,
          stdout: args.at(-1) === FLEET_PANE_WINDOW_OPTION ? "%1\n" : `${FLEET_IDENTITY}\n`,
        };
      }
      if (args[0] === "display-message") return { status: 0, stdout: "235\t40\t0\n" };
      if (args[0] === "list-panes") {
        return {
          status: 0,
          stdout: [
            "%1\t0\t0\t0\t40\t117\tnode\t/tmp/unrelated-service.js",
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
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      if (command === "ps") return { status: 0, stdout: `${FLEET_FINGERPRINT}\n` };
      if (args[0] === "show-options") {
        return {
          status: 0,
          stdout: args.at(-1) === FLEET_PANE_WINDOW_OPTION ? "%1\n" : `${FLEET_IDENTITY}\n`,
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

  it("restores Fleet PATH and resizes the exact two-pane state seen during pane-exited", () => {
    const installCalls: string[][] = [];
    const hooks = createFleetNvimLayoutHooks({
      spawnSync: layoutTmux(installCalls),
      preflight: () => ({
        tmuxVersion: "tmux 3.6a",
        presentationCommand: "switch-client",
        hostPaneId: "%0",
      }),
      nodePath: "/usr/bin/node",
      cliPath: "/opt/cyberdeck",
      hookPath: "/opt/homebrew/bin:/usr/bin:/bin",
      fleetPid: FLEET_PID,
    });
    hooks.install([]);
    expect(installCalls).toContainEqual([
      "set-hook",
      "-w",
      "-t",
      "@4",
      "pane-exited",
      'run-shell -b "/usr/bin/env \'PATH=/opt/homebrew/bin:/usr/bin:/bin\' /usr/bin/node /opt/cyberdeck nvim-layout rebalance -w @4"',
    ]);

    const calls: string[][] = [];
    const spawnSync = vi.fn<SpawnSyncLike>((command, args) => {
      calls.push(args);
      if (command === "ps") return { status: 0, stdout: `${FLEET_FINGERPRINT}\n` };
      if (args[0] === "show-options") {
        return {
          status: 0,
          stdout: args.at(-1) === FLEET_PANE_WINDOW_OPTION
            ? "%0\n"
            : `${FLEET_IDENTITY}\n`,
        };
      }
      if (args[0] === "display-message") return { status: 0, stdout: "235\t53\t0\n" };
      if (args[0] === "list-panes") {
        return {
          status: 0,
          stdout: [
            "%0\t0\t0\t0\t53\t78\tnode\t/opt/cyberdeck",
            "%12\t0\t79\t0\t53\t156\tnode\t/opt/cyberdeck attach 11111111-1111-4111-8111-111111111111",
          ].join("\n"),
        };
      }
      return { status: 0 };
    });

    expect(rebalanceNvimLayoutFromHook({
      spawnSync,
      windowId: "@0",
      cliPath: "/opt/cyberdeck",
    })?.state).toBe("fleet-orc");
    expect(calls.filter(([verb]) => verb === "resize-pane")).toEqual([
      ["resize-pane", "-t", "%0", "-x", "117"],
    ]);
  });
});
