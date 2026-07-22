# Cyberdeck

Cyberdeck is a neutral local broker for durable Claude and Codex terminal sessions. Provider processes run in broker-owned PTYs, so they can move between attached/interactive and detached/headless presentation without being restarted. tmux is an optional cockpit view, not the session owner.

> **Stop and detach are different.** `cyberdeck stop <session-id>` terminates the provider process. Pressing `Ctrl-]`, closing an attached terminal, or closing a tmux pane only detaches that view; the session keeps running while the broker is alive.

## Requirements and installation

The project pins Node 24.18.0 through mise and pnpm 11.5.0 through Corepack/package metadata. Claude Code and Codex CLI must be installed for their corresponding providers. The cockpit requires the native system `tmux` binary; Cyberdeck does not bundle, build, silently install, or emulate tmux. The plain Fleet remains usable without it.

```bash
cd /Users/brandon/code/personal/cyberdeck
mise install
mise exec -- corepack enable
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm build
(cd /tmp && mise exec -- pnpm add --global /Users/brandon/code/personal/cyberdeck)
```

If the global install is not desired, replace `cyberdeck` in the examples with `node dist/src/cli.js` from the repository root.

Run `cyberdeck` with no arguments to start the broker when needed and open the interactive fleet.

## Broker and cockpit

```bash
cyberdeck broker start
cyberdeck broker status
cyberdeck broker restart
cyberdeck cockpit --orchestrator codex --model sol
cyberdeck list
```

The first cockpit launch for a workspace requires an explicit orchestrator provider and optional
provider-native model. It creates a workspace-namespaced native tmux session with the interactive
Fleet in the left pane and a broker-owned orchestrator attachment in the right pane. Later launches
can omit the provider while that orchestrator remains owned by the current broker. Use `--scope
fleet` only when the orchestrator should see threads from every working directory.

Create, split, or close panes freely; the broker, not tmux, owns every provider session. tmux is
preflighted with `tmux -V`, and a missing binary produces an installation error before the cockpit
changes presentation.

`cyberdeck dashboard` groups durable agent threads by project. Every row shows the thread name,
provider, explicit model (or `native-default`), role when present, status, latest replay preview, and
relative activity time. It never ranks providers or chooses a model.

Fleet controls:

- `Up` / `Down`: select a thread.
- `Right`, or `Enter` while the bottom composer is empty: open the selected provider TUI. A live
  thread attaches to its existing PTY; a terminal thread resumes that exact provider-native
  conversation first.
- `Left` from a provider TUI: detach and return to the fleet. `Ctrl+]` remains an alternate detach
  key.
- Type a task in the persistent bottom composer and press `Enter`: start a new thread using the
  selected row's visible provider, model, sandbox, and project context, then attach to its native TUI.
- With no suitable row, `/codex task`, `/codex:MODEL task`, or `/claude:MODEL task` explicitly
  bootstraps a read-only session in the dashboard's current working directory.
- `Esc`: clear the new-thread composer.
- `Ctrl+X` on a live agent: stop it through the broker.
- `Ctrl+X` on a stopped, done, or failed thread: show the red `press ctrl+x again to delete`
  confirmation. Press `Ctrl+X` once more to delete the thread record.
- `Ctrl+C`: leave the fleet. This does not stop an agent.

New-thread tasks are passed to the provider as one initial positional argument. The full task body is
not stored in the session record; a normalized 72-character thread title is retained as `name` for
the fleet. Cyberdeck does not infer a provider or model: changing launch context means
selecting a row whose explicit context matches the session you want.

Other standard terminal and tmux shortcuts are preserved while attached. `cyberdeck diagnostics` retains the
read-only **SESSIONS**, **JOBS**, **ADMISSION**, **BUDGET**, and **RECONCILIATION** panels for detailed
control-plane inspection.

tmux is presentation only. The cockpit issues no `kill-session`, `kill-pane`, `kill-server`, or `send-keys` verb. Killing the entire tmux server leaves the broker and its sessions running.

## Orchestrator, transcripts, and MCP

An orchestrator is a durable, typed Cyberdeck binding, not a privileged role label. The binding pins
an explicit provider, optional model, workspace or fleet scope, read-only filesystem sandbox, and a
capability grant. Cyberdeck injects its session-scoped stdio MCP server into broker-launched Codex
and Claude sessions. Broker RPC remains the source of truth and rechecks every MCP call.

The orchestrator can list in-scope workers, read cursor-based thread changes, start explicitly
selected workers, and queue complete instructions. A human attachment always owns the only writer
lease: orchestrator input remains queued until that controller detaches. Cyberdeck never steers a
worker through tmux.

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

Broker shutdown ends active PTYs in Phase 1. Sessions survive client and pane detachment, but they do not survive broker death or restart.
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

Cyberdeck does not recommend or automatically select a model. If `--model` is omitted, the provider's native default is used. Confirm that default yourself: an omitted Claude model may be Fable depending on local configuration.

The read-only mapping uses each provider's native restricted mode. Claude is always spawned with `DISABLE_UPDATES=1`.

## Attach, watch, detach, and steer

```bash
cyberdeck attach SESSION_ID
cyberdeck watch SESSION_ID
cyberdeck send SESSION_ID "Summarize the current state without changing files."
cyberdeck logs SESSION_ID
```

`attach` is the single controlling client. `watch` is a read-only observer and multiple watchers are allowed. Both replay buffered output before following live output. Press Left or `Ctrl-]` to detach from either view. Terminal threads refuse attachment until they have been resumed, and provider exit automatically releases every controller and watcher.

`send` submits one logical prompt without opening an interactive client. The selected provider
adapter encodes its terminal's actual Enter key, so steering does not depend on a portable newline
assumption. `logs` prints the current replay snapshot.

## Delegate one explicitly selected worker

Delegation still requires an explicit provider; the role is only an optional user-defined label:

```bash
cyberdeck delegate --parent PARENT_SESSION_ID --provider codex --cwd /absolute/project/path --sandbox read-only --role my-label --name child-session
```

Cyberdeck does not infer a provider or model from the role. Delegated Fable is rejected before launch with `FABLE_REQUIRES_EXPLICIT_HUMAN_START`. A top-level Fable start can only be a deliberate human command and is never needed for tests or runtime probes. Opus has no special restriction.

## Stop and inspect

```bash
cyberdeck list --json
cyberdeck logs SESSION_ID
cyberdeck stop SESSION_ID
```

Use `stop` only when the provider process should end. Closing a terminal or tmux pane is not a substitute for `stop`, and `stop` is not a detach operation.

Deleting a thread is separate from stopping it. The fleet refuses deletion until the provider
process has exited, then requires the visible two-press confirmation described above. A parent
thread cannot be deleted while child thread records still exist.

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

Explicit-model examples that cannot accidentally invoke Fable — always name the model:

```bash
cyberdeck start --provider claude --cwd /absolute/project/path --sandbox read-only --model claude-opus-4-8
cyberdeck start --provider codex  --cwd /absolute/project/path --sandbox read-only --model MODEL_NAME
```

> **Omitting `--model` is not safe for Claude.** The neutral stored/delegation policy retains an omitted model, but both current interactive and headless Claude launch boundaries reject it before process construction because the recorded native default displayed Fable. Name an explicit ordinary model on every real Claude start.

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
policy — explicit provider, opaque model/role, no ranking or routing, no automation-launched Fable
— is unchanged. Exact recovery and storage operations are documented in
`docs/architecture/persistence-and-recovery.md`. App Server compatibility, interruption mapping,
lease fencing, and orphan remediation are in
`docs/architecture/app-server-and-worktree-leases.md`.
