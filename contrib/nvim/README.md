# Cyberdeck's nvim module

`lua/cyberdeck/init.lua` is the nvim side of Fleet's Ctrl+N. Cyberdeck opens a worker's worktree in
the nvim running in Fleet's own tmux window, drops the worker's changes into that tab's location
list, and holds every buffer under the worktree read-only while the agent is still writing to it.

The module ships in this repository rather than as a plugin because it and `src/nvim/` version
together: the RPC socket convention is mirrored by hand across `src/nvim/server-address.ts` and this
file, and a skew between them strands every open request on a socket nobody is listening to. See
CLAUDE.md for what that means for running Cyberdeck from anywhere other than this checkout.

## Installing

Point your plugin manager at the checkout. With lazy.nvim:

```lua
{
  dir = vim.fn.expand("~/code/personal/cyberdeck/contrib/nvim"),
  cond = function()
    return vim.uv.fs_stat(vim.fn.expand("~/code/personal/cyberdeck/contrib/nvim")) ~= nil
  end,
  config = function()
    require("cyberdeck").listen()
  end,
}
```

The `cond` guard is what keeps a machine without the checkout silent rather than broken.

## `listen(opts)`

Starts the RPC server on this pane's socket. It is the whole contract: the module installs no
keymaps and no commands, and the one autocommand it creates is created the first time a worktree is
opened, not on load.

Outside tmux it returns `nil` and does nothing — the socket address is derived from `$TMUX_PANE`,
so there is no address to serve on.

| option    | type       | default | meaning                                        |
| --------- | ---------- | ------- | ---------------------------------------------- |
| `on_open` | `function` | none    | Your own landing for a freshly opened worktree. |

`listen()` with no arguments behaves exactly as it always has. A non-function `on_open` is an error
at config time, not at the first open.

## The `on_open` contract

`on_open(ctx)` is called once per `open` request, after the tab exists, after `:tcd` has scoped it
to the worktree, and after the location list has been filled — so everything it might want to act
on is already true when it runs.

`ctx` is a table:

| field      | type      | meaning                                                             |
| ---------- | --------- | ------------------------------------------------------------------- |
| `session`  | `string`  | The worker's session id. Nested worktrees share paths; ids do not.  |
| `worktree` | `string`  | Absolute, normalised, no trailing slash. The tab's cwd.             |
| `title`    | `string`  | The list title, including which baseline the changes were taken from. |
| `live`     | `boolean` | True while the worker can still be writing to the worktree.         |
| `entries`  | `table`   | The location-list items, as sent. May be empty.                     |
| `tab`      | `number`  | The tabpage handle for this worktree.                               |
| `win`      | `number`  | The window the location list belongs to.                            |

**Return `true` if you landed the tab yourself.** Any other return value — including no return at
all — means Cyberdeck lands it, so a hook that forgets to return does the harmless thing rather
than the invisible one.

A hook that throws is reported with `vim.notify` and then ignored: Cyberdeck lands the tab as if
there were no hook. Your config is not in a position to cost you the worktree you asked for.

### What Cyberdeck does without a hook

- With entries: `:lfirst`, landing on the first change.
- With no entries: `:edit <worktree>`, so the tab shows the worktree as a directory buffer rather
  than the empty `[No Name]` buffer `:tabnew` left behind. Which explorer that is depends entirely
  on your config — this module names no plugin.

An empty list is a normal outcome, not a failure. The list title says which baseline produced it:
`since origin/main`, `uncommitted only`, `no baseline`, or `not a git repository`.

### Example: dock snacks.nvim's explorer on the worktree

In your own `plugins/cyberdeck.lua`:

```lua
require("cyberdeck").listen({
  on_open = function(ctx)
    Snacks.explorer({
      cwd = ctx.worktree,
      layout = { layout = { position = require("config.tmux").sidebar_side() } },
    })
  end,
})
```

This returns nothing, so Cyberdeck still lands the tab on the first change (or on the worktree when
there is none) with the explorer docked beside it. Return `true` from the hook if you want the
explorer to be the only thing that happens.
