import { existsSync } from "node:fs";
import { hostWindowId, type SpawnSyncLike } from "../tmux/cockpit.js";
import { nvimServerAddress } from "./server-address.js";
import { rebalanceNvimWindow } from "./window-layout.js";

/**
 * Only Fleet's own tmux window is ever listed. Cyberdeck opens a worktree in the nvim the operator
 * is already looking at, so an nvim in some other window — another project, another task — is out
 * of scope by construction rather than by ranking.
 */
export const NVIM_PANE_FORMAT = "#{pane_id}\t#{pane_dead}\t#{pane_current_command}";

/**
 * Geometry, asked for separately from {@link NVIM_PANE_FORMAT} and only when a pane has to be
 * created. `pane_right` is the column of the pane's right edge, which is what "rightmost" means
 * here; the two formats stay apart so the parse that decides *which nvim to talk to* keeps having
 * exactly one job.
 */
export const NVIM_SPLIT_TARGET_FORMAT = "#{pane_id}\t#{pane_dead}\t#{pane_right}";

/**
 * Full-row geometry belongs to layout planning, not nvim discovery or split targeting.
 *
 * `pane_left` is included so resize commands follow what the operator sees rather than tmux's pane
 * index order. Keeping this third format separate leaves both older parsers narrow and unchanged.
 */
export const NVIM_LAYOUT_PANE_FORMAT = [
  "#{pane_id}",
  "#{pane_dead}",
  "#{pane_left}",
  "#{pane_top}",
  "#{pane_height}",
  "#{pane_width}",
  "#{pane_current_command}",
  "#{pane_start_command}",
].join("\t");

/**
 * How long a freshly split nvim gets to call `listen()`.
 *
 * The socket does not exist when `split-window` returns: nvim has to boot, and under a plugin
 * manager that defers work — lazy.nvim does — `require("cyberdeck").listen()` runs some way into
 * startup. Five seconds covers a cold start on a loaded config; past that the config almost
 * certainly never calls `listen()` at all, which is a different problem and gets said out loud
 * rather than waited on.
 */
export const NVIM_SPAWN_TIMEOUT_MS = 5_000;

/** Short enough that a fast nvim is not made to look slow, long enough not to spin. */
export const NVIM_SPAWN_POLL_INTERVAL_MS = 50;

export interface NvimPane {
  paneId: string;
  address: string;
}

/**
 * A pane tmux is holding open after its process exited still advertises a command, so a dead pane
 * is skipped rather than addressed. `pane_current_command` is the process tmux currently sees in
 * the pane: an nvim busy running a `:terminal` job or a shelled-out `git` reports that child
 * instead, and such a pane is correctly not a match — Cyberdeck would have nothing to talk to.
 */
export function findNvimPane(listPanesOutput: string): string | undefined {
  for (const line of listPanesOutput.split("\n")) {
    const [paneId, dead, ...rest] = line.split("\t");
    if (paneId === undefined || dead === undefined) continue;
    if (dead.trim() !== "0") continue;
    if (rest.join("\t").trim() !== "nvim") continue;
    return paneId.trim();
  }
  return undefined;
}

/**
 * The pane a new nvim is split off from: the one furthest right in the window.
 *
 * The arrangement this is written for is `Fleet | Orc | Code`, and the orchestrator attachment
 * already sits immediately right of Fleet. Splitting Fleet's own pane would wedge nvim between the
 * two panes the operator reads together, so the split anchors on the right edge instead. Dead panes
 * are skipped for the same reason they are skipped elsewhere: tmux is only holding them open. Ties
 * — panes stacked at the same right edge — keep the first tmux listed, which is the topmost.
 */
export function rightmostPane(listPanesOutput: string): string | undefined {
  let best: { paneId: string; right: number } | undefined;
  for (const line of listPanesOutput.split("\n")) {
    const [paneId, dead, right] = line.split("\t");
    if (paneId === undefined || dead === undefined || right === undefined) continue;
    if (dead.trim() !== "0") continue;
    const edge = Number(right.trim());
    if (!Number.isFinite(edge)) continue;
    if (best === undefined || edge > best.right) best = { paneId: paneId.trim(), right: edge };
  }
  return best?.paneId;
}

/** Seams for the spawn path; every one of them has a real default and exists for the tests. */
export interface NvimSpawnOptions {
  nvimPath?: string | undefined;
  socketExists?: ((address: string) => boolean) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  timeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
}

export interface DiscoverNvimPaneOptions {
  spawnSync: SpawnSyncLike;
  /** The pane Fleet — or the `cyberdeck open` invocation — occupies. */
  hostPaneId: string;
  uid?: number | undefined;
  spawn?: NvimSpawnOptions | undefined;
  layout?: {
    enabled: boolean;
    orchestratorSessionIds: readonly string[];
  } | undefined;
}

/**
 * Name the nvim Cyberdeck will drive, creating one only if this window has none.
 *
 * The fallback is deliberately the narrowest one that helps: an nvim is split into Fleet's *own*
 * window, so the worktree still opens where the operator is looking. No other window is searched
 * and no socket directory is scanned — either would open a worktree somewhere out of sight, which
 * is worse than an error telling the operator what to do.
 *
 * An nvim that is running but never called `listen()` is not this function's problem: that pane is
 * found, returned, and `callNvim` reports `NVIM_NOT_SERVING` against it. Spawning a second nvim on
 * top of the operator's own would be a guess about which one they meant.
 */
export async function discoverNvimPane(options: DiscoverNvimPaneOptions): Promise<NvimPane> {
  const windowId = hostWindowId(options.spawnSync, options.hostPaneId);
  const panes = options.spawnSync(
    "tmux",
    ["list-panes", "-t", windowId, "-F", NVIM_PANE_FORMAT],
    { encoding: "utf8" },
  );
  if (panes.status !== 0) {
    throw new Error("tmux failed to inspect the window Fleet is running in");
  }
  const found = findNvimPane(panes.stdout ?? "");
  if (found !== undefined) {
    applyLayout(options, windowId);
    return describePane(found, options.uid);
  }
  const spawned = spawnNvimPane(options, windowId);
  applyLayout(options, windowId);
  const pane = describePane(spawned, options.uid);
  await awaitNvimSocket(pane.address, options.spawn ?? {});
  return pane;
}

function describePane(paneId: string, uid: number | undefined): NvimPane {
  return {
    paneId,
    ...(uid === undefined
      ? { address: nvimServerAddress(paneId) }
      : { address: nvimServerAddress(paneId, uid) }),
  };
}

/**
 * The pane id comes back from tmux rather than being derived: the RPC socket address is a function
 * of that id and nothing else, so guessing it is not an option.
 */
function spawnNvimPane(options: DiscoverNvimPaneOptions, windowId: string): string {
  const layout = options.spawnSync(
    "tmux",
    ["list-panes", "-t", windowId, "-F", NVIM_SPLIT_TARGET_FORMAT],
    { encoding: "utf8" },
  );
  requireSuccess(layout, "measure the window Fleet is running in");
  const target = rightmostPane(layout.stdout ?? "") ?? options.hostPaneId;
  const created = options.spawnSync(
    "tmux",
    [
      "split-window",
      "-h",
      ...(options.layout?.enabled === true ? ["-l", "50%"] : []),
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      target,
      options.spawn?.nvimPath ?? "nvim",
    ],
    { encoding: "utf8" },
  );
  requireSuccess(created, "open an nvim pane in the window Fleet is running in");
  const paneId = (created.stdout ?? "").trim();
  if (!/^%\d+$/u.test(paneId)) {
    throw Object.assign(
      new Error(`tmux did not name the nvim pane it created: ${paneId === "" ? "no output" : paneId}`),
      { code: "NVIM_SPAWN_UNIDENTIFIED" },
    );
  }
  return paneId;
}

function applyLayout(options: DiscoverNvimPaneOptions, windowId: string): void {
  if (options.layout?.enabled !== true) return;
  rebalanceNvimWindow({
    spawnSync: options.spawnSync,
    windowId,
    paneFormat: NVIM_LAYOUT_PANE_FORMAT,
    hostPaneId: options.hostPaneId,
    orchestratorSessionIds: options.layout.orchestratorSessionIds,
  });
}

/**
 * Wait for the spawned nvim to be reachable, or say why it is not.
 *
 * Falling through to `--remote-expr` on a socket nobody is listening on would report the generic
 * "nvim did not answer" against an nvim Cyberdeck itself just started, which reads as a bug in the
 * open rather than as the missing config line it almost always is.
 */
async function awaitNvimSocket(address: string, spawn: NvimSpawnOptions): Promise<void> {
  const socketExists = spawn.socketExists ?? existsSync;
  const now = spawn.now ?? Date.now;
  const sleep = spawn.sleep ?? delay;
  const interval = spawn.pollIntervalMs ?? NVIM_SPAWN_POLL_INTERVAL_MS;
  const deadline = now() + (spawn.timeoutMs ?? NVIM_SPAWN_TIMEOUT_MS);
  for (;;) {
    if (socketExists(address)) return;
    if (now() >= deadline) {
      throw Object.assign(
        new Error(
          `Started nvim in this window, but nothing was listening on ${address}. Add \`require("cyberdeck").listen()\` to your nvim config.`,
        ),
        { code: "NVIM_SPAWN_NOT_SERVING" },
      );
    }
    await sleep(interval);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requireSuccess(result: { status: number | null }, action: string): void {
  if (result.status !== 0) throw new Error(`tmux failed to ${action}`);
}
