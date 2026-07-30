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

/**
 * Where an open lands, in a real nvim.
 *
 * `:tabnew` starts on a `[No Name]` scratch buffer, and only a location-list entry ever displaced
 * it — so a worker with nothing to show landed the operator nowhere. What replaces it is a
 * directory buffer, which is whatever the operator's config makes it, and an `on_open` hook that
 * can take the landing over entirely. None of that is checkable without running the Lua.
 */
interface LandingReport {
  answers: string[];
  emptyBuffer: string;
  entriesBuffer: string;
  entriesLine: number;
  hookedBuffer: string;
  suppressedBuffer: string;
  threwBuffer: string;
  seen: Array<Record<string, unknown>>;
}

const LANDING_DRIVER = `
local runtime, base = _G.arg[1], _G.arg[2]
vim.opt.runtimepath:append(runtime)
vim.o.swapfile = false

local cyberdeck = require("cyberdeck")
local answers, seen = {}, {}
local mode = "none"

local function payload(session, worktree, entries)
  return vim.base64.encode(vim.json.encode({
    session = session,
    worktree = worktree,
    title = "Cyberdeck · " .. session,
    live = false,
    entries = entries,
  }))
end

local function open(session, worktree, entries)
  table.insert(answers, cyberdeck.open(payload(session, worktree, entries)))
  return vim.api.nvim_buf_get_name(0)
end

local function change(worktree)
  return { { filename = worktree .. "/changed.txt", lnum = 2, col = 1, text = "changed" } }
end

local report = {}

-- No hook at all: an empty list has to leave the operator on the worktree, not on [No Name].
report.emptyBuffer = open("session-empty", base .. "/empty", {})

-- No hook, one entry: the change is still where the operator lands.
local entries_tree = base .. "/entries"
report.entriesBuffer = open("session-entries", entries_tree, change(entries_tree))
report.entriesLine = vim.api.nvim_win_get_cursor(0)[1]

-- Registering a hook is the only thing listen() is being asked to do here. TMUX_PANE is unset by
-- the test, so no socket is served and the operator's own nvim is left alone.
cyberdeck.listen({
  on_open = function(ctx)
    if mode == "throw" then
      error("the operator's hook blew up")
    end
    table.insert(seen, {
      session = ctx.session,
      worktree = ctx.worktree,
      title = ctx.title,
      live = ctx.live,
      entries = #ctx.entries,
      first = ctx.entries[1] ~= nil and ctx.entries[1].filename or nil,
      tab_is_current = ctx.tab == vim.api.nvim_get_current_tabpage(),
      win_is_current = ctx.win == vim.api.nvim_get_current_win(),
      cwd = vim.fn.getcwd(),
    })
    if mode == "suppress" then
      return true
    end
  end,
})

-- A hook that returns nothing observes and then gets out of the way.
mode = "observe"
local hooked_tree = base .. "/hooked"
report.hookedBuffer = open("session-hooked", hooked_tree, change(hooked_tree))

-- A hook that returns true landed the tab itself, so Cyberdeck must not land it again.
mode = "suppress"
local suppressed_tree = base .. "/suppressed"
report.suppressedBuffer = open("session-suppressed", suppressed_tree, change(suppressed_tree))

-- A hook that throws costs the operator a message, not the worktree.
mode = "throw"
local threw_tree = base .. "/threw"
report.threwBuffer = open("session-threw", threw_tree, change(threw_tree))

report.answers = answers
report.seen = seen
io.stdout:write(vim.json.encode(report))
`;

const LANDING_TREES = ["empty", "entries", "hooked", "suppressed", "threw"] as const;

describe.skipIf(!hasNvim)("where an open lands in a real nvim", () => {
  let directory: string;
  let report: LandingReport;
  let stderr: string;

  beforeAll(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "cyberdeck-nvim-landing-")));
    for (const name of LANDING_TREES) {
      mkdirSync(join(directory, name), { recursive: true });
      writeFileSync(join(directory, name, "changed.txt"), "one\ntwo\nthree\n");
    }

    const driver = join(directory, "driver.lua");
    writeFileSync(driver, LANDING_DRIVER);
    // Without this the driver would inherit the operator's own pane, and `listen()` would take over
    // the socket their real nvim is serving on.
    const { TMUX_PANE: _pane, ...env } = process.env;
    const run = spawnSync("nvim", ["--clean", "-l", driver, RUNTIME_PATH, directory], {
      encoding: "utf8",
      env,
    });
    expect(run.status).toBe(0);
    stderr = run.stderr ?? "";
    report = JSON.parse(run.stdout ?? "") as LandingReport;
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("accepts every request, including the ones a hook interfered with", () => {
    expect(report.answers).toEqual(["ok:0", "ok:1", "ok:1", "ok:1", "ok:1"]);
  });

  it("shows the worktree itself when there is nothing to land on", () => {
    // The bug: this was the `[No Name]` buffer `:tabnew` creates, whose name is the empty string.
    expect(report.emptyBuffer).toBe(join(directory, "empty"));
  });

  it("still lands on the first change when there is one", () => {
    expect(report.entriesBuffer).toBe(join(directory, "entries", "changed.txt"));
    expect(report.entriesLine).toBe(2);
  });

  it("hands the hook the tab, the window and the request that produced them", () => {
    expect(report.seen[0]).toEqual({
      session: "session-hooked",
      worktree: join(directory, "hooked"),
      title: "Cyberdeck · session-hooked",
      live: false,
      entries: 1,
      first: join(directory, "hooked", "changed.txt"),
      tab_is_current: true,
      win_is_current: true,
      // `:tcd` has already run, so a hook that opens an explorer at the cwd is at the worktree.
      cwd: join(directory, "hooked"),
    });
  });

  it("lands the tab anyway when the hook declines to say it did", () => {
    expect(report.hookedBuffer).toBe(join(directory, "hooked", "changed.txt"));
  });

  it("leaves the tab alone when the hook returns true", () => {
    expect(report.seen).toHaveLength(2);
    expect(report.suppressedBuffer).toBe("");
  });

  it("reports a hook that throws and lands the tab without it", () => {
    expect(report.threwBuffer).toBe(join(directory, "threw", "changed.txt"));
    expect(stderr).toContain("on_open failed");
  });
});
