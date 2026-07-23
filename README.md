# Cyberdeck

[![CI](https://github.com/Brandon1138/cyberdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/Brandon1138/cyberdeck/actions/workflows/ci.yml)
[![npm prerelease](https://img.shields.io/npm/v/%40ishmael38%2Fcyberdeck/next.svg)](https://www.npmjs.com/package/@ishmael38/cyberdeck)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Cyberdeck is a neutral local broker for durable Codex, Claude, Cursor, and Antigravity terminal sessions. Provider processes run in broker-owned PTYs, so they can move between attached/interactive and detached/headless presentation without being restarted. tmux is an optional cockpit view, not the session owner.

> **Stop and detach are different.** `cyberdeck stop <session-id>` terminates the selected provider process and, for an orchestrator, its owned worker tree. Pressing `Ctrl-]`, closing an attached terminal, or closing a tmux pane only detaches that view; the session keeps running while the broker is alive.

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

- `Ctrl+O`: open the fleet orchestrator picker. Choose provider, model, and provider-supported
  effort in sequence. The effort choice applies immediately, with no confirmation screen.
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
- Enter `/caveman-workers status`, `/caveman-workers on`, or `/caveman-workers off` to control the
  durable, default-off box preference for subsequently started workers. It is independent of Orc
  bindings and survives broker and Orc replacement. An optional box skill supplies the full policy;
  Cyberdeck uses a compact built-in fallback when that skill is absent.
- Type a task in the persistent bottom composer and press `Enter`: start a new thread using the
  visible model, effort, sandbox, and project context, then attach to its native TUI.
- `?`: toggle the shortcut panel. It documents reorder, view switch, rename, multiline, pin, numbered
  opening, and contextual stop/delete controls.
- `Esc`: close an active picker/edit mode or clear a draft. It never exits Fleet.
- `Ctrl+X` on a live worker: stop it through the broker. On an orchestrator, stop the orchestrator
  and every owned worker while keeping all thread history visible.
- `Ctrl+X` on a terminal thread or fully stopped orchestrator tree: show the exact red deletion
  confirmation. Press `Ctrl+X` once more to delete the thread or tree leaf-first.
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
capability grant. Cyberdeck injects its session-scoped stdio MCP server into broker-launched Codex
and Claude sessions. Broker RPC remains the source of truth and rechecks every MCP call.

Opening an orchestrator cockpit starts the provider TUI without a positional user prompt, so startup
does not automatically submit a model turn. Guidance is supplied through native provider
configuration (`developer_instructions` for Codex and `--append-system-prompt` for Claude), and both
that guidance and the session-scoped MCP configuration are retained by provider-native resume.

Bindings are append-only but explicitly recoverable. Reset refuses an active orchestrator and tells
the operator which session to stop; after it is inactive, invalidate the latest workspace or fleet
binding without editing JSONL files:

```bash
cyberdeck stop ORCHESTRATOR_SESSION_ID
cyberdeck orchestrator reset
cyberdeck orchestrator fable-workers status
cyberdeck orchestrator fable-workers on
cyberdeck orchestrator fable-workers off
cyberdeck orchestrator caveman-workers status
cyberdeck orchestrator caveman-workers on
cyberdeck orchestrator caveman-workers off
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

Broker shutdown still ends active PTYs, but the durable session catalog, project grouping, model
metadata, normalized preview, and native conversation identity survive broker death or restart.
Threads whose live ownership cannot be proven are rehydrated as `Interrupted`; opening one uses the
provider's exact resume path rather than inventing a replacement conversation.
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

`attach` is the single controlling client. `watch` is a read-only observer and multiple watchers are allowed. Both replay buffered output before following live output. Press Left or `Ctrl-]` to return from a worker. Orchestrators reserve Left for their native TUI and detach only with `Ctrl-]`. Terminal threads refuse attachment until they have been resumed, and provider exit automatically releases every controller and watcher.

`send` submits one logical prompt without opening an interactive client. The selected provider
adapter encodes its terminal's actual Enter key, so steering does not depend on a portable newline
assumption. `logs` prints the current replay snapshot.

## Delegate one explicitly selected worker

Delegation still requires an explicit provider; the role is only an optional user-defined label:

```bash
cyberdeck delegate --parent PARENT_SESSION_ID --provider codex --cwd /absolute/project/path --sandbox read-only --role my-label --name child-session
```

Cyberdeck does not infer a provider or model from the role. An explicit operator start may select
Fable directly. Autonomous Fable workers are disabled by default and fail before launch unless the
bound orchestrator has the durable `worker.start.fable` capability. Only the operator Fleet/CLI
surface can change that grant; an orchestrator cannot enable itself. Opus has no special restriction.

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
