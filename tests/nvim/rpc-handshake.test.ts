import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { remoteExprArgs } from "../../src/nvim/bridge.js";
import { NVIM_PROTOCOL_VERSION } from "../../src/nvim/protocol.js";
import { encodeNvimPayload, type NvimWorktreeRequest } from "../../src/nvim/quickfix.js";

const MODULE_ROOT = resolve(import.meta.dirname, "../../contrib/nvim/lua");
const hasNvim = spawnSync("nvim", ["--version"], { encoding: "utf8" }).status === 0;

function expression(entryPoint: "open" | "refresh", request: NvimWorktreeRequest): string {
  return remoteExprArgs("/unused", entryPoint, encodeNvimPayload(request))[3]!;
}

// Evaluating exactly the --remote-expr argument exercises Vim string parsing and luaeval without
// opening a socket or using the operator's tmux pane. Every nvim has fresh state and no config.
function runLua(script: string, moduleRoot = MODULE_ROOT): Record<string, unknown> {
  const directory = mkdtempSync(join(tmpdir(), "cyberdeck-rpc-test-"));
  const { TMUX: _tmux, TMUX_PANE: _pane, NVIM: _nvim, NVIM_LISTEN_ADDRESS: _address, ...env } = process.env;
  try {
    const driver = join(directory, "driver.lua");
    writeFileSync(driver, `
package.path = os.getenv("CYBERDECK_TEST_LUA_ROOT") .. "/?.lua;" .. os.getenv("CYBERDECK_TEST_LUA_ROOT") .. "/?/init.lua;" .. package.path
vim.o.swapfile = false
local report = {}
${script}
io.write(vim.json.encode(report))
`);
    const run = spawnSync("nvim", ["--clean", "--headless", "-i", "NONE", "-l", driver], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...env,
        CYBERDECK_TEST_LUA_ROOT: moduleRoot,
        XDG_STATE_HOME: join(directory, "state"),
        XDG_CACHE_HOME: join(directory, "cache"),
      },
    });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function request(worktree: string, live: boolean): NvimWorktreeRequest {
  return {
    session: "rpc-proof",
    worktree,
    title: "Cyberdeck · quote's \"context\"",
    live,
    baseline: { kind: "none", label: "no baseline" },
    entries: [{ filename: join(worktree, "proof.txt"), lnum: 1, col: 1, text: "changed" }],
  };
}

function guardProof(worktree: string): string {
  const open = expression("open", request(worktree, true));
  const refresh = expression("refresh", request(worktree, false));
  const unversioned = Buffer.from(JSON.stringify(request(worktree, false))).toString("base64");
  const older = Buffer.from(JSON.stringify({ ...request(worktree, false), protocolVersion: 0 })).toString("base64");
  return `
local cyberdeck = require("cyberdeck")
report.version = cyberdeck.protocol_version
report.open = vim.fn.eval([=[${open}]=])
report.locked = not vim.bo.modifiable
local before = { tabs = #vim.api.nvim_list_tabpages(), buffer = vim.api.nvim_get_current_buf(), list = vim.fn.getloclist(0) }
cyberdeck.protocol_version = ${NVIM_PROTOCOL_VERSION + 1}
report.rejectedOpen = vim.fn.eval([=[${open}]=])
report.rejectedRefresh = vim.fn.eval([=[${refresh}]=])
cyberdeck.protocol_version = ${NVIM_PROTOCOL_VERSION}
report.missingPayloadOpen = cyberdeck.open('${unversioned}')
report.missingPayloadRefresh = cyberdeck.refresh('${unversioned}')
report.olderPayloadOpen = cyberdeck.open('${older}')
report.olderPayloadRefresh = cyberdeck.refresh('${older}')
report.unchanged = vim.deep_equal(before, { tabs = #vim.api.nvim_list_tabpages(), buffer = vim.api.nvim_get_current_buf(), list = vim.fn.getloclist(0) })
report.stillLocked = not vim.bo.modifiable
report.refresh = vim.fn.eval([=[${refresh}]=])
report.released = vim.bo.modifiable
`;
}

function expectGuardProof(report: Record<string, unknown>): void {
  expect(report.version).toBe(NVIM_PROTOCOL_VERSION);
  expect(report.open).toBe("ok:1");
  expect(report.locked).toBe(true);
  expect(report.rejectedOpen).toContain(`protocol mismatch (client ${NVIM_PROTOCOL_VERSION}, module ${NVIM_PROTOCOL_VERSION + 1})`);
  expect(report.rejectedRefresh).toContain("protocol mismatch");
  expect(report.missingPayloadOpen).toContain("request has no protocolVersion");
  expect(report.missingPayloadRefresh).toContain("request has no protocolVersion");
  expect(report.olderPayloadOpen).toContain(`protocol mismatch (client 0, module ${NVIM_PROTOCOL_VERSION})`);
  expect(report.olderPayloadRefresh).toContain("protocol mismatch");
  expect(report.unchanged).toBe(true);
  expect(report.stillLocked).toBe(true);
  expect(report.refresh).toBe("ok:1");
  expect(report.released).toBe(true);
}

describe.skipIf(!hasNvim)("nvim RPC version handshake", () => {
  it("applies matching open/refresh and rejects mismatches without changing tabs, lists or locks", () => {
    const directory = mkdtempSync(join(tmpdir(), "cyberdeck-rpc-worktree-"));
    try {
      writeFileSync(join(directory, "proof.txt"), "proof\n");
      expectGuardProof(runLua(guardProof(directory)));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const [name, setup, message] of [
    ["missing module", `package.preload.cyberdeck = function() error("module not installed") end`, "module is missing or failed to load"],
    ["older module with no export", `package.loaded.cyberdeck = { open = apply, refresh = apply }`, "no protocol_version export (older module)"],
    ["mismatched module", `package.loaded.cyberdeck = { protocol_version = ${NVIM_PROTOCOL_VERSION + 1}, open = apply, refresh = apply }`, "protocol mismatch"],
    ["invalid module export", `package.loaded.cyberdeck = true`, "no protocol_version export"],
    ["matching version with missing entry point", `package.loaded.cyberdeck = { protocol_version = ${NVIM_PROTOCOL_VERSION} }`, "export"],
  ]) {
    it(`rejects ${name} before open or refresh`, () => {
      const open = expression("open", request("/unused", true));
      const refresh = expression("refresh", request("/unused", false));
      const report = runLua(`
local applied = 0
local function apply() applied = applied + 1; return "ok:0" end
${setup}
report.open = vim.fn.eval([=[${open}]=])
report.refresh = vim.fn.eval([=[${refresh}]=])
report.applied = applied
report.tabs = #vim.api.nvim_list_tabpages()
report.commands = vim.fn.exists(":CyberdeckUnlock")
`);
      expect(report.open).toContain(`error: Cyberdeck nvim`);
      expect(report.open).toContain(message);
      expect(report.refresh).toContain(message);
      expect(report.applied).toBe(0);
      expect(report.tabs).toBe(1);
      expect(report.commands).toBe(0);
    });
  }

});

describe("packaged nvim surface", () => {
  it("ships an installable Lua path and platform guides in the npm artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "cyberdeck-packed-nvim-"));
    try {
      const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--silent", "--pack-destination", directory], {
        cwd: resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, npm_config_cache: join(directory, "npm-cache") },
      });
      expect(pack.error).toBeUndefined();
      expect(pack.status, pack.stderr).toBe(0);
      const [artifact] = JSON.parse(pack.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
      const files = artifact!.files.map(({ path }) => path);
      expect(files.filter((file) => file.endsWith("/lua/cyberdeck/init.lua"))).toEqual(["contrib/nvim/lua/cyberdeck/init.lua"]);
      for (const guide of ["docs/linux-install.md", "docs/linux-acceptance.md", "docs/linux-nvim.md", "docs/architecture/nvim-surface.md", "contrib/nvim/README.md"]) {
        expect(files).toContain(guide);
      }
      const installed = join(directory, "installed");
      mkdirSync(installed);
      const unpack = spawnSync("tar", ["-xzf", join(directory, artifact!.filename), "-C", installed], { encoding: "utf8" });
      expect(unpack.status, unpack.stderr).toBe(0);
      const moduleRoot = join(installed, "package/contrib/nvim/lua");
      expect(readFileSync(join(moduleRoot, "cyberdeck/init.lua"), "utf8")).toContain("protocol_version");
      const worktree = join(directory, "worktree");
      mkdirSync(worktree);
      writeFileSync(join(worktree, "proof.txt"), "installed proof\n");
      if (hasNvim) expectGuardProof(runLua(guardProof(worktree), moduleRoot));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 45_000);
});
