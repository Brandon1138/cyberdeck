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

### A SIGKILL can leave Fleet's window hook pointing at an old binary

Opting into `/nvim-settings on` installs window-scoped `pane-exited` and `after-kill-pane` hooks whose
background command names the Node executable and Cyberdeck module Fleet was started with. Clean
Fleet shutdown and `/nvim-settings off` remove them, and their rebalance command is deliberately
inert once the saved Fleet process identity is gone. A SIGKILL cannot run that cleanup, though, so
the inert hooks remain attached to a surviving window. If Cyberdeck later moves, tmux will still try
the old path on each pane exit.

Deferred because the operator's global install is a symlink whose path stays stable across builds,
and a stale hook neither resizes nor prints when Fleet's pane is absent. **Trigger:** moving or
replacing that global symlink path while keeping a SIGKILL-surviving Fleet window. The fix is durable
hook ownership and reconciliation, not a global tmux hook or another executable-path guess.

### Ctrl+S only hands back a cwd when the login shell is zsh

`src/tmux/interactive-shell.ts` opens `$SHELL -li` in a `tmux display-popup` and learns where the
operator ended up from a zsh `zshexit`/`chpwd` hook installed through a one-file `ZDOTDIR`. A popup
is **not a pane** — `list-panes -a` omits it, and `#{pane_current_path}` read inside one reports the
*launching* pane's directory — so there is no tmux-side answer to fall back on. A non-zsh `$SHELL`
gets the popup and no capture: Fleet's spawn cwd is simply left where it was.

Deferred because the operator's shell is zsh. **Trigger:** changing `$SHELL` to bash or fish. The
fix is that shell's own exit hook (`PROMPT_COMMAND`, `fish_exit`) writing the same file, not a wrapper
REPL and not a pane query that cannot see the popup.

### Cursor and Antigravity model columns can only ever be launch values

Fleet reads a session's running model out of the provider's own transcript — Claude's JSONL names
it on every assistant frame, Codex's rollout names it on every `turn_context`. Cursor and
Antigravity write no native transcript at all; Cyberdeck already falls back to terminal replay for
their *turns*, and a screen scrape cannot say which model produced it. So a Cursor or Antigravity
row shows the model the session was launched with, marked `~` to say exactly that.

Deferred because there is nothing to read: this is not an unimplemented parser, it is a provider
that records nothing. **Trigger:** either CLI gaining a session log that names its model. The fix is
a parser in `src/runtime/observed-model.ts` and a row in `observedModelParser`, not a heuristic over
pane bytes.

### A provider's model list is only as current as its CLI on the broker's PATH

`WorkerCapabilityCatalog` runs `agent models` and `agy models` — read-only listings — and caches
each answer for five minutes. A provider with no listing command, a CLI missing from the broker's
PATH, or a listing that times out falls back to the static catalog in `worker-capabilities.ts`,
carrying `source: "fallback-catalog"` and the reason, which Fleet prints above the list and the MCP
tool returns to orchestrators. That fallback is a snapshot with a date on it, never a claim about
the present.

Deferred because the operator's `agent` and `agy` are installed and on PATH. **Trigger:** running
the broker somewhere those CLIs are absent, or a provider changing its listing format. The fix is a
row in `PROVIDER_MODEL_LISTING_COMMANDS` and a parser case, not widening the accepted line shapes
until prose starts parsing as a model id.

## Things that are not deferred

- A peer binding is a controller, and its grant and its lease are derived from one place. MIK-98
  settled what a `:peer:` binding is: a controller in its own right, holding its own `controllerId`
  inside its primary's `familyId`, durable because its key is durable in the binding log. Every
  binding the manager grants gets exactly `ORCHESTRATOR_GRANT_CAPABILITIES`, and
  `orchestratorController()` in `src/domain/orchestrator.ts` is **total** over bindings — there is no
  binding that can be granted a capability the lease substrate would then refuse. That totality is
  the invariant, not an implementation detail: it is what stops `thread.enqueue`, `worker_ctl`, and
  `worker_events` from ever again disagreeing about the same binding, which is what the MIK-71
  incident was. Do not add a second derivation of a controller identity from a binding, and do not
  re-introduce a per-tool refusal of peer keys; if peer authority should narrow, narrow the one
  capability list.

- A directed handoff is the operator's own authority, and it is atomic. Fleet's ctrl+d marks
  workers and `/handoff` names a live Orc and a directive; the broker moves every named lease onto
  that Orc's controller identity or moves none, in one fsynced append that also carries the durable
  handoff record. There is no token in that call, deliberately: the previous holder may be dead or
  unwilling, and what fences it out is the same thing that fences every other transfer —
  `withNewController` bumps the lease version and replaces the token hash, so the old holder's next
  authenticated call gets the ordinary stale-lease answer. A worker the substrate has never seen —
  one the operator started by hand — is registered *inside* that same transaction rather than
  before it, so an aborted batch leaves no half-created subject and no row Fleet would draw as
  adoptable. The directive reaches the recipient twice over: a best-effort composer nudge, and the
  pending record `worker_events` returns and marks spent. Do not add a per-tool refusal, a partial
  transfer path, or a second way to move a lease.

- A thread's pull-request indicator is attributed to **the branch that thread's own work lands on**,
  never to the directory it runs in. A thread declares that branch through its `workspace`, or it
  inherits one by running in a linked worktree, which exists precisely because one piece of work
  needed its own branch. A thread in a repository's *primary* checkout that declared no branch gets
  no indicator, even when that checkout has an open pull request: the checkout has one branch and
  every thread there shares it, so crediting any single thread with it is a guess. Losing the
  indicator in that case is the fix, not a gap in it — it is what MIK-86 was. Dispatch with a
  declared `workspace` if a thread needs the indicator.

- Which half of the nvim surface owns what — Cyberdeck's `src/nvim/` and the shipped Lua module
  versus the operator's own nvim config — is written down in `docs/architecture/nvim-surface.md`.
  Read it before adding presentation to either side: landing, docking, diff rendering, and keymaps
  are the config's, and `on_open(ctx)` is the seam that hands them what they need.

- When Fleet's window has no nvim, one is spawned into that same window — and nowhere else. No
  window other than Fleet's is searched and no socket directory is scanned; both would open a
  worktree somewhere the operator is not looking. The absence of guessing is not a gap to close.
  An nvim that is running but never called `listen()` is reported, not spawned over.
- nvim is driven with `--remote-expr`, never `--remote-send`. Injected keystrokes land in whatever
  mode the operator's buffer happens to be in and can fire mappings.
