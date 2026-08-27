import { spawnSync as nodeSpawnSync } from "node:child_process";
import type { SpawnSyncLike } from "../tmux/cockpit.js";
import type { NvimEntryPoint, NvimWorktreeRequest } from "../domain/worktree-review.js";
import { encodeNvimPayload } from "./quickfix.js";

export type { NvimEntryPoint } from "../domain/worktree-review.js";

/**
 * `--remote-expr`, never `--remote-send`.
 *
 * `--remote-send` feeds keystrokes into whatever mode the operator's nvim happens to be in, so its
 * effect depends on their state and their mappings. `--remote-expr` calls one function and returns
 * its value, which is the only way this can be a contract rather than a hope.
 */
export function remoteExprArgs(
  address: string,
  entryPoint: NvimEntryPoint,
  payload: string,
): string[] {
  return [
    "--server",
    address,
    "--remote-expr",
    `v:lua.require'cyberdeck'.${entryPoint}('${payload}')`,
  ];
}

export interface NvimCallOptions {
  address: string;
  entryPoint: NvimEntryPoint;
  request: NvimWorktreeRequest;
  spawnSync?: SpawnSyncLike | undefined;
  nvimPath?: string | undefined;
}

/**
 * The two failures are kept apart because they ask the operator for different things.
 *
 * A nonzero exit means nothing was listening on that socket: nvim is in the pane, but the config
 * never called `listen()`. An `error:` answer means the module ran and refused, and relaying what
 * it said is more use than a generic failure.
 */
export function callNvim(options: NvimCallOptions): string {
  const spawnSync = options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  const result = spawnSync(
    options.nvimPath ?? "nvim",
    remoteExprArgs(options.address, options.entryPoint, encodeNvimPayload(options.request)),
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw Object.assign(
      new Error(
        `nvim did not answer on ${options.address}. Add \`require("cyberdeck").listen()\` to your nvim config and restart nvim in this pane.`,
      ),
      { code: "NVIM_NOT_SERVING" },
    );
  }
  const answer = (result.stdout ?? "").trim();
  if (answer.startsWith("error:")) {
    throw Object.assign(
      new Error(`nvim rejected the request: ${answer.slice("error:".length).trim()}`),
      { code: "NVIM_REQUEST_REJECTED" },
    );
  }
  return answer;
}
