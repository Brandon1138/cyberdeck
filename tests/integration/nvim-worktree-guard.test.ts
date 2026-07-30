import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The shipped Lua module, run by a real Neovim.
 *
 * The guard it keeps is the only thing standing between two agents and a silently lost file, and
 * it is written in a language nothing else in this suite executes. Driving it in-process — one
 * headless nvim, the module required off `runtimepath`, `open` and `refresh` called with the same
 * base64 payloads Cyberdeck sends — is what makes its behaviour a fact here rather than a claim.
 */
const RUNTIME_PATH = fileURLToPath(new URL("../../contrib/nvim", import.meta.url));

const hasNvim = spawnSync("nvim", ["--version"]).status === 0;

/**
 * Buffer states after each step, as the driver reports them. `true` means the buffer is editable.
 */
interface Report {
  answers: string[];
  opened: Record<string, boolean>;
  afterOuterFinished: Record<string, boolean>;
  afterInnerFinished: Record<string, boolean>;
}

const DRIVER = `
local runtime, outer, inner = _G.arg[1], _G.arg[2], _G.arg[3]
vim.opt.runtimepath:append(runtime)
vim.o.swapfile = false

local cyberdeck = require("cyberdeck")
local answers = {}

local function payload(session, worktree, live, file)
  return vim.base64.encode(vim.json.encode({
    session = session,
    worktree = worktree,
    title = "Cyberdeck · " .. session,
    live = live,
    entries = { { filename = file, lnum = 1, col = 1, text = "changed" } },
  }))
end

local function call(entry_point, ...)
  local answer = cyberdeck[entry_point](payload(...))
  table.insert(answers, answer)
end

local outer_file = outer .. "/outer.txt"
local inner_file = inner .. "/inner.txt"
local later_file = inner .. "/later.txt"

call("open", "session-outer", outer, true, outer_file)
call("open", "session-inner", inner, true, inner_file)

local function buffer_named(path)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and vim.api.nvim_buf_get_name(buf) == path then
      return buf
    end
  end
  return nil
end

local function state()
  local seen = {}
  for _, path in ipairs({ outer_file, inner_file, later_file }) do
    local buf = buffer_named(path)
    if buf ~= nil then
      seen[vim.fn.fnamemodify(path, ":t")] = vim.bo[buf].modifiable
    end
  end
  return seen
end

local report = { answers = answers, opened = state() }

-- The outer worker finishes while the inner one is still running.
call("refresh", "session-outer", outer, false, outer_file)
-- A file of the inner worker's opened only now takes the same terms as one already open.
vim.cmd("edit " .. vim.fn.fnameescape(later_file))
report.afterOuterFinished = state()

call("refresh", "session-inner", inner, false, inner_file)
report.afterInnerFinished = state()

report.answers = answers
io.stdout:write(vim.json.encode(report))
`;

describe.skipIf(!hasNvim)("the worktree guard in a real nvim", () => {
  let directory: string;
  let outer: string;
  let inner: string;
  let report: Report;

  beforeAll(() => {
    // Canonical paths: macOS hands out `/var/folders/...` for a temp directory that nvim will name
    // `/private/var/folders/...`, and the guard compares buffer names to the worktree by path.
    directory = realpathSync(mkdtempSync(join(tmpdir(), "cyberdeck-nvim-guard-")));
    // The nesting this is about: one worker's worktree lives inside another's.
    outer = join(directory, "checkout");
    inner = join(outer, "worktrees", "inner");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(outer, "outer.txt"), "outer\n");
    writeFileSync(join(inner, "inner.txt"), "inner\n");
    writeFileSync(join(inner, "later.txt"), "later\n");

    const driver = join(directory, "driver.lua");
    writeFileSync(driver, DRIVER);
    const run = spawnSync("nvim", ["--clean", "-l", driver, RUNTIME_PATH, outer, inner], {
      encoding: "utf8",
    });
    expect(run.stderr ?? "").toBe("");
    expect(run.status).toBe(0);
    report = JSON.parse(run.stdout ?? "") as Report;
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("accepts every request it is sent", () => {
    expect(report.answers).toEqual(["ok:1", "ok:1", "ok:1", "ok:1"]);
  });

  it("locks both worktrees while both workers are running", () => {
    expect(report.opened).toEqual({ "outer.txt": false, "inner.txt": false });
  });

  it("keeps the inner worker's files locked when the worker it nests inside finishes", () => {
    // The releasing worktree contains the running one, so a release by path would hand the inner
    // agent's files to the operator while that agent is still rewriting them.
    expect(report.afterOuterFinished).toEqual({
      "outer.txt": true,
      "inner.txt": false,
      "later.txt": false,
    });
  });

  it("releases the inner worker's files once it finishes too", () => {
    expect(report.afterInnerFinished).toEqual({
      "outer.txt": true,
      "inner.txt": true,
      "later.txt": true,
    });
  });
});
