import { spawnSync as nodeSpawnSync } from "node:child_process";
import type { SpawnSyncLike } from "../tmux/cockpit.js";
import type { NvimEntryPoint, NvimWorktreeRequest } from "../domain/worktree-review.js";
import { encodeNvimPayload } from "./quickfix.js";
import { NVIM_PROTOCOL_VERSION } from "./protocol.js";

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
  // Check and apply inside one remote expression. A separate probe could validate a module that
  // the operator replaces before the open, and an older module has no guard of its own to call.
  const setup = "load contrib/nvim from this Cyberdeck installation and restart nvim in this pane";
  const lua = [
    "(function()",
    "local ok, module = pcall(require, 'cyberdeck')",
    `if not ok then return 'error: Cyberdeck nvim module is missing or failed to load; ${setup}: ' .. tostring(module) end`,
    `if type(module) ~= 'table' or module.protocol_version == nil then return 'error: Cyberdeck nvim module has no protocol_version export (older module); ${setup}' end`,
    `if module.protocol_version ~= ${NVIM_PROTOCOL_VERSION} then return 'error: Cyberdeck nvim protocol mismatch (client ${NVIM_PROTOCOL_VERSION}, module ' .. tostring(module.protocol_version) .. '); ${setup}' end`,
    `if type(module.${entryPoint}) ~= 'function' then return 'error: Cyberdeck nvim module has no ${entryPoint} export; ${setup}' end`,
    `return module.${entryPoint}('${payload}')`,
    "end)()",
  ].join(" ");
  return [
    "--server",
    address,
    "--remote-expr",
    `luaeval(${JSON.stringify(lua)})`,
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
