import {
  hostWindowId,
  type CockpitPreflight,
  type SpawnSyncLike,
} from "../tmux/cockpit.js";
import { NVIM_LAYOUT_PANE_FORMAT } from "./pane.js";
import { rebalanceNvimWindow, type WindowLayoutPlan } from "./window-layout.js";

export const FLEET_PANE_WINDOW_OPTION = "@cyberdeck_fleet_pane";
export const FLEET_COMMAND_WINDOW_OPTION = "@cyberdeck_fleet_command";
const LAYOUT_HOOKS = ["pane-exited", "after-kill-pane"] as const;

export interface FleetNvimLayoutHookOptions {
  spawnSync: SpawnSyncLike;
  preflight: () => CockpitPreflight;
  cliPath: string;
}

export interface FleetNvimLayoutHooks {
  install(orchestratorSessionIds: readonly string[]): void;
  rebalance(orchestratorSessionIds: readonly string[]): WindowLayoutPlan | undefined;
  remove(): void;
}

/**
 * Own one hook for the window Fleet itself occupies.
 *
 * Window options carry Fleet's preflight-proven pane id and foreground command into the later
 * `pane-exited` subprocess. Passing only the window id to the CLI keeps the hook stable across every
 * other pane exiting, while both stored values make a SIGKILL-left stale hook inert after Fleet's
 * pane disappears or falls back to its shell.
 *
 * This belongs in tmux, not nvim or Fleet's redraw loop. `VimLeavePre` misses `kill-pane`, and the
 * nvim module is deliberately inert outside an explicit RPC. Redraw-time geometry polling would
 * continuously override manual sizing even when Ctrl+N did not ask for it. A spawned-nvim wrapper
 * misses a pre-existing discovered nvim and never gets control after `kill-pane`.
 * `window-layout-changed` is also wrong here: every `resize-pane` would trigger the same hook again.
 *
 * tmux 3.6a emits `pane-exited` for nvim's own `:qa`, but neither `pane-exited` nor `pane-died` for
 * an external `kill-pane`. The window-scoped `after-kill-pane` companion covers that command path;
 * it is not a geometry hook, so the resizes below cannot loop back into it.
 */
export function createFleetNvimLayoutHooks(
  options: FleetNvimLayoutHookOptions,
): FleetNvimLayoutHooks {
  const target = (): { hostPaneId: string; windowId: string } => {
    const hostPaneId = options.preflight().hostPaneId;
    if (hostPaneId === undefined) {
      throw Object.assign(
        new Error("Fleet is not running in a tmux pane, so nvim layout cannot be enabled"),
        { code: "TMUX_PANE_UNKNOWN" },
      );
    }
    return {
      hostPaneId,
      windowId: hostWindowId(options.spawnSync, hostPaneId),
    };
  };

  return {
    install(orchestratorSessionIds) {
      const { hostPaneId, windowId } = target();
      const hostCommandResult = options.spawnSync(
        "tmux",
        ["display-message", "-p", "-t", hostPaneId, "#{pane_current_command}"],
        { encoding: "utf8" },
      );
      const hostCommand = (hostCommandResult.stdout ?? "").trim();
      if (hostCommandResult.status !== 0 || hostCommand === "") {
        throw new Error("tmux failed to identify Fleet's pane command for nvim layout");
      }
      requireSuccess(
        options.spawnSync(
          "tmux",
          ["set-option", "-w", "-t", windowId, FLEET_PANE_WINDOW_OPTION, hostPaneId],
          { stdio: "ignore" },
        ),
        "record Fleet's pane for nvim layout",
      );
      const commandRecorded = options.spawnSync(
        "tmux",
        ["set-option", "-w", "-t", windowId, FLEET_COMMAND_WINDOW_OPTION, hostCommand],
        { stdio: "ignore" },
      );
      if (commandRecorded.status !== 0) {
        options.spawnSync(
          "tmux",
          ["set-option", "-u", "-w", "-t", windowId, FLEET_PANE_WINDOW_OPTION],
          { stdio: "ignore" },
        );
        throw new Error("tmux failed to record Fleet's pane command for nvim layout");
      }
      const shellCommand = [
        shellQuote(options.cliPath),
        "nvim-layout",
        "rebalance",
        "-w",
        shellQuote(windowId),
      ].join(" ");
      const hook = `run-shell -b "${tmuxDoubleQuote(shellCommand)}"`;
      const installedHooks: string[] = [];
      for (const hookName of LAYOUT_HOOKS) {
        const installed = options.spawnSync(
          "tmux",
          ["set-hook", "-w", "-t", windowId, hookName, hook],
          { stdio: "ignore" },
        );
        if (installed.status === 0) {
          installedHooks.push(hookName);
          continue;
        }
        for (const installedHook of installedHooks) {
          options.spawnSync(
            "tmux",
            ["set-hook", "-u", "-w", "-t", windowId, installedHook],
            { stdio: "ignore" },
          );
        }
        options.spawnSync(
          "tmux",
          ["set-option", "-u", "-w", "-t", windowId, FLEET_PANE_WINDOW_OPTION],
          { stdio: "ignore" },
        );
        options.spawnSync(
          "tmux",
          ["set-option", "-u", "-w", "-t", windowId, FLEET_COMMAND_WINDOW_OPTION],
          { stdio: "ignore" },
        );
        throw new Error(`tmux failed to install the nvim layout ${hookName} hook`);
      }
      try {
        rebalanceNvimWindow({
          spawnSync: options.spawnSync,
          windowId,
          paneFormat: NVIM_LAYOUT_PANE_FORMAT,
          hostPaneId,
          orchestratorSessionIds,
        });
      } catch (error) {
        for (const hookName of LAYOUT_HOOKS) {
          options.spawnSync(
            "tmux",
            ["set-hook", "-u", "-w", "-t", windowId, hookName],
            { stdio: "ignore" },
          );
        }
        options.spawnSync(
          "tmux",
          ["set-option", "-u", "-w", "-t", windowId, FLEET_PANE_WINDOW_OPTION],
          { stdio: "ignore" },
        );
        options.spawnSync(
          "tmux",
          ["set-option", "-u", "-w", "-t", windowId, FLEET_COMMAND_WINDOW_OPTION],
          { stdio: "ignore" },
        );
        throw error;
      }
    },

    rebalance(orchestratorSessionIds) {
      const { hostPaneId, windowId } = target();
      return rebalanceNvimWindow({
        spawnSync: options.spawnSync,
        windowId,
        paneFormat: NVIM_LAYOUT_PANE_FORMAT,
        hostPaneId,
        orchestratorSessionIds,
      });
    },

    remove() {
      const { windowId } = target();
      for (const hookName of LAYOUT_HOOKS) {
        requireSuccess(
          options.spawnSync(
            "tmux",
            ["set-hook", "-u", "-w", "-t", windowId, hookName],
            { stdio: "ignore" },
          ),
          `remove the nvim layout ${hookName} hook`,
        );
      }
      requireSuccess(
        options.spawnSync(
          "tmux",
          ["set-option", "-u", "-w", "-t", windowId, FLEET_PANE_WINDOW_OPTION],
          { stdio: "ignore" },
        ),
        "forget Fleet's pane for nvim layout",
      );
      requireSuccess(
        options.spawnSync(
          "tmux",
          ["set-option", "-u", "-w", "-t", windowId, FLEET_COMMAND_WINDOW_OPTION],
          { stdio: "ignore" },
        ),
        "forget Fleet's pane command for nvim layout",
      );
    },
  };
}

/**
 * Pane-exit subprocess entry point. Every failure is a quiet no-op.
 *
 * A window may disappear, Fleet may have exited, the stored pane may be gone, or an unrelated pane
 * may now occupy the window. None is actionable from a background tmux hook, and the strict planner
 * still has to recognize the complete remaining row before any resize command is emitted.
 */
export function rebalanceNvimLayoutFromHook(options: {
  spawnSync: SpawnSyncLike;
  windowId: string;
  cliPath: string;
}): WindowLayoutPlan | undefined {
  const fleetPane = options.spawnSync(
    "tmux",
    [
      "show-options",
      "-w",
      "-v",
      "-t",
      options.windowId,
      FLEET_PANE_WINDOW_OPTION,
    ],
    { encoding: "utf8" },
  );
  if (fleetPane.status !== 0) return undefined;
  const hostPaneId = (fleetPane.stdout ?? "").trim();
  if (!/^%\d+$/u.test(hostPaneId)) return undefined;
  const fleetCommand = options.spawnSync(
    "tmux",
    [
      "show-options",
      "-w",
      "-v",
      "-t",
      options.windowId,
      FLEET_COMMAND_WINDOW_OPTION,
    ],
    { encoding: "utf8" },
  );
  if (fleetCommand.status !== 0) return undefined;
  const expectedHostCommand = (fleetCommand.stdout ?? "").trim();
  if (expectedHostCommand === "") return undefined;
  return rebalanceNvimWindow({
    spawnSync: options.spawnSync,
    windowId: options.windowId,
    paneFormat: NVIM_LAYOUT_PANE_FORMAT,
    hostPaneId,
    expectedHostCommand,
    cliPath: options.cliPath,
    quiet: true,
  });
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function tmuxDoubleQuote(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$");
}

function requireSuccess(result: { status: number | null }, action: string): void {
  if (result.status !== 0) throw new Error(`tmux failed to ${action}`);
}
