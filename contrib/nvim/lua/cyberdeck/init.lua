--- Cyberdeck's nvim side.
---
--- This module is inert until Cyberdeck calls it. It installs no keymaps and no commands, and the
--- single autocommand it does install is created the first time a worktree is opened, not on load.
--- The operator's own config needs one line: `require("cyberdeck").listen()`.
---
--- What a worktree looks like once it is open is the operator's call, not this module's: see
--- `contrib/nvim/README.md` for `listen({ on_open = ... })` and what the default landing does
--- without it. This module depends on no plugin and never names one.
---
--- Cyberdeck drives the two entry points below over `nvim --server <addr> --remote-expr`. They take
--- one base64-encoded JSON payload each, which is what lets a worktree path or a diff context line
--- contain quotes and newlines without any escaping question arising.
---
--- Requires Neovim 0.10 (vim.base64, vim.uv).

local M = {}

--- One convention, mirrored in src/nvim/server-address.ts. Both sides derive the address from the
--- tmux pane id alone, so neither has to be told where the other is. Changing it here without
--- changing it there strands every open request on a socket nobody is listening to.
local SOCKET_PREFIX = "/tmp/cyberdeck-nvim-"

local uv = vim.uv or vim.loop

--- worktree -> tabpage. A second open of the same worktree reuses its tab rather than stacking
--- tabs the operator never asked for, and `:tcd` keeps each tab's cwd to itself so several
--- worktrees coexist without fighting over the global cwd.
local tabs = {}

--- session id -> worktree, one entry per worker still running. This is what the buffer guard
--- consults, so a file opened long after the initial request is protected on the same terms as one
--- that was already open.
---
--- Keyed by session rather than by worktree because worktrees nest: a worker working in
--- `~/code/x/worktrees/y` is inside another worker's `~/code/x`, and the two guards then cover
--- overlapping sets of files. Keyed by path, the outer worker finishing would release the inner
--- worker's files as well.
local guarded = {}

--- session id -> true, for the guards the operator has deliberately stood down.
---
--- A lock the operator cannot lift is a lock they work around, so the release is explicit, per
--- session, and sticky: it survives a reopen of the same worktree, because a reopen is Cyberdeck
--- refreshing a list rather than the operator changing their mind. It is dropped when the worker
--- finishes — there is no guard left to be released from — and by `lock()`.
local released = {}

--- worktree -> the baseline its change list was measured from, as Cyberdeck sent it.
---
--- Cyberdeck is the only side that knows which rung of its ladder produced the list and which
--- commit that rung resolved to. Keeping the answer here is what lets `diff()` show a file against
--- the same baseline the list was built from rather than against a second guess.
local baselines = {}

local guard_installed = false
local commands_installed = false

--- The operator's own landing, handed to `listen()`. Nil is the ordinary case and means this module
--- lands the tab itself; see `land()` for what that is and why a hook can decline it.
local on_open = nil

--- Every path this module compares goes through here first, symlinks included.
---
--- nvim resolves symlinks when it names a buffer, and Cyberdeck sends the path the operator's fleet
--- knows the worktree by. On macOS `/tmp` and `/var` are symlinks, so those two spellings of one
--- directory do not share a prefix and a guard comparing them would cover nothing at all. Resolving
--- both sides is what makes containment a fact rather than a spelling.
---
--- A file that does not exist yet has no real path of its own, so its directory is resolved instead
--- — that is `BufNewFile`, which is exactly the case the guard has to catch before the first write.
local function normalize(path)
  local normalized = vim.fs.normalize(path)
  normalized = normalized:sub(-1) == "/" and normalized:sub(1, -2) or normalized
  local resolved = uv.fs_realpath(normalized)
  if resolved ~= nil then
    return resolved
  end
  local parent = uv.fs_realpath(vim.fn.fnamemodify(normalized, ":h"))
  if parent ~= nil then
    return parent .. "/" .. vim.fn.fnamemodify(normalized, ":t")
  end
  return normalized
end

--- Containment by path, not by name. The worktree is known exactly, so there is nothing to guess:
--- a buffer is either under it or it is not.
local function is_under(path, root)
  if path == nil or path == "" then
    return false
  end
  local candidate = normalize(path)
  return candidate == root or candidate:sub(1, #root + 1) == root .. "/"
end

--- Agents commonly rewrite whole files rather than editing them, so a live worktree is not a place
--- two writers can share: either side can silently lose the other's work. `readonly` alone only
--- warns, so `nomodifiable` is what actually makes the rule hold.
---
--- Only real file buffers are touched. Terminals, quickfix windows and help are left alone.
local function set_lock(buf, locked)
  if not vim.api.nvim_buf_is_valid(buf) then
    return
  end
  if vim.bo[buf].buftype ~= "" then
    return
  end
  vim.bo[buf].readonly = locked
  vim.bo[buf].modifiable = not locked
end

--- A file is locked while any running worker's worktree contains it. Overlapping worktrees are
--- ordinary here, so the question is never which guard owns a file, only whether one still claims
--- it — and whether the operator has already stood that claim down.
local function is_guarded(path)
  for session, root in pairs(guarded) do
    if not released[session] and is_under(path, root) then
      return true
    end
  end
  return false
end

--- The lock this buffer should be under right now, derived from everything that has a say.
---
--- A buffer the operator unlocked by hand says so itself, in a buffer-local variable, so the answer
--- survives a refresh, a reload, and a second worker's guard arriving over the same tree.
local function should_lock(buf, path)
  if vim.b[buf].cyberdeck_unlocked == true then
    return false
  end
  return is_guarded(path)
end

--- Which running worker still claims this file, innermost first.
---
--- Worktrees nest, so the guard that matters to an operator sitting in a file is the closest one
--- around it, not whichever `pairs` happened to reach first. Returns the session and its root, or
--- nothing when no guard covers the file at all.
local function innermost_guard(path)
  local best_session, best_root
  for session, root in pairs(guarded) do
    if is_under(path, root) and (best_root == nil or #root > #best_root) then
      best_session, best_root = session, root
    end
  end
  return best_session, best_root
end

--- The innermost opened worktree containing this file, by the same rule and for the same reason.
local function innermost_worktree(path)
  local best
  for worktree in pairs(baselines) do
    if is_under(path, worktree) and (best == nil or #worktree > #best) then
      best = worktree
    end
  end
  return best
end

--- Re-derive the lock of every open buffer under `root` from the guards that remain.
---
--- Deriving rather than being handed a flag is the whole point: the buffers under a worktree that
--- was just released are not all free, only the ones no surviving guard covers.
local function reapply_to_open_buffers(root)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) then
      local name = vim.api.nvim_buf_get_name(buf)
      if is_under(name, root) then
        set_lock(buf, should_lock(buf, name))
      end
    end
  end
end

local function install_guard()
  if guard_installed then
    return
  end
  guard_installed = true
  local group = vim.api.nvim_create_augroup("CyberdeckWorktreeGuard", { clear = true })
  vim.api.nvim_create_autocmd({ "BufReadPost", "BufNewFile" }, {
    group = group,
    callback = function(args)
      if should_lock(args.buf, vim.api.nvim_buf_get_name(args.buf)) then
        set_lock(args.buf, true)
      end
    end,
  })
end

--- The three commands an opened worktree brings with it, created the first time one is opened.
---
--- This module still installs nothing on load: `listen()` starts a server and does not so much as
--- name a command. But a lock with no way out is a lock the operator routes around, and a change
--- list with no way to read a change is half an answer, so the escape hatch and the diff arrive
--- with the first worktree rather than having to be wired up in advance. They are commands rather
--- than keymaps because a keymap is a key, and which keys are free is the operator's business.
local function install_commands()
  if commands_installed then
    return
  end
  commands_installed = true
  vim.api.nvim_create_user_command("CyberdeckUnlock", function(args)
    M.unlock({ scope = args.bang and "worktree" or "buffer" })
  end, { bang = true, desc = "Unlock this buffer, or with ! every buffer of its worker's worktree" })
  vim.api.nvim_create_user_command("CyberdeckLock", function(args)
    M.lock({ scope = args.bang and "worktree" or "buffer" })
  end, { bang = true, desc = "Put back a lock CyberdeckUnlock lifted" })
  vim.api.nvim_create_user_command("CyberdeckDiff", function()
    M.diff()
  end, { desc = "Diff this file against the baseline its Cyberdeck change list was measured from" })
end

local function ensure_tab(worktree)
  local tab = tabs[worktree]
  if tab ~= nil and vim.api.nvim_tabpage_is_valid(tab) then
    vim.api.nvim_set_current_tabpage(tab)
  else
    vim.cmd("tabnew")
    tab = vim.api.nvim_get_current_tabpage()
    tabs[worktree] = tab
  end
  vim.cmd("tcd " .. vim.fn.fnameescape(worktree))
  return tab
end

--- The list is a location list rather than the quickfix list because the quickfix list is global to
--- the whole nvim instance: opening a second worker would silently replace the first worker's list.
--- A location list belongs to the tab's window, which is the same scope `:tcd` already gives the
--- worktree, so several open worktrees each keep their own.
local function set_list(win, request, action)
  vim.fn.setloclist(win, {}, action, {
    title = request.title,
    items = request.entries or {},
  })
end

local function decode(encoded)
  return vim.json.decode(vim.base64.decode(encoded))
end

--- Every request names the worker it belongs to, and a request that does not is refused rather
--- than guessed at: without the session id two nested worktrees are the same guard to this module,
--- which is the one thing it must never conflate.
local function session_of(request)
  local session = request.session
  if type(session) ~= "string" or session == "" then
    error("request carries no session id; this module and Cyberdeck are out of step")
  end
  return session
end

--- Both entry points answer with a string rather than raising, so a rejected request is
--- distinguishable from a socket nobody is listening on: Cyberdeck reads a nonzero exit as "no
--- server" and an `error:` answer as "the server said no".
local function answer(ok, value)
  if ok then
    return value
  end
  return "error: " .. tostring(value):gsub("\n", " ")
end

--- Put the tab on something the operator can work from.
---
--- The tab starts on the `[No Name]` buffer `:tabnew` creates, and only the first list entry ever
--- displaced it. A worker with nothing to show — a clean branch, a baseline that came up empty, a
--- directory that is not a repository — therefore landed the operator on an empty scratch buffer
--- with no sign of the worktree at all. `:edit <worktree>` is the answer because a directory buffer
--- is whatever the operator's own config makes it: netrw, or whatever replaced netrw. No plugin is
--- named here, and none is required.
---
--- `on_open` comes first and can decline the landing by returning `true`, which is how an operator
--- docks their own explorer instead. Any other return value falls through to the default, so a hook
--- that forgets to return does the harmless thing rather than the invisible one.
---
--- A hook that throws is reported and then ignored. The operator's config is not in a position to
--- cost them the worktree they asked for, and an open that half-happened is worse than one that
--- landed plainly.
local function land(context)
  if on_open ~= nil then
    local ok, handled = pcall(on_open, context)
    if not ok then
      vim.notify("cyberdeck: on_open failed: " .. tostring(handled), vim.log.levels.WARN)
    elseif handled == true then
      return
    end
  end
  if #context.entries > 0 then
    -- The list window comes up as well as being jumped into. A location list that exists but is
    -- not on screen is a review surface the operator has to know to ask for, and the whole point
    -- of the open is to see what the agent changed. `:lfirst` then moves into the first change,
    -- leaving the list beside it — so the tab lands on a change *and* shows the rest of them.
    vim.cmd("silent! lopen")
    vim.cmd("silent! lfirst")
  else
    vim.cmd("edit " .. vim.fn.fnameescape(context.worktree))
  end
end

--- Open one worker's worktree: a new tab scoped to it, the agent's changed files and hunks in that
--- tab's list, and every buffer under it locked while the agent is still running.
---
--- The guard is claimed *before* the tab is landed, and the order is load-bearing. Landing opens
--- files, and `:edit` can fail outright — a reused tab whose buffer has unsaved changes raises E37 —
--- which would abort this function before the guard was ever installed and leave a live worker's
--- files editable. Claiming first means the worst a failed landing costs is the landing.
function M.open(encoded)
  return answer(pcall(function()
    local request = decode(encoded)
    local session = session_of(request)
    local worktree = normalize(request.worktree)
    local baseline = request.baseline or {}
    baselines[worktree] = baseline
    install_commands()
    local tab = ensure_tab(worktree)
    local win = vim.api.nvim_get_current_win()
    set_list(win, request, " ")
    if request.live then
      guarded[session] = worktree
      install_guard()
    else
      guarded[session] = nil
      released[session] = nil
    end
    land({
      session = session,
      worktree = worktree,
      title = request.title,
      live = request.live == true,
      baseline = baseline,
      entries = request.entries or {},
      tab = tab,
      win = win,
    })
    reapply_to_open_buffers(worktree)
    return "ok:" .. tostring(#(request.entries or {}))
  end))
end

--- The worker finished. Replace its list with the final change set and release the lock in the same
--- call, so the operator can never be looking at a finished worker they still cannot edit.
---
--- No tab is created here: if the operator closed the tab, there is nothing to refresh and this
--- worker's guard still has to go, which is why the release does not depend on the tab.
---
--- Only this session's guard is dropped. Buffers another running worker still claims stay locked.
function M.refresh(encoded)
  return answer(pcall(function()
    local request = decode(encoded)
    local session = session_of(request)
    local worktree = normalize(request.worktree)
    local tab = tabs[worktree]
    baselines[worktree] = request.baseline or baselines[worktree] or {}
    if tab ~= nil and vim.api.nvim_tabpage_is_valid(tab) then
      set_list(vim.api.nvim_tabpage_get_win(tab), request, "r")
    else
      tabs[worktree] = nil
    end
    if not request.live then
      guarded[session] = nil
      released[session] = nil
      reapply_to_open_buffers(worktree)
    end
    return "ok:" .. tostring(#(request.entries or {}))
  end))
end

--- Lift the read-only lock a running worker put on this file. The operator's own deliberate act.
---
--- A worktree is locked while an agent can still be writing to it, and the lock exists because
--- agents rewrite whole files rather than editing them: two writers there lose work silently. So
--- the way out is a command the operator types, never something inferred for them, and it is loud
--- about what it just allowed.
---
--- `opts.scope`:
---   * `"buffer"` (default) — this buffer only, recorded on the buffer so a reload keeps it.
---   * `"worktree"` — every file of the worker whose guard is innermost around this one, and every
---     file of theirs opened afterwards, until `lock()` or the worker finishes.
---
--- Returns true when something was unlocked.
function M.unlock(opts)
  opts = opts or {}
  local buf = opts.buf or vim.api.nvim_get_current_buf()
  local name = vim.api.nvim_buf_get_name(buf)
  if opts.scope == "worktree" then
    local session, root = innermost_guard(name)
    if session == nil then
      vim.notify("cyberdeck: no running worker is holding this file", vim.log.levels.INFO)
      return false
    end
    released[session] = true
    reapply_to_open_buffers(root)
    vim.notify("cyberdeck: unlocked " .. root .. " — its worker may still be writing to it", vim.log.levels.WARN)
    return true
  end
  if not is_guarded(name) and vim.b[buf].cyberdeck_unlocked ~= true then
    vim.notify("cyberdeck: this buffer is not locked", vim.log.levels.INFO)
    return false
  end
  vim.b[buf].cyberdeck_unlocked = true
  set_lock(buf, false)
  vim.notify("cyberdeck: unlocked this buffer — its worker may still be writing to it", vim.log.levels.WARN)
  return true
end

--- Put back a lock `unlock()` lifted, on the same two scopes. A file no guard covers any more stays
--- writable: this restores the derivation, it does not invent a lock of its own.
function M.lock(opts)
  opts = opts or {}
  local buf = opts.buf or vim.api.nvim_get_current_buf()
  local name = vim.api.nvim_buf_get_name(buf)
  if opts.scope == "worktree" then
    local session, root = innermost_guard(name)
    if session == nil then
      vim.notify("cyberdeck: no running worker claims this file", vim.log.levels.INFO)
      return false
    end
    released[session] = nil
    reapply_to_open_buffers(root)
    return true
  end
  vim.b[buf].cyberdeck_unlocked = nil
  set_lock(buf, is_guarded(name))
  return true
end

--- Show this file against the baseline its change list was measured from.
---
--- The change list says which files moved and where; this says what moved in one of them, in
--- nvim's own diff mode against a scratch copy of the baseline revision. It names no plugin and
--- needs none — an operator with a git wrapper they prefer has `ctx.baseline.rev` in `on_open` and
--- should use it instead.
---
--- Cyberdeck resolves the baseline to an object name rather than a ref, so this diff is the one the
--- list described even if the branch has moved since. When the rung had no baseline at all there is
--- nothing to diff against, and that is said rather than guessed around.
---
--- A file that did not exist at the baseline diffs against an empty buffer, which is the truth: all
--- of it is new. A `git show` that fails for any other reason looks the same, and the scratch
--- buffer's name carries the revision so the operator can see what was asked for.
function M.diff()
  local buf = vim.api.nvim_get_current_buf()
  local name = vim.api.nvim_buf_get_name(buf)
  if name == "" or vim.bo[buf].buftype ~= "" then
    vim.notify("cyberdeck: not a file buffer", vim.log.levels.INFO)
    return false
  end
  local worktree = innermost_worktree(normalize(name))
  if worktree == nil then
    vim.notify("cyberdeck: this file is not in a worktree Cyberdeck opened", vim.log.levels.INFO)
    return false
  end
  local baseline = baselines[worktree] or {}
  if type(baseline.rev) ~= "string" or baseline.rev == "" then
    vim.notify(
      "cyberdeck: no baseline to diff against (" .. tostring(baseline.label or "unknown") .. ")",
      vim.log.levels.WARN
    )
    return false
  end
  local relative = normalize(name):sub(#worktree + 2)
  local shown = vim.system(
    { "git", "--no-optional-locks", "-C", worktree, "show", baseline.rev .. ":" .. relative },
    { text = true }
  ):wait()
  local lines = {}
  if shown.code == 0 then
    lines = vim.split(shown.stdout or "", "\n", { plain = true })
    -- A trailing newline splits into one empty last element; keeping it would show a change the
    -- file does not have.
    if #lines > 0 and lines[#lines] == "" then
      table.remove(lines)
    end
  end
  local scratch = vim.api.nvim_create_buf(false, true)
  vim.bo[scratch].buftype = "nofile"
  vim.bo[scratch].bufhidden = "wipe"
  vim.bo[scratch].swapfile = false
  vim.api.nvim_buf_set_lines(scratch, 0, -1, false, lines)
  vim.bo[scratch].filetype = vim.bo[buf].filetype
  vim.bo[scratch].modifiable = false
  pcall(vim.api.nvim_buf_set_name, scratch, "cyberdeck://" .. baseline.rev:sub(1, 12) .. "/" .. relative)
  local origin = vim.api.nvim_get_current_win()
  vim.cmd("leftabove vsplit")
  vim.api.nvim_win_set_buf(vim.api.nvim_get_current_win(), scratch)
  vim.cmd("diffthis")
  vim.api.nvim_set_current_win(origin)
  vim.cmd("diffthis")
  return true
end

--- The socket address Cyberdeck will look for, derived from this nvim's own tmux pane.
--- Returns nil outside tmux, which is the one case where Cyberdeck cannot address this nvim at all.
function M.server_address(pane_id)
  pane_id = pane_id or vim.env.TMUX_PANE
  if type(pane_id) ~= "string" then
    return nil
  end
  local index = pane_id:match("^%%(%d+)$")
  if index == nil then
    return nil
  end
  return SOCKET_PREFIX .. tostring(uv.getuid()) .. "/pane-" .. index .. ".sock"
end

--- Start serving Cyberdeck on this pane's address. Call it once from your own config.
---
--- A socket left behind by an nvim that was killed rather than quit would make `serverstart` fail
--- for the rest of that pane's life, so a stale one is removed first. Nothing else in this module
--- runs until Cyberdeck connects.
---
--- `opts.on_open` is the one thing configurable here: a function called with the request's context
--- once the tab and its list exist, returning `true` if it landed the tab itself. `listen()` with no
--- arguments is unchanged and remains the whole contract for an operator who wants none of this.
--- See `contrib/nvim/README.md`.
---
--- A non-function `on_open` is refused at config time rather than at the first open, because a
--- config error the operator sees when they reload is worth far more than one that surfaces hours
--- later as a rejected request from a worker.
function M.listen(opts)
  opts = opts or {}
  if opts.on_open ~= nil and type(opts.on_open) ~= "function" then
    error("cyberdeck.listen: on_open must be a function, got " .. type(opts.on_open))
  end
  on_open = opts.on_open
  local address = M.server_address()
  if address == nil then
    return nil
  end
  vim.fn.mkdir(vim.fn.fnamemodify(address, ":h"), "p", "0700")
  if uv.fs_stat(address) ~= nil then
    uv.fs_unlink(address)
  end
  return vim.fn.serverstart(address)
end

return M
