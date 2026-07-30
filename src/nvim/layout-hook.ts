import {
  hostWindowId,
  type CockpitPreflight,
  type SpawnSyncLike,
} from "../tmux/cockpit.js";
import { NVIM_LAYOUT_PANE_FORMAT } from "./pane.js";
import { rebalanceNvimWindow, type WindowLayoutPlan } from "./window-layout.js";

export const FLEET_PANE_WINDOW_OPTION = "@cyberdeck_fleet_pane";
export const FLEET_PROCESS_WINDOW_OPTION = "@cyberdeck_fleet_process";
const LAYOUT_HOOKS = ["pane-exited", "after-kill-pane"] as const;

export interface FleetNvimLayoutHookOptions {
  spawnSync: SpawnSyncLike;
  preflight: () => CockpitPreflight;
  cliPath: string;
  fleetPid?: number | undefined;
}

export interface FleetNvimLayoutHooks {
  install(orchestratorSessionIds: readonly string[]): void;
  rebalance(orchestratorSessionIds: readonly string[]): WindowLayoutPlan | undefined;
  remove(): void;
}

/**
 * Own one hook for the window Fleet itself occupies.
 *
 * Window options carry Fleet's preflight-proven pane id and an exact process fingerprint into the
 * later `pane-exited` subprocess. The fingerprint binds PID, process start time, full command, and
 * this CLI path. A replacement `node` in the same pane therefore cannot reactivate a stale hook,
 * even after PID reuse. `pane_current_command` was rejected because it says only `node`, which is
 * shared by unrelated programs and survives none of the identity questions the hook must answer.
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
      const fleetPid = options.fleetPid ?? process.pid;
      const processIdentity = captureFleetProcessIdentity(
        options.spawnSync,
        fleetPid,
        options.cliPath,
      );
      requireSuccess(
        options.spawnSync(
          "tmux",
          ["set-option", "-w", "-t", windowId, FLEET_PANE_WINDOW_OPTION, hostPaneId],
          { stdio: "ignore" },
        ),
        "record Fleet's pane for nvim layout",
      );
      const processRecorded = options.spawnSync(
        "tmux",
        [
          "set-option",
          "-w",
          "-t",
          windowId,
          FLEET_PROCESS_WINDOW_OPTION,
          JSON.stringify(processIdentity),
        ],
        { stdio: "ignore" },
      );
      if (processRecorded.status !== 0) {
        options.spawnSync(
          "tmux",
          ["set-option", "-u", "-w", "-t", windowId, FLEET_PANE_WINDOW_OPTION],
          { stdio: "ignore" },
        );
        throw new Error("tmux failed to record Fleet's process identity for nvim layout");
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
        clearLayoutState(options.spawnSync, windowId, installedHooks);
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
        clearLayoutState(options.spawnSync, windowId);
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
      const failures = clearLayoutState(options.spawnSync, windowId);
      if (failures.length > 0) {
        throw new Error(`tmux failed to clean up nvim layout: ${failures.join(", ")}`);
      }
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
  const fleetProcess = options.spawnSync(
    "tmux",
    [
      "show-options",
      "-w",
      "-v",
      "-t",
      options.windowId,
      FLEET_PROCESS_WINDOW_OPTION,
    ],
    { encoding: "utf8" },
  );
  if (fleetProcess.status !== 0) return undefined;
  const identity = parseFleetProcessIdentity((fleetProcess.stdout ?? "").trim());
  if (
    identity === undefined
    || identity.cliPath !== options.cliPath
    || captureProcessFingerprint(options.spawnSync, identity.pid) !== identity.fingerprint
  ) return undefined;
  return rebalanceNvimWindow({
    spawnSync: options.spawnSync,
    windowId: options.windowId,
    paneFormat: NVIM_LAYOUT_PANE_FORMAT,
    hostPaneId,
    cliPath: options.cliPath,
    quiet: true,
  });
}

interface FleetProcessIdentity {
  pid: number;
  cliPath: string;
  fingerprint: string;
}

/**
 * PID alone can be reused, and command name alone collapses every Node program to `node`.
 *
 * macOS `ps` supplies immutable process start time plus full argv for one live PID. Storing both
 * with the exact CLI path proves the original Fleet process still exists; a dead process, reused
 * PID, moved executable, or unrelated Node command all fail closed before tmux geometry is read.
 */
function captureFleetProcessIdentity(
  spawnSync: SpawnSyncLike,
  pid: number,
  cliPath: string,
): FleetProcessIdentity {
  const fingerprint = captureProcessFingerprint(spawnSync, pid);
  if (fingerprint === undefined || !fingerprint.includes(cliPath)) {
    throw new Error("Could not prove Fleet's process identity for nvim layout");
  }
  return { pid, cliPath, fingerprint };
}

function captureProcessFingerprint(
  spawnSync: SpawnSyncLike,
  pid: number,
): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const result = spawnSync(
    "ps",
    ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  const fingerprint = (result.stdout ?? "").trim();
  return fingerprint === "" ? undefined : fingerprint;
}

function parseFleetProcessIdentity(value: string): FleetProcessIdentity | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object"
      || parsed === null
      || !("pid" in parsed)
      || !("cliPath" in parsed)
      || !("fingerprint" in parsed)
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid as number) <= 0
      || typeof parsed.cliPath !== "string"
      || parsed.cliPath === ""
      || typeof parsed.fingerprint !== "string"
      || parsed.fingerprint === ""
    ) return undefined;
    return parsed as FleetProcessIdentity;
  } catch {
    return undefined;
  }
}

/**
 * Cleanup is a four-operation best-effort transaction.
 *
 * Stopping after one failed `set-hook -u` would preserve later external tmux state—the exact leak
 * this lifecycle owns. Every hook and option is attempted, then one combined error reports what
 * remained uncertain so Fleet can finish terminal cleanup without silently claiming success.
 */
function clearLayoutState(
  spawnSync: SpawnSyncLike,
  windowId: string,
  hooks: readonly string[] = LAYOUT_HOOKS,
): string[] {
  const operations: Array<{ args: string[]; label: string }> = [
    ...hooks.map((hookName) => ({
      args: ["set-hook", "-u", "-w", "-t", windowId, hookName],
      label: `${hookName} hook`,
    })),
    {
      args: ["set-option", "-u", "-w", "-t", windowId, FLEET_PANE_WINDOW_OPTION],
      label: "Fleet pane option",
    },
    {
      args: ["set-option", "-u", "-w", "-t", windowId, FLEET_PROCESS_WINDOW_OPTION],
      label: "Fleet process option",
    },
  ];
  const failures: string[] = [];
  for (const operation of operations) {
    const result = spawnSync("tmux", operation.args, { stdio: "ignore" });
    if (result.status !== 0) failures.push(operation.label);
  }
  return failures;
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
