# The nvim surface

Fleet's Ctrl+N opens a directory in the nvim running in Fleet's own tmux window. Two pieces of
software have to agree for that to work: Cyberdeck, in `src/nvim/`, and the Lua module in
`contrib/nvim/lua/cyberdeck/`. They ship in the same repository and version together, but only one
of them is Cyberdeck's — the operator's own nvim config is the third party here, and most of what
an open *looks* like is theirs.

This document exists because that line was previously implied by two codebases rather than written
down anywhere, and each side could reasonably assume the other did a thing neither did.

## The one-line rule

**Cyberdeck decides what is true. The nvim side decides what it looks like.**

Truth is: which directory, whose it is, whether anything is still writing to it, what changed in it
and what that was measured from. Appearance is: which window the list sits in, what an explorer
docks where, how a diff is rendered, and which key does any of it.

## What each side owns

| Concern | Owner | Where |
| --- | --- | --- |
| Socket address convention | Cyberdeck, mirrored by hand | `src/nvim/server-address.ts` ↔ `init.lua`'s `SOCKET_PREFIX` |
| Finding or spawning the nvim to talk to | Cyberdeck | `src/nvim/pane.ts` — Fleet's window only, never another |
| RPC transport | Cyberdeck | `src/nvim/bridge.ts` — `--remote-expr` only, never `--remote-send` |
| Payload shape | Cyberdeck | `src/nvim/quickfix.ts` |
| Which baseline the changes are measured from | Cyberdeck | `src/nvim/worktree-changes.ts` |
| Resolving that baseline to a commit | Cyberdeck | `baseline.rev` in the same file |
| Whether the buffers open locked | Cyberdeck | `live`, from the worker's execution state |
| Lifting the lock when the worker finishes | Cyberdeck | `src/broker/nvim-binding-service.ts` |
| Enforcing the lock on buffers | the module | `init.lua`'s guard autocommand |
| Letting the operator out of the lock | the module | `unlock()` / `:CyberdeckUnlock` |
| Where the tab lands and what is docked beside it | the operator's config | `listen({ on_open = … })` |
| How a change is rendered | the operator's config, with a plain default | `diff()` / `:CyberdeckDiff` |
| Keymaps | the operator's config | nothing here binds a key |

## What an open sends

One base64-encoded JSON object per call, to `open` or `refresh`:

| Field | Meaning |
| --- | --- |
| `session` | Who this request is about. A worker's session id, or `checkout:<path>` for a repository's primary checkout. |
| `worktree` | Absolute path the tab is scoped to. |
| `title` | The list title, baseline phrase included. Written to be read. |
| `live` | True while a provider process can still be writing to `worktree`. |
| `baseline` | `{ kind, label, rev? }` — the rung that produced the list, and the commit it resolved to. Written to be acted on. |
| `entries` | Location-list items with absolute filenames. |

`session` is the identity everything on the nvim side is keyed by, and it is never a path: worktrees
nest, so a worker in `~/code/x/worktrees/y` is inside another worker's `~/code/x` and the two are
indistinguishable by prefix. A main checkout has no session, so it sends its path under the
`checkout:` prefix — a shape no session id can take, because ids are UUIDs. A checkout that reused a
worker's id would release that worker's files.

## Read-only, and the way out of it

A live worktree is not a place two writers can share. Agents commonly rewrite whole files rather
than editing them, so a concurrent operator edit is not merged, it is lost — silently, by whichever
side writes second. So every buffer under a running worker's worktree opens `nomodifiable`.
`readonly` alone only warns; `nomodifiable` is what makes the rule hold.

Three things about that lock are deliberate:

- **It is derived, never assigned.** The module recomputes each buffer's lock from the guards
  standing at that moment, so a released worktree frees only the buffers no surviving guard covers.
  This is also why opening a main checkout that a live worker happens to be running *in* still lands
  read-only: the request says `live: false`, and the worker's own guard says otherwise, and the
  guard wins.
- **It is lifted by the worker finishing, not by a timer.** `NvimBindingService` watches the one
  transition that matters and sends the final change set and the release as a single `refresh`.
- **The operator can override it, explicitly.** `:CyberdeckUnlock` unlocks the current buffer;
  `:CyberdeckUnlock!` unlocks the whole worktree of the innermost worker claiming it, including
  files opened afterwards. Both are loud about what they just allowed. `:CyberdeckLock` puts the
  lock back. A release is sticky across a reopen — a reopen is Cyberdeck refreshing a list, not the
  operator changing their mind — and ends when the worker does.

There is no automatic unlock, and no "unlock if the worker looks idle". A worker between turns is
still a worker that will write.

## Changes against the baseline

`worktree-changes.ts` picks the baseline the agent's work is visible against — the fork point from
`refs/remotes/origin/HEAD`, or uncommitted-only, or nothing at all — and sends both what to call it
and which commit it is. The commit matters: a label lets nvim *say* `since origin/main`, but only a
resolved object name lets it *show* a file against that point, and only a resolved one keeps
answering the same way after the branch moves.

Cyberdeck does not render the diff. The module's `:CyberdeckDiff` is a floor, not a policy: it reads
`git show <rev>:<path>` into a scratch buffer and turns on nvim's own diff mode, naming no plugin
and requiring none. An operator with a git wrapper they prefer has `ctx.baseline.rev` in `on_open`
and should use it instead — that is the seam, and it is why the revision is in the payload at all.

The gaps in the baseline ladder are documented in `CLAUDE.md` as deferred, not fixed here: a
repository with no `origin/HEAD` gets no baseline, no `@{upstream}` fallback and no `HEAD~1` guess,
and `:CyberdeckDiff` says so rather than inventing one.

## Where the paths are compared

Both sides resolve symlinks before comparing paths. nvim resolves them when it names a buffer, and
Cyberdeck sends the path Fleet knows the worktree by; on macOS `/tmp` and `/var` are symlinks, so
those two spellings of one directory share no prefix and a guard comparing them would cover
nothing. `normalize()` in `init.lua` resolves both sides — and resolves the parent directory for a
file that does not exist yet, which is the `BufNewFile` case the guard has to catch before the
first write.

## What Cyberdeck will not do

- Spawn nvim anywhere but Fleet's own window, or scan socket directories for one. Either would open
  a worktree somewhere the operator is not looking.
- Send keystrokes. `--remote-send` lands in whatever mode the operator's buffer is in and can fire
  their mappings.
- Install a keymap. The module creates its three commands the first time a worktree is opened, and
  binds no key to any of them.
