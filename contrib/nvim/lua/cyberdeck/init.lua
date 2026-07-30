--- Cyberdeck's nvim side.
---
--- This module is inert until Cyberdeck calls it. It installs no keymaps and no commands, and the
--- single autocommand it does install is created the first time a worktree is opened, not on load.
--- The operator's own config needs one line: `require("cyberdeck").listen()`.
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

--- worktree -> true while the worker owning it is still running. This is what the buffer guard
--- consults, so a file opened long after the initial request is protected on the same terms as one
--- that was already open.
local guarded = {}

local guard_installed = false

local function normalize(path)
  local normalized = vim.fs.normalize(path)
  return normalized:sub(-1) == "/" and normalized:sub(1, -2) or normalized
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

local function apply_to_open_buffers(root, locked)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and is_under(vim.api.nvim_buf_get_name(buf), root) then
      set_lock(buf, locked)
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
      local name = vim.api.nvim_buf_get_name(args.buf)
      for root in pairs(guarded) do
        if is_under(name, root) then
          set_lock(args.buf, true)
          return
        end
      end
    end,
  })
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

--- Both entry points answer with a string rather than raising, so a rejected request is
--- distinguishable from a socket nobody is listening on: Cyberdeck reads a nonzero exit as "no
--- server" and an `error:` answer as "the server said no".
local function answer(ok, value)
  if ok then
    return value
  end
  return "error: " .. tostring(value):gsub("\n", " ")
end

--- Open one worker's worktree: a new tab scoped to it, the agent's changed files and hunks in that
--- tab's list, and every buffer under it locked while the agent is still running.
function M.open(encoded)
  return answer(pcall(function()
    local request = decode(encoded)
    local worktree = normalize(request.worktree)
    ensure_tab(worktree)
    local win = vim.api.nvim_get_current_win()
    set_list(win, request, " ")
    if #(request.entries or {}) > 0 then
      vim.cmd("silent! lfirst")
    end
    if request.live then
      guarded[worktree] = true
      install_guard()
    else
      guarded[worktree] = nil
    end
    apply_to_open_buffers(worktree, request.live == true)
    return "ok:" .. tostring(#(request.entries or {}))
  end))
end

--- The worker finished. Replace its list with the final change set and release the lock in the same
--- call, so the operator can never be looking at a finished worker they still cannot edit.
---
--- No tab is created here: if the operator closed the tab, there is nothing to refresh and the
--- release still has to happen, which is why the lock is lifted unconditionally.
function M.refresh(encoded)
  return answer(pcall(function()
    local request = decode(encoded)
    local worktree = normalize(request.worktree)
    local tab = tabs[worktree]
    if tab ~= nil and vim.api.nvim_tabpage_is_valid(tab) then
      set_list(vim.api.nvim_tabpage_get_win(tab), request, "r")
    else
      tabs[worktree] = nil
    end
    if not request.live then
      guarded[worktree] = nil
      apply_to_open_buffers(worktree, false)
    end
    return "ok:" .. tostring(#(request.entries or {}))
  end))
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
function M.listen()
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
