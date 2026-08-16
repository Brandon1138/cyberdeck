# Cyberdeck's nvim module

`lua/cyberdeck/init.lua` is the nvim side of Fleet's Ctrl+N. Cyberdeck opens a directory — a worker's
worktree from its row, or a repository's main checkout from its folder header — in the nvim running
in Fleet's own tmux window, drops what changed there into that tab's location list, and holds every
buffer under a running worker's worktree read-only while the agent is still writing to it.

The module ships in this repository rather than as a plugin because it and `src/nvim/` version
together: the RPC socket convention is mirrored by hand across `src/nvim/server-address.ts` and this
file, and a skew between them strands every open request on a socket nobody is listening to. See
CLAUDE.md for what that means for running Cyberdeck from anywhere other than this checkout.

Which half decides what — Cyberdeck or your config — is written down in
[`docs/architecture/nvim-surface.md`](../../docs/architecture/nvim-surface.md). Short version:
Cyberdeck decides what is true, this module enforces it, and your config decides what it looks like.

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
keymaps, and the commands and the autocommand it creates are created the first time a worktree is
opened, not on load. Nothing is bound to a key — which keys are free is your business.

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
| `session`  | `string`  | The worker's session id, or `checkout:<path>` for a repository's main checkout. Nested worktrees share paths; ids do not. |
| `worktree` | `string`  | Absolute, normalised, no trailing slash. The tab's cwd.             |
| `title`    | `string`  | The list title, including which baseline the changes were taken from. |
| `live`     | `boolean` | True while the worker can still be writing to the worktree.         |
| `baseline` | `table`   | `{ kind, label, rev? }` — what the changes were measured against, and the commit it resolved to. |
| `entries`  | `table`   | The location-list items, as sent. May be empty.                     |
| `tab`      | `number`  | The tabpage handle for this worktree.                               |
| `win`      | `number`  | The window the location list belongs to.                            |

`baseline.kind` is one of `fork-point`, `uncommitted`, `none`, or `not-a-repo`, and `baseline.rev`
is present only on the first two — the other two have nothing to compare against. The revision is a
resolved object name rather than a ref, so it keeps answering the same way after the branch moves.
It is the seam for a config that would rather render a change with its own git wrapper than with
`:CyberdeckDiff`.

**Return `true` if you landed the tab yourself.** Any other return value — including no return at
all — means Cyberdeck lands it, so a hook that forgets to return does the harmless thing rather
than the invisible one.

A hook that throws is reported with `vim.notify` and then ignored: Cyberdeck lands the tab as if
there were no hook. Your config is not in a position to cost you the worktree you asked for.

### What Cyberdeck does without a hook

- With entries: `:lopen` then `:lfirst`, so the change list is visible and the cursor is on the
  first change. The list is most of the point of the open; landing on a change without showing what
  else changed hides the answer the operator came for.
- With no entries: `:edit <worktree>`, so the tab shows the worktree as a directory buffer rather
  than the empty `[No Name]` buffer `:tabnew` left behind. Which explorer that is depends entirely
  on your config — this module names no plugin.

An empty list is a normal outcome, not a failure. The list title says which baseline produced it:
`since origin/main`, `uncommitted only`, `no baseline`, or `not a git repository`.

## Read-only, and the way out of it

Every buffer under a running worker's worktree opens `nomodifiable`. Agents rewrite whole files
rather than editing them, so an operator edit made beside one is not merged, it is lost — silently,
by whichever side writes second. `readonly` alone only warns; `nomodifiable` is what makes the rule
hold.

The lock is derived, never assigned: each buffer's state is recomputed from the guards standing at
that moment. So a worktree nested inside another worker's stays locked by the outer one, and a
worker finishing frees only the buffers no surviving guard covers. Cyberdeck lifts the guard itself
when the worker reaches a terminal state, in the same message that delivers the final change list.

Until then, the way out is something you type:

| command             | effect                                                                      |
| ------------------- | --------------------------------------------------------------------------- |
| `:CyberdeckUnlock`  | Unlock this buffer. Recorded on the buffer, so a reload keeps it.           |
| `:CyberdeckUnlock!` | Unlock every file of the worker whose guard is innermost around this one, including files opened afterwards. |
| `:CyberdeckLock`    | Put back a lock `:CyberdeckUnlock` lifted, on this buffer.                  |
| `:CyberdeckLock!`   | Same, for the whole worktree.                                               |
| `:CyberdeckDiff`    | Diff this file against the baseline its change list was measured from.      |

Both unlock scopes say out loud that the worker may still be writing. A worktree release survives a
reopen — a reopen is Cyberdeck refreshing the list, not you changing your mind — and ends when the
worker does. There is no automatic unlock and no "unlock if the worker looks idle": a worker between
turns is still a worker that will write.

The commands are created the first time a worktree is opened. The same functions are public, if you
would rather bind them: `require("cyberdeck").unlock({ scope = "buffer" | "worktree", buf = ? })`,
`.lock(opts)` with the same shape, and `.diff()`. Each returns `true` when it did something.

`:CyberdeckDiff` reads `git show <baseline.rev>:<path>` into a scratch buffer and turns on nvim's own
diff mode against it. It names no plugin and needs none. A file that did not exist at the baseline
diffs against an empty buffer, which is the truth — all of it is new. On the `none` and `not-a-repo`
rungs there is no revision, and it says so rather than guessing one.

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
