# Cyberdeck

[![CI](https://github.com/Brandon1138/cyberdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/Brandon1138/cyberdeck/actions/workflows/ci.yml)
[![npm prerelease](https://img.shields.io/npm/v/%40ishmael38%2Fcyberdeck/next.svg)](https://www.npmjs.com/package/@ishmael38/cyberdeck)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Cyberdeck is a neutral local broker for durable Codex, Claude, Cursor, and Antigravity terminal sessions. Provider processes run in broker-owned PTYs, so they can move between attached/interactive and detached/headless presentation without being restarted. tmux is an optional cockpit view, not the session owner.

> **Stop and detach are different.** `cyberdeck stop <session-id>` terminates the selected provider process and, for an orchestrator, its owned worker tree. Pressing `Ctrl-]`, closing an attached terminal, or closing a tmux pane only detaches that view; the session keeps running while the broker is alive. In Fleet, `Ctrl-]` reattaches the exact most recently explicitly detached live session.

> **Alpha software.** `0.1.0-alpha.1` is a macOS developer preview. Persisted schemas and provider compatibility may change before the first stable release.

## Requirements and installation

Cyberdeck requires macOS and Node.js 24.18 or newer in the Node 24 release line. Install and authenticate each provider CLI you intend to use. The cockpit also requires the native system `tmux` binary; Cyberdeck does not bundle, build, silently install, or emulate tmux. The plain Fleet remains usable without it.

Install the public prerelease from npm:

```bash
npm install --global @ishmael38/cyberdeck@next
cyberdeck
```

For source development, the repository pins Node 24.18.0 through mise and pnpm 11.5.0 through Corepack:

```bash
git clone https://github.com/Brandon1138/cyberdeck.git
cd cyberdeck
mise install
mise exec -- corepack enable
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm build
mise exec -- pnpm dev
```

Run `cyberdeck` with no arguments to start the broker when needed and open the interactive fleet.

Cyberdeck is an independent open-source project. It is not affiliated with,
endorsed by, or sponsored by OpenAI, Anthropic, Cursor, or Google. Provider
product names are used only to describe interoperability.

## Broker and cockpit

```bash
cyberdeck broker start
cyberdeck broker status
cyberdeck broker restart
cd /path/to/your/project
cyberdeck cockpit --orchestrator codex --model gpt-5.6-sol --effort high
cyberdeck list
```

The first cockpit launch requires an explicit orchestrator provider, with optional provider-native
model and effort. It creates a workspace-namespaced native tmux session with the interactive Fleet
in the left pane and a broker-owned orchestrator attachment in the right pane. The orchestrator
binding itself defaults to one fleet-wide singleton, so later launches from any directory reuse it
and it can coordinate workers in every repository. The launch directory remains only the initial
Fleet/composer context. Use `--scope workspace` when deliberate single-directory isolation is
required.

Create, split, or close panes freely; the broker, not tmux, owns every provider session. tmux is
preflighted with `tmux -V` before an orchestrator is created or resumed. A missing binary produces an
installation error before any provider starts. Outside tmux, cockpit uses `attach-session`; when
`$TMUX` is set, it keeps the inherited native tmux server and uses `switch-client` to avoid a nested
client. Workspace-namespaced `cyberdeck-*` session names are unchanged.

Cockpit presentation is transactional. If this invocation creates a tmux cockpit and its pane setup
or final attach/switch fails, Cyberdeck removes only that newly created cockpit. A pre-existing
cockpit, the user's `main` session, and the tmux server are never rollback targets. If this invocation
also created the broker-owned orchestrator, it is stopped; a reused orchestrator is preserved. Any
rollback failure is reported after the original presentation error. Ordinary detach and pane close
operations still never stop a provider.

`cyberdeck dashboard` groups durable agent threads by project. Every row shows the thread name,
friendly model and effort, truthful attention status, normalized assistant preview, and relative
meaningful activity time. It never ranks providers or chooses a model.

Fleet controls:

- `Ctrl+O`: open the orchestrator switcher. Its first section lists only live interactive
  orchestrators and labels controller-held sessions as in use; selecting an available row focuses
  that exact session in the multiplexed cockpit. Its second section creates a new peer from an
  explicit model and provider-supported effort, then adds and focuses another cockpit pane without
  replacing or stopping the current orchestrator.
- `Up` / `Down`: select a thread.
- `Right`, or `Enter` while the bottom composer is empty: open the selected provider TUI. A live
  thread attaches to its existing PTY; a terminal thread resumes that exact provider-native
  conversation first.
- `Left` from a worker TUI: detach and return to the fleet. Orchestrators keep Left for native TUI
  input and detach only with `Ctrl+]`.
- Enter `/model` to choose from the flat model catalog, then choose effort. The explicit selection
  applies immediately and is persisted per project.
- Enter `/fable-workers status`, `/fable-workers on`, or `/fable-workers off` to inspect or change
  autonomous Fable access for the selected/bound orchestrator. The grant is durable with that
  binding; disabling it blocks new Fable workers without stopping existing threads.
- Enter `/cursor-workers status`, `/cursor-workers on`, or `/cursor-workers off` for the same durable
  control over autonomous Cursor workers. It is a separate grant from Fable's: a Cursor Fable slug
  such as `claude-fable-5-high` requires both to be on.
- Enter `/caveman-workers status`, `/caveman-workers on`, or `/caveman-workers off` to control the
  durable, default-off box preference for subsequently started workers. It is independent of Orc
  bindings and survives broker and Orc replacement. An optional box skill supplies the full policy;
  Cyberdeck uses a compact built-in fallback when that skill is absent.
- Type a task in the persistent bottom composer and press `Enter`: start a new thread using the
  visible model, effort, sandbox, and project context, then attach to its native TUI.
- `?`: toggle the shortcut panel. It documents reorder, view switch, rename, multiline, pin, numbered
  opening, and contextual stop/delete controls.
- `Esc`: close an active picker/edit mode or clear a draft. It never exits Fleet.
- The first `Ctrl+X` on any selected thread is always the stop step, including a thread already
  displayed as `Done`. On an orchestrator, it stops the orchestrator and every owned worker while
  keeping all thread history visible.
- After that stop step, `Ctrl+X` on a terminal thread or fully stopped orchestrator tree shows the
  exact red deletion confirmation. Press `Ctrl+X` once more to delete the thread or tree leaf-first.
- `Ctrl+C` twice consecutively: leave Fleet. The first press shows a red inline confirmation near the
  footer; any other key cancels it. Exiting does not stop an agent.

New-thread tasks are passed to the provider as one initial positional argument. The full task body is
not stored in the session record; a normalized 72-character thread title is retained as `name` for
the fleet. Cyberdeck does not infer a provider or model: changing launch context requires an
explicit `/model` selection.

Other standard terminal and tmux shortcuts are preserved while attached. `cyberdeck diagnostics` retains the
read-only **SESSIONS**, **JOBS**, **ADMISSION**, **BUDGET**, and **RECONCILIATION** panels for detailed
control-plane inspection.

tmux is presentation only. The cockpit issues no `kill-pane`, `kill-server`, or `send-keys` verb.
`kill-session` is reserved for transactional rollback of the exact cockpit created by the failing
invocation. Killing the entire tmux server still leaves the broker and its sessions running.

## Orchestrator, transcripts, and MCP

An orchestrator is a durable, typed Cyberdeck binding, not a privileged role label. The binding pins
an explicit provider, optional model and reasoning effort, workspace or fleet scope, read-only filesystem sandbox, and a
capability grant. Cyberdeck injects its session-scoped stdio MCP server into broker-launched Codex,
Claude, and Cursor sessions. Broker RPC remains the source of truth and rechecks every MCP call.
Antigravity sessions receive no MCP server: `agy` accepts no per-invocation MCP server definition, so
it can be a worker but not an orchestrator or workflow participant. See
[docs/architecture/provider-parity.md](docs/architecture/provider-parity.md) for the full
per-provider matrix — permission mapping, MCP injection, effort support, and resume — with source
citations.

Cursor's `agent` also accepts no MCP flag, so its server arrives through a session-scoped plugin
directory and permission configuration that Cyberdeck writes under its own private launch-files root
and removes on exit. The operator's `~/.cursor` and the repository's `.cursor/mcp.json` are never
read from or written to, and `HOME` is never redirected, so Cursor authentication is untouched.

Opening an orchestrator cockpit starts the provider TUI without a positional user prompt, so startup
does not automatically submit a model turn. Guidance is supplied through native provider
configuration (`developer_instructions` for Codex and `--append-system-prompt` for Claude), and both
that guidance and the session-scoped MCP configuration are retained by provider-native resume. Cursor
has no system-prompt flag, so a Cursor orchestrator receives its guidance as the first submitted
message, visible in the transcript, and the conversation is reopened afterwards by chat id.

Bindings are append-only but explicitly recoverable. Reset refuses an active orchestrator and tells
the operator which session to stop; after it is inactive, invalidate the latest workspace or fleet
binding without editing JSONL files:

```bash
cyberdeck stop ORCHESTRATOR_SESSION_ID
cyberdeck orchestrator reset
cyberdeck orchestrator fable-workers status
cyberdeck orchestrator fable-workers on
cyberdeck orchestrator fable-workers off
cyberdeck orchestrator cursor-workers status
cyberdeck orchestrator cursor-workers on
cyberdeck orchestrator cursor-workers off
cyberdeck orchestrator caveman-workers status
cyberdeck orchestrator caveman-workers on
cyberdeck orchestrator caveman-workers off
cyberdeck scout-egress status --root /absolute/repository
cyberdeck scout-egress on --root /absolute/repository
cyberdeck scout-egress off --root /absolute/repository
```

An explicit different provider/model can then replace an inactive latest binding cleanly. Pass
`--scope workspace --cwd /absolute/workspace/path` to reset a deliberately isolated legacy or
opt-in workspace binding. Cyberdeck does not translate model aliases, choose a fallback, or silently
resume a reset binding.
If an inactive provider-native conversation can no longer be located, an explicit provider, model,
and effort selection appends a fresh binding instead of leaving the workspace stuck. A closed
orchestrator pane is recreated on the next launch; closing a pane still detaches presentation and
never stops the broker-owned provider process.

The orchestrator can list in-scope workers, query Cyberdeck's authoritative provider/model/effort
catalog, batch-start explicitly selected Codex, Claude, Cursor, or Antigravity workers, and wait
inside the broker for compact results. Normal result collection is one `workers_start` call followed
by one blocking `workers_wait` call; it does not poll or feed raw terminal transcripts back into the
model. `thread_read` remains a bounded debugging escape hatch, requires an explicit cursor, and
refuses to move an orchestrator backward behind a cursor it has already consumed.

`workers_wait` accepts a logical timeout of up to 600 seconds but never blocks a single tool call
longer than 90 seconds, because MCP clients abandon a call well before that — Claude Code backgrounds
one at 120 seconds and Codex kills one at 300. A call that reaches the segment boundary first returns
a normal structured result with `wait.state: "incomplete"` and a `waitId` to resume; `"timed-out"`
means the caller's own budget elapsed, and `"settled"` means every target is terminal. A completed
`sessionId` and `completionTarget` stays retrievable afterwards: re-waiting replays the recorded
result and marks it `retrieval: "replay"`, which is how an orchestrator proves a mutation already ran
instead of launching a duplicate worker. A control-plane failure is reported as its own class and
never as a worker outcome. An idle worker whose transcript and rendered token count remain unchanged
for `workerStallSeconds` (60 by default) settles as `status: "stalled"` with elapsed time, token
count, and a machine-readable reason instead of reporting `working` forever. `threads_list` defaults
to a status projection (id, name, provider,
executionState, attentionState) and pages with `limit`/`cursor`, so a liveness check stays inside a
caller's token budget at 64 concurrent workers; pass `view: "full"` for whole records.

Worker starts may explicitly set provider-neutral `approvalMode` to `auto` for Codex, Claude, or
Cursor. Cursor maps it to verified post-launch `/run-everything`: Cyberdeck waits for Composer input,
commits the command, reads the enabled state back through the command menu, and always closes that
menu before submitting the task. MCP-started workers inherit the persisted `/permissions` policy
when `approvalMode` is omitted. Antigravity rejects `auto` rather than ignoring it. The operator CLI
exposes the same explicit override as `--approval-mode auto`.

An Orc may instead set `profile: "scout"` and pass a structured brief (`objective`, relative
path/glob `scope`, lookup-shaped `questions`, `stopCondition`, optional `hypothesisId`, and optional
wall-clock `budget`). Deprecated `maxTokens` input remains accepted but is ignored for termination.
Cyberdeck resolves that profile to the existing worker lifecycle with fixed Tier 1 state: Cursor
Composer, read-only plan+sandbox, provider-native `--print --output-format stream-json`, and lease
policy `expire-and-discard` (`orphan-for-adoption` is recorded only for forward compatibility).
Source egress fails closed until the operator grants the exact canonical Git root with
`cyberdeck scout-egress on --root <repo>`. That append-only grant survives broker and Orc
replacement; MCP exposes no mutation path.

Cyberdeck redirects Cursor state outside the repository, disables MCPs in that isolated state, and
compares a pre/post fingerprint of HEAD, tracked diffs, and nonignored untracked content. A successful Scout needs an
unchanged repository and a compact natural-language decision card; Cyberdeck may stop it after that
card is durable. The complete raw
stream (8 MiB), deeper evidence (512 KiB), and card (96 KiB) remain durable private artifacts; only
the card or a multi-Scout digest enters normal wait results. Digests promote contradictions and
new findings and carry `scout://<session>/<card|evidence|trace>` handles for explicit
`cyberdeck_scout_read` drill-down. Failed launches remain visible with their session ID and phase.
The default wall-clock ceiling is 15 minutes. No token kill cap is enforced. Batch starts launch
independent Scouts concurrently; no pane interaction, prompt scraping, or approval keypress
participates.

A human attachment always owns the only writer lease: orchestrator input remains queued until that
controller detaches. Cyberdeck never steers a worker through tmux.

Interactive prompts, normalized provider output, orchestrator instructions, and lifecycle changes
are stored locally in an append-only transcript at:

```text
~/Library/Application Support/Cyberdeck/threads/transcript.jsonl
```

This is a deliberate change from metadata-only journaling. The transcript is created with user-only
permissions and supplies monotonic cursors for "what happened while I was away?" reads. Raw PTY
replay remains separately bounded and presentation-oriented.

## Bounded workflows

MCP-capable Cyberdeck agents can participate in explicit workflows. A workflow declares its
participants and hard maximums for messages, wake turns, and causal hops. Sending a mailbox message
does **not** wake the recipient by default; `wake: true` is explicit and consumes one turn. Message
IDs deduplicate retries, and causation IDs make loops auditable.

The human kill switch does not stop any provider session:

```bash
cyberdeck workflow list
cyberdeck workflow cancel WORKFLOW_ID --reason "operator stop"
```

Cancellation prevents further workflow messages or wakes. Explicit session stopping remains a
separate operation.

Shut down deliberately when finished:

```bash
cyberdeck broker stop
```

`cyberdeck broker restart` requests a graceful shutdown, waits for the old socket to close, starts
the built broker in the background, and waits for the replacement to report healthy.

Cyberdeck admits 64 active workers by default. Orchestrators do not consume worker slots. Override
the ceiling persistently in `~/Library/Application Support/Cyberdeck/config.json`, then restart the
broker:

```json
{
  "maxConcurrentWorkers": 128
}
```

Set `maxConcurrentWorkers` to `null` for explicitly unlimited workers. A reached ceiling is rejected
with the active and allowed worker counts; durable interactive sessions are not silently queued.
The ceiling applies to running agents only: a finished thread holds no slot, so the fleet view
accumulates history without anyone stopping and deleting threads to reclaim capacity.

Broker shutdown still ends active PTYs, but the durable session catalog, project grouping, model
metadata, normalized preview, and native conversation identity survive broker death or restart.
A thread that had finished its task is rehydrated as `Done` — the process is gone, the outcome is
not. Only a thread that was genuinely mid-turn is rehydrated as `Interrupted`; opening either one
uses the provider's exact resume path rather than inventing a replacement conversation.

Finished threads are retired automatically after 7 days, or once 200 of them have accumulated,
whichever comes first. Pinned threads are never retired. Both bounds are configurable, and `null`
disables either one:

```json
{
  "threadRetention": {
    "maxAgeDays": 30,
    "maxThreads": 500,
    "keepPinned": true
  }
}
```

Retention only ever removes threads whose process is gone. A session that took an unrecoverable
provider fault — an API 4xx, say — while its OS process kept running is reported as `Failed` rather
than as an active worker, releases its slot immediately, and still has to be stopped before it can
be deleted.
Bounded control-plane jobs are different: their records and terminal results are rebuilt on restart,
while unverifiable nonterminal jobs become `interrupted` and are never automatically redispatched.

## Start a session

Every start requires an explicit provider. The model and opaque role string are optional and independent.

Detached/headless Codex using its native configured default:

```bash
cyberdeck start --provider codex --cwd /absolute/project/path --sandbox read-only --name codex-session
```

Attached/interactive Claude using an explicitly chosen provider-native model string:

```bash
cyberdeck start --provider claude --cwd /absolute/project/path --sandbox workspace-write --model MODEL_NAME --role any-user-defined-label --attach
```

Cursor and Antigravity are also broker-owned interactive sessions:

```bash
cyberdeck start --provider cursor --cwd /absolute/project/path --sandbox read-only --attach
cyberdeck start --provider antigravity --cwd /absolute/project/path --sandbox read-only --model MODEL_NAME --attach
```

Their initial prompt paths are fixture-proven but still live-unverified. Provider-native resume is
not claimed for either provider: reopening a terminal Cursor or Antigravity thread fails explicitly
instead of starting a different conversation.

Cyberdeck does not recommend or automatically select a model. If `--model` is omitted, the provider's native default is used. Confirm that default yourself: an omitted Claude model may be Fable depending on local configuration.

The read-only mapping uses each provider's native restricted mode. Claude is always spawned with `DISABLE_UPDATES=1`.

## Attach, watch, detach, and steer

```bash
cyberdeck attach SESSION_ID
cyberdeck watch SESSION_ID
cyberdeck send SESSION_ID "Summarize the current state without changing files."
cyberdeck logs SESSION_ID
```

`attach` is the single controlling client. `watch` is a read-only observer and multiple watchers are allowed. Both replay buffered output before following live output. Press Left or `Ctrl-]` to return from a worker. Orchestrators reserve Left for their native TUI and detach only with `Ctrl-]`; a cockpit attachment also leaves the cockpit and returns to Fleet after releasing its controller. `Ctrl-]` detaches while attached and reattaches the exact last-detached target from Fleet. Every other byte is forwarded verbatim, including bare Esc and Option/Alt chords such as Option+Enter, and a bracketed paste is forwarded as opaque data so pasted bytes can never be read as a chord. In Fleet's composer, Option+Enter and Shift+Enter insert a newline alongside `Ctrl-J`, and Esc remains Fleet's own back/clear. Terminal threads refuse attachment until they have been resumed, and provider exit automatically releases every controller and watcher.

`send` submits one logical prompt without opening an interactive client. The selected provider
adapter encodes its terminal's actual Enter key, so steering does not depend on a portable newline
assumption. `logs` prints the current replay snapshot.

## Open a worker's worktree in nvim

Press `Ctrl-N` on a focused worker row in Fleet, or run the same thing from the CLI:

```bash
cyberdeck open SESSION_ID
cyberdeck open my-worker-name
```

Cyberdeck opens the worker's cwd in the nvim running in the **same tmux window** as the invoking
client: a new tab, `:tcd`-scoped to that worktree so several worktrees coexist without fighting over
a global cwd, with a location list of the files and hunks that worker changed.

If that window has no nvim, one is started there — split off the rightmost pane, so it lands beyond
the orchestrator attachment rather than between it and Fleet — and the open waits up to five seconds
for the new nvim to call `listen()`. Nothing else is guessed at: no other window is searched and no
socket directory is scanned, because either would open a worktree somewhere you are not looking. An
nvim that is already running but never called `listen()` is reported as such rather than having a
second nvim started on top of it.

While the worker is running, every buffer under its worktree is `readonly` and `nomodifiable`,
including buffers that were already open before the worktree was opened. Agents commonly rewrite
whole files rather than editing them, so a live worktree is not a place two writers can share. When
the worker reaches a terminal state the broker pushes one message that both refreshes the list with
the final change set and releases the lock — one transition, one message, so the lock can never
outlive the run. Locks are tracked per worker, not per path, so a worktree nested inside another
open worktree keeps its own files locked for as long as its own worker runs.

The nvim side ships in this repository and installs nothing on its own. Point your own config at it
and call `listen()` once:

```lua
vim.opt.runtimepath:append("/absolute/path/to/cyberdeck/contrib/nvim")
require("cyberdeck").listen()
```

Under a plugin manager that rewrites `runtimepath` — lazy.nvim does — appending it by hand is
discarded during setup and `require` then fails. Let the manager own the entry instead:

```lua
-- lazy.nvim
{ dir = "/absolute/path/to/cyberdeck/contrib/nvim", name = "cyberdeck", lazy = false,
  config = function() require("cyberdeck").listen() end }
```

`listen()` starts an RPC server on a socket derived from the pane's own `$TMUX_PANE`, which is the
same address Cyberdeck derives — neither side is ever told where the other is. It requires Neovim
0.10 or newer and does nothing outside tmux. The association between a worker and an nvim address is
held in memory only: if the broker restarts, press `Ctrl-N` again.

Changed files are computed against the upstream branch git itself recorded for the worktree, or
against `HEAD` when there is none. With no upstream configured, work the agent committed and left
clean does not appear in the list.

## Delegate one explicitly selected worker

Delegation still requires an explicit provider; the role is only an optional user-defined label:

```bash
cyberdeck delegate --parent PARENT_SESSION_ID --provider codex --cwd /absolute/project/path --sandbox read-only --role my-label --name child-session
```

Cyberdeck does not infer a provider or model from the role. An explicit operator start may select
Fable directly. Autonomous Fable workers are disabled by default and fail before launch unless the
bound orchestrator has the durable `worker.start.fable` capability. Autonomous Cursor workers are
gated the same way by `worker.start.cursor`, and a Cursor Fable slug needs both grants. Only the
operator Fleet/CLI surface can change either grant; an orchestrator cannot enable itself. Opus has no
special restriction.

Cursor worker models are exact slugs with the effort rung inside the slug (`gpt-5.6-sol-high`,
`claude-sonnet-5-xhigh`, `composer-2.5`); passing a separate effort is refused rather than folded in.

## Stop and inspect

```bash
cyberdeck list --json
cyberdeck logs SESSION_ID
cyberdeck stop SESSION_ID
```

Use `stop` only when the selected runtime should end. Stopping an orchestrator also stops its owned workers. Closing a terminal or tmux pane is not a substitute for `stop`, and `stop` is not a detach operation.

Deleting history is separate from stopping a runtime. The fleet refuses deletion until the full
selected tree has exited and requires the visible two-press confirmation described above. Confirmed
tree deletion removes descendants leaf-first, clears an orchestrator binding, and removes the root
last.

## Test, check, build, and probe

The automated suite uses a deterministic fake terminal agent and makes no Claude, Codex, or Fable model call.

```bash
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
mise exec -- pnpm probe
```

`probe` is read-only: it reports installed runtime versions and does not start provider sessions or change authentication. The deeper capability probe refuses to run without `--read-only`:

```bash
mise exec -- pnpm exec tsx scripts/probe-provider-capabilities.ts --read-only
```

That is the complete zero-call workflow. No test or probe resolves a real provider executable for a model call, and no automated path may start Fable — including as a "just checking" allowance test.

## Providers, executables, and modes

| Provider id | Executable | Interactive | Headless | Read-only mapping | Workspace-write mapping |
| --- | --- | --- | --- | --- | --- |
| `claude` | `claude` | broker-owned PTY | one-shot per job, not durable | `--permission-mode plan` | `--permission-mode manual` |
| `cursor` | `agent` | broker-owned PTY | one-shot per job, not durable | `--mode plan --sandbox enabled` | unsupported — no `--mode` emitted |
| `antigravity` | `agy` | broker-owned PTY | one-shot per job, not durable | `--mode plan --sandbox` | **refused** — `ANTIGRAVITY_WORKSPACE_WRITE_UNSUPPORTED` before argv is built |
| `codex` | `codex` | broker-owned PTY | Phase 1 session only | `-s read-only -a on-request` | `-s workspace-write -a on-request` |

Headless is **one-shot per job for every provider**: each bounded job is a fresh invocation that claims no conversation continuity. No `--resume`, `--continue`, or session-continuation flag is emitted, and no `--fallback-model` or automatic-selection flag exists anywhere.

Explicit-model examples — always name the model:

```bash
cyberdeck start --provider claude --cwd /absolute/project/path --sandbox read-only --model claude-opus-4-8
cyberdeck start --provider claude --cwd /absolute/project/path --sandbox read-only --model fable
cyberdeck start --provider codex  --cwd /absolute/project/path --sandbox read-only --model MODEL_NAME
```

> **Omitting `--model` is not safe for Claude.** The neutral stored contract retains an omitted model, but both current interactive and headless Claude launch boundaries reject it before process construction because omission is not an explicit operator choice. Name the intended model on every real Claude start.

Capability claims are graded and never merged: `metadata-observed`, `fixture-proven`, `help-advertised`, `operationally observed`, `unsupported`, `not run`, and `live-proven`. The B-track presentation register has no `live-proven` entries; final Gate 2 separately records one authorized live Codex App Server turn. Metadata observations are date- and version-sensitive because these runtimes update themselves. See [docs/setup/integrated-acceptance.md](docs/setup/integrated-acceptance.md) for the full matrix and current limitations.

## Original Phase 1 boundary and current extensions

Phase 1 provided broker-owned Claude and Codex PTYs, explicit starts, one bounded delegation
primitive, attach/watch/detach, input steering, replay, explicit stop, and a tmux projection. The
current implementation adds durable transcripts, explicit orchestrator bindings, capability-scoped
MCP, safe instruction queues, and bounded workflows. It still provides no automatic routing or
fallback, provider ranking, model recommendations, or implicit premium-model selection.

See `docs/architecture/session-model.md` for the precise state and ownership model and `docs/setup/phase-1-acceptance.md` for verified live behavior and current limitations.

## Phase 2/3 control plane

Phase 2/3 adds a neutral control plane for bounded **jobs** — distinct from Phase 1 sessions — with
structured delegation, persistence and recovery, artifacts, leases, concurrency, and budgets. The
shared, runtime-validated contracts are defined in `src/domain/` and documented in
`docs/architecture/control-plane.md`; the sequenced implementation plan is
`docs/superpowers/plans/2026-07-21-cyberdeck-phase-2-3.md`. Job submission, structured delegation,
report-back, persistence/recovery, structured artifact storage, supervised Codex App Server
transport, and durable canonical-path worktree leases are implemented. The neutral
policy — explicit provider, opaque model/role, no ranking or routing, no unauthorized Fable delegation
— is unchanged. Exact recovery and storage operations are documented in
`docs/architecture/persistence-and-recovery.md`. App Server compatibility, interruption mapping,
lease fencing, and orphan remediation are in
`docs/architecture/app-server-and-worktree-leases.md`.

## Security, privacy, and contributing

Cyberdeck stores local session metadata and transcripts below
`~/Library/Application Support/Cyberdeck/`. These files can contain sensitive
prompts, source code, paths, and provider output. Provider processes inherit the
launching environment and remain governed by their own sandbox, network,
telemetry, authentication, and service terms.

Read [SECURITY.md](SECURITY.md) before operating Cyberdeck on sensitive
repositories. Vulnerabilities should be reported privately through GitHub's
Security tab, not through a public issue.

Cyberdeck is licensed under [Apache-2.0](LICENSE). Contributions are welcome
under the [contribution guide](CONTRIBUTING.md) and Developer Certificate of
Origin. Project branding is covered separately by [TRADEMARKS.md](TRADEMARKS.md).
