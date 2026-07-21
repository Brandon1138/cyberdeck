# Cyberdeck

Cyberdeck is a neutral local broker for durable Claude and Codex terminal sessions. Provider processes run in broker-owned PTYs, so they can move between attached/interactive and detached/headless presentation without being restarted. tmux is an optional cockpit view, not the session owner.

> **Stop and detach are different.** `cyberdeck stop <session-id>` terminates the provider process. Pressing `Ctrl-]`, closing an attached terminal, or closing a tmux pane only detaches that view; the session keeps running while the broker is alive.

## Requirements and installation

The project pins Node 24.18.0 through mise and pnpm 11.5.0 through Corepack/package metadata. Claude Code, Codex CLI, and tmux must be installed separately for the corresponding live features.

```bash
cd /Users/brandon/code/personal/cyberdeck
mise install
mise exec -- corepack enable
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm build
mise exec -- pnpm link --global
```

If the global link is not desired, replace `cyberdeck` in the examples with `node dist/src/cli.js` from the repository root.

## Broker and cockpit

```bash
cyberdeck broker start
cyberdeck broker status
cyberdeck cockpit
cyberdeck list
```

The cockpit creates a tmux session with a read-only dashboard and an ordinary shell. Create or close additional panes freely; the broker, not tmux, owns provider sessions.

`cyberdeck dashboard` renders five panels over control-plane queries: **SESSIONS** (interactive runtime — broker-owned PTYs), **JOBS** (headless runtime — bounded work), **ADMISSION**, **BUDGET**, and **RECONCILIATION**. It is read-only and ranks nothing.

Interactive and headless are runtime/presentation distinctions, not provider categories. The dashboard states what it does not know rather than guessing: an omitted model shows `native-default`, an omitted role shows `unassigned`, unreported token usage shows `unknown` (never `0`), a reconciliation pass that never ran shows `never reconciled`, and a panel the broker does not answer shows `unavailable` — which is not the same as empty.

tmux is presentation only. The cockpit issues no `kill-session`, `kill-pane`, `kill-server`, or `send-keys` verb. Killing the entire tmux server leaves the broker and its sessions running.

Shut down deliberately when finished:

```bash
cyberdeck broker stop
```

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

`attach` is the single controlling client. `watch` is a read-only observer and multiple watchers are allowed. Both replay buffered output before following live output. Press `Ctrl-]` to detach from either view.

`send` submits input without opening an interactive client. `logs` prints the current replay snapshot.

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

> **Omitting `--model` is not safe for Claude.** The delegated-Fable guard rejects only an *explicitly supplied* `fable` model; an omitted model still passes, and the recorded baseline observed Claude's native default displaying Fable. Name an explicit ordinary model on every real Claude start.

Capability claims are graded and never merged: `metadata-observed`, `fixture-proven`, `help-advertised`, `operationally observed`, `unsupported`, `not run` — and `live-proven`, which currently has **no entries at all**. Metadata observations are date- and version-sensitive because these runtimes update themselves. See [docs/setup/integrated-acceptance.md](docs/setup/integrated-acceptance.md) for the full matrix and current limitations.

## Phase 1 boundary

Phase 1 provides broker-owned Claude and Codex PTYs, explicit starts, one bounded delegation primitive, attach/watch/detach, input steering, replay, explicit stop, and a tmux projection. It does not provide workflows, automatic routing or fallback, provider ranking, model recommendations, semantic memory, worktree orchestration, Cursor, or Antigravity.

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
