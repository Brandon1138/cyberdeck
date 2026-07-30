# Working in this repository

`BUGS.md` opens with **Standing constraints** — properties of the terminal that are never safe to
re-litigate. Read that section before touching key handling. This file is for something different:
limitations we know about, chose not to fix, and must not silently rediscover later.

## Deferred limitations

These are accepted, deliberate gaps. Do not treat them as bugs to fix on sight, and do not design
around them as if they were already solved. Each one names the trigger that would make it real work.
If a task runs into one, say so out loud to the operator before building past it.

### The nvim module is found by a hardcoded local path

`contrib/nvim/lua/cyberdeck/` ships in this repository, and the operator's nvim config points at it
with an absolute `dir=` path (guarded, so a machine without the checkout is silent rather than
broken). This was chosen so Fleet's Ctrl+N and the Lua it drives version together — the RPC socket
convention is mirrored by hand across `src/nvim/server-address.ts` and the Lua module, and a skew
between them strands every open request on a socket nobody is listening to.

**That version-lock is conditional, not guaranteed.** It holds only while Cyberdeck is run from the
same checkout the nvim path points at. Running an installed binary, or a worktree, or a second
clone, silently pairs a new Cyberdeck with whatever Lua that one path happens to hold. Nothing
detects this today: there is no version handshake in the RPC call.

Deferred because the operator runs one checkout. **Trigger:** running Cyberdeck from somewhere other
than the checkout the nvim config points at. The fix is a version handshake in the `--remote-expr`
payload that fails loudly on mismatch, not more path-guessing.

### One socket namespace for all concurrent Cyberdecks

`nvimServerAddress` keys the socket on the tmux pane index alone:
`/tmp/cyberdeck-nvim-<uid>/pane-<n>.sock`. The uid separates operators on a shared host. Nothing
separates two Cyberdecks run by the *same* operator — a personal and a work instance in different
tmux sessions can land on the same pane index and therefore the same socket, and the second
`listen()` would take over the first's address.

Deferred because the operator runs one Cyberdeck at a time. **Trigger:** a second concurrent
Cyberdeck, which the operator has already flagged as plausible on an employer-provided machine. The
fix is to key the namespace on something that distinguishes instances — the tmux server socket or
the broker's own identity — not on the pane alone.

### A worktree with no `origin/HEAD` gets no baseline at all

`src/nvim/worktree-changes.ts` resolves the default branch from `refs/remotes/origin/HEAD` and
diffs the working tree against `merge-base(<default>, HEAD)`. When that ref does not resolve — a
`git init` repository with no remote, a clone whose `origin/HEAD` was never set, a repository whose
default branch lives somewhere other than `origin` — there is no third guess. The list is the
untracked files and nothing else, and the title says `no baseline`.

Two rungs were deliberately left off the ladder. `@{upstream}` is the bug this replaced, not a
fallback: once a worker's branch is pushed, its upstream is `origin/<that same branch>`, so the
merge base is HEAD and the diff is empty by construction — the whole point of reading `origin/HEAD`
instead. `HEAD~1` and friends guess at how many commits count as "the worker's work", which is a
number nothing here knows.

Deferred because every repository the operator dispatches workers into is a clone with
`origin/HEAD`. **Trigger:** a worker in a repository without one — most plausibly a scratch repo
created on the fly, or a clone made with a tool that does not set the symref. The fix is to ask the
operator for the base ref for that worktree and record it, not to widen the guessing.

## Things that are not deferred

- When Fleet's window has no nvim, one is spawned into that same window — and nowhere else. No
  window other than Fleet's is searched and no socket directory is scanned; both would open a
  worktree somewhere the operator is not looking. The absence of guessing is not a gap to close.
  An nvim that is running but never called `listen()` is reported, not spawned over.
- nvim is driven with `--remote-expr`, never `--remote-send`. Injected keystrokes land in whatever
  mode the operator's buffer happens to be in and can fire mappings.
