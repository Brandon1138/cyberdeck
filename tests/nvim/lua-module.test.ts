import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Lua half of the nvim surface, driven the way Cyberdeck drives it.
 *
 * The read-only guard and the baseline diff are behaviour, not payload shape, and the payload tests
 * next door cannot see either: a request that encodes perfectly still has to lock a buffer and let
 * the operator out of it again. So this runs the real module in a real headless nvim.
 *
 * It is skipped where nvim is absent — CI runners have none, and a test that cannot run must say so
 * rather than fail as if the module were broken.
 */
const NVIM = spawnSync("nvim", ["--version"], { encoding: "utf8" }).status === 0;

const MODULE_DIR = resolve(import.meta.dirname, "../../contrib/nvim/lua");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

/** Run one Lua script in a headless nvim and hand back everything it wrote to stdout. */
function runInNvim(script: string, env: Record<string, string>): string {
  const scriptPath = join(mkdtempSync(join(tmpdir(), "cyberdeck-lua-")), "drive.lua");
  writeFileSync(scriptPath, script, "utf8");
  const result = spawnSync("nvim", ["-u", "NONE", "-l", scriptPath], {
    encoding: "utf8",
    env: { ...process.env, ...env, CYBERDECK_LUA: MODULE_DIR },
    timeout: 30_000,
  });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

const PRELUDE = `
package.path = os.getenv("CYBERDECK_LUA") .. "/?.lua;" .. os.getenv("CYBERDECK_LUA") .. "/?/init.lua;" .. package.path
local cyberdeck = require("cyberdeck")
local root = os.getenv("CD_ROOT")
local function payload(request) return vim.base64.encode(vim.json.encode(request)) end
local function say(name, value) io.write(name .. "=" .. tostring(value) .. "\\n") end
`;

describe.skipIf(!NVIM)("the nvim module", () => {
  it("locks a live worker's buffers, shows the change list, and lets the operator out again", () => {
    const root = mkdtempSync(join(tmpdir(), "cyberdeck-worktree-"));
    writeFileSync(join(root, "a.txt"), "one\ntwo\n", "utf8");

    try {
      const output = runInNvim(`${PRELUDE}
local file = root .. "/a.txt"
local request = {
  session = "session-one",
  worktree = root,
  title = "Cyberdeck · worker · since origin/main",
  live = true,
  baseline = { kind = "fork-point", label = "since origin/main", rev = "deadbeefdeadbeef" },
  entries = { { filename = file, lnum = 1, col = 1, text = "changed" } },
}
say("open", cyberdeck.open(payload(request)))

local loclist = false
for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  if vim.fn.getwininfo(win)[1].loclist == 1 then loclist = true end
end
say("loclist_visible", loclist)

vim.cmd("edit " .. vim.fn.fnameescape(file))
say("locked", vim.bo.modifiable == false)
say("command_exists", vim.fn.exists(":CyberdeckUnlock") == 2)

vim.cmd("CyberdeckUnlock")
say("unlocked", vim.bo.modifiable == true)
vim.cmd("CyberdeckLock")
say("relocked", vim.bo.modifiable == false)

-- A worktree-wide release also covers files opened after it.
vim.cmd("CyberdeckUnlock!")
vim.fn.writefile({ "x" }, root .. "/b.txt")
vim.cmd("edit " .. vim.fn.fnameescape(root .. "/b.txt"))
say("released_reaches_new_buffers", vim.bo.modifiable == true)

request.live = false
say("refresh", cyberdeck.refresh(payload(request)))
vim.cmd("edit " .. vim.fn.fnameescape(file))
say("free_when_finished", vim.bo.modifiable == true)
`, { CD_ROOT: root });

      expect(output).toContain("open=ok:1");
      expect(output).toContain("loclist_visible=true");
      expect(output).toContain("locked=true");
      expect(output).toContain("command_exists=true");
      expect(output).toContain("unlocked=true");
      expect(output).toContain("relocked=true");
      expect(output).toContain("released_reaches_new_buffers=true");
      expect(output).toContain("free_when_finished=true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("diffs a file against the baseline revision Cyberdeck resolved, and says so when there is none", () => {
    const root = mkdtempSync(join(tmpdir(), "cyberdeck-baseline-"));
    writeFileSync(join(root, "a.txt"), "one\ntwo\n", "utf8");
    git(root, "init", "--quiet");
    git(root, "add", "a.txt");
    git(root, "commit", "--quiet", "-m", "base");
    const rev = git(root, "rev-parse", "HEAD").trim();
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n", "utf8");

    try {
      const output = runInNvim(`${PRELUDE}
local file = root .. "/a.txt"
local request = {
  session = "session-one",
  worktree = root,
  title = "Cyberdeck · worker · since origin/main",
  live = false,
  baseline = { kind = "fork-point", label = "since origin/main", rev = os.getenv("CD_REV") },
  entries = { { filename = file, lnum = 3, col = 1, text = "changed" } },
}
cyberdeck.open(payload(request))
vim.cmd("edit " .. vim.fn.fnameescape(file))
say("diff", cyberdeck.diff())
say("both_sides_in_diff_mode", vim.wo.diff == true)
local baseline_lines = 0
for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  local name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win))
  if name:match("^cyberdeck://") then
    baseline_lines = vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))
  end
end
-- The committed file had two lines; the working tree has three.
say("baseline_lines", baseline_lines)

-- A rung with no revision has nothing to show, and says which rung that was.
vim.cmd("tabnew")
request.worktree = root .. "/nested"
vim.fn.mkdir(request.worktree, "p")
vim.fn.writefile({ "x" }, request.worktree .. "/c.txt")
request.baseline = { kind = "none", label = "no baseline" }
request.entries = {}
cyberdeck.open(payload(request))
vim.cmd("edit " .. vim.fn.fnameescape(request.worktree .. "/c.txt"))
say("diff_without_baseline", cyberdeck.diff())
`, { CD_ROOT: root, CD_REV: rev });

      expect(output).toContain("diff=true");
      expect(output).toContain("both_sides_in_diff_mode=true");
      expect(output).toContain("baseline_lines=2");
      expect(output).toContain("diff_without_baseline=false");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
