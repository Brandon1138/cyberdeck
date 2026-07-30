import { hostWindowId, type SpawnSyncLike } from "../tmux/cockpit.js";
import { nvimServerAddress } from "./server-address.js";

/**
 * Only Fleet's own tmux window is ever listed. Cyberdeck opens a worktree in the nvim the operator
 * is already looking at, so an nvim in some other window — another project, another task — is out
 * of scope by construction rather than by ranking.
 */
export const NVIM_PANE_FORMAT = "#{pane_id}\t#{pane_dead}\t#{pane_current_command}";

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

export interface DiscoverNvimPaneOptions {
  spawnSync: SpawnSyncLike;
  /** The pane Fleet — or the `cyberdeck open` invocation — occupies. */
  hostPaneId: string;
  uid?: number | undefined;
}

/**
 * Name the nvim Cyberdeck will drive, or say plainly that there is none.
 *
 * There is deliberately no fallback: no nvim is spawned, no other window is searched, and no
 * socket directory is scanned. Any of those would open a worktree somewhere the operator is not
 * looking, which is worse than an error telling them what to do.
 */
export function discoverNvimPane(options: DiscoverNvimPaneOptions): NvimPane {
  const windowId = hostWindowId(options.spawnSync, options.hostPaneId);
  const panes = options.spawnSync(
    "tmux",
    ["list-panes", "-t", windowId, "-F", NVIM_PANE_FORMAT],
    { encoding: "utf8" },
  );
  if (panes.status !== 0) {
    throw new Error("tmux failed to inspect the window Fleet is running in");
  }
  const paneId = findNvimPane(panes.stdout ?? "");
  if (paneId === undefined) {
    throw Object.assign(
      new Error("No nvim in this tmux window. Open nvim here (for example `tmux split-window nvim`) and try again."),
      { code: "NVIM_NOT_IN_WINDOW" },
    );
  }
  return {
    paneId,
    ...(options.uid === undefined
      ? { address: nvimServerAddress(paneId) }
      : { address: nvimServerAddress(paneId, options.uid) }),
  };
}
