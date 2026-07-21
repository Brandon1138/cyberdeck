# Integrated provider acceptance (A5 + B5)

Captured on **2026-07-21** in Europe/Bucharest on darwin 27.0.0 arm64, against the integrated A5
baseline with the B1–B4 adapters composed.

This document describes the cockpit and the acceptance pass B5 actually ran. It does not restate
Phase 1 history: [phase-1-acceptance.md](phase-1-acceptance.md) and
[runtime-baseline.md](runtime-baseline.md) remain the record of what Phase 1 verified, and
[provider-capability-evidence.md](provider-capability-evidence.md) remains the B1 read-only capture.

> **No provider or model call was made.** No prompt was sent to any provider, no `--print`/`--prompt`
> mode was used, no model was selected, no authentication was changed, and no install/update command
> was issued. Fable was not started, called, or targeted. Every conversational check below is
> recorded as `NOT RUN — explicit paid-runtime authorization absent`.

## Evidence kinds

The cockpit and the code register keep these separate and never promote one into another.

| Kind | Meaning |
| --- | --- |
| `metadata-observed` | A read-only `--version`/`--help`/status command actually printed this, on this machine, on this date. Version-sensitive. |
| `fixture-proven` | Cyberdeck's own mechanics are proven by a deterministic fixture. Proves what Cyberdeck constructs and parses — never what the provider does with it. |
| `help-advertised` | The CLI's own help mentions it. Not proof it works. |
| `operationally observed` | Observed by running real Cyberdeck control paths (broker, cockpit, tmux) with no provider process involved. |
| `live-proven` | Demonstrated by a real authorized model call. **Nothing in this document is live-proven.** |
| `unsupported` | Cyberdeck deliberately does not do this, or the provider documents no surface for it. |
| `not run` | Not attempted, and why. |

`live-proven` has no entries anywhere. `tests/client/provider-capability-view.test.ts` asserts that
no row in the shipped register claims it, so the category cannot be granted by editing prose.

## Provider-by-mode acceptance matrix

Executables are the ones B1 observed: `claude` → `claude`, `cursor` → `agent`, `antigravity` → `agy`.
Row order is alphabetical by provider id and encodes no preference. Cyberdeck ranks nothing.

### Claude (`claude`)

| Capability / mode | Metadata-observed | Fixture-proven | Operationally observed | Live-proven | Unsupported | Not run |
| --- | --- | --- | --- | --- | --- | --- |
| Version / auth status | `2.1.216`; `auth status` logged in on 2026-07-21 | — | — | — | — | — |
| Interactive command construction | — | yes | — | — | — | live launch |
| Headless one-shot mechanics (`--print`) | — | yes | — | — | — | live run |
| Explicit `--model` forwarding | — | yes (verbatim, never substituted) | — | — | — | — |
| Structured streaming framing | — | yes (newline framing only) | — | — | — | real frame schema |
| read-only → `--permission-mode plan` | help-advertised | argv construction | — | — | — | runtime confirmation |
| workspace-write → `--permission-mode manual` | help-advertised | argv construction | — | — | — | runtime confirmation |
| Omitted-model safety | — | — | — | — | **yes — the guard rejects only an explicitly supplied unsafe model** | — |
| Durable headless conversation | — | — | — | — | yes (no resume/continue/session-id emitted) | — |
| Automatic model selection / fallback | — | — | — | — | yes | — |
| Conversation continuation after start | — | — | — | — | — | **NOT RUN — paid authorization absent** |

### Cursor (`agent`)

| Capability / mode | Metadata-observed | Fixture-proven | Operationally observed | Live-proven | Unsupported | Not run |
| --- | --- | --- | --- | --- | --- | --- |
| Version / auth status | `2026.07.17-3e2a980`; logged in on 2026-07-21 | — | — | — | — | — |
| Model listing (`agent models`) | printed a listing 2026-07-21 | — | — | — | — | — |
| Interactive command construction | — | yes | — | — | — | live launch |
| Headless one-shot mechanics (`--print`) | — | yes | — | — | — | live run |
| Explicit `--model` forwarding | — | yes (verbatim) | — | — | — | — |
| Structured streaming framing | — | yes (newline framing only) | — | — | — | real frame schema |
| read-only → `--mode plan --sandbox enabled` | help-advertised | argv construction | — | — | — | runtime confirmation |
| workspace-write | — | — | — | — | **yes — only plan/ask are advertised read-only, so no `--mode` is emitted and no force/yolo/trust/Smart Auto flag ever is** | — |
| Durable headless conversation | — | — | — | — | yes (`--resume` never emitted) | — |
| Automatic model selection / fallback | — | — | — | — | yes | — |
| Usage reporting | — | — | — | — | — | no usage envelope observed |

### Antigravity (`agy`)

Rows are derived in code from `ANTIGRAVITY_CAPABILITIES`, not hand-copied.

| Capability / mode | Metadata-observed | Fixture-proven | Operationally observed | Live-proven | Unsupported | Not run |
| --- | --- | --- | --- | --- | --- | --- |
| Version | `1.1.5` | — | — | — | — | — |
| Interactive command construction | — | yes | — | — | — | live launch |
| Headless one-shot mechanics (`--print`) | — | yes | — | — | — | live run |
| Structured streaming | — | — | — | — | yes (no output-format surface documented) | — |
| read-only → `--mode plan --sandbox` | help-advertised | argv construction | — | — | — | runtime confirmation |
| workspace-write | — | — | — | — | yes — **refused** with `ANTIGRAVITY_WORKSPACE_WRITE_UNSUPPORTED` before argv is built; accept-edits is not proven equivalent | — |
| Agent selection from contract | — | — | — | — | yes (no explicit agent field; role is never reinterpreted) | — |
| Automatic model/agent selection, routing/fallback/retry | — | — | — | — | yes | — |
| Durable headless conversation | — | — | — | — | yes (fresh invocation per job) | — |
| Usage reporting | — | — | — | — | yes (no envelope; absence stays unknown) | — |
| Authentication status | — | — | — | — | — | `agy` documents no auth-status command |
| Conversation resume / plain-text result shape / print output | — | — | — | — | — | **NOT RUN — requires a model call** |

### Codex (`codex`)

Codex is a Phase 1 built-in with no B-track adapter in this wave. `codex --version` reported
`codex-cli 0.144.6` (metadata-observed). Its Phase 1 live behavior is recorded in
[runtime-baseline.md](runtime-baseline.md) and is not re-claimed here.

## Cockpit and dashboard

`cyberdeck dashboard` renders five panels over queries A5 already exposes. B5 added **no** RPC
method, CLI command, CLI option, or control-plane field.

| Panel | Source query | Honesty rule it enforces |
| --- | --- | --- |
| SESSIONS | `session.list` | Runtime mode is `interactive` (a broker-owned PTY). Omitted model renders `native-default`; omitted role renders `unassigned`. |
| JOBS | `job.list` | Runtime mode is `headless` (bounded work). Unreported tokens render `unknown`, never `0`. |
| ADMISSION | `control.queue` | Capacity affects only *when* a job runs. Each queued entry shows its own `blockedBy`. |
| BUDGET | `control.budget` | Unknown token usage renders `unknown` plus the count of jobs that reported nothing, so a declared ceiling is visibly unprovable. |
| RECONCILIATION | `control.reconciliation` | Findings are operator actions, never completed repairs. A pass that never ran renders `never reconciled`. |

A panel the broker does not answer renders `unavailable`, which is deliberately distinct from empty:
"no jobs" and "the job surface is unavailable" are different facts.

`interactive` and `headless` are **runtime/presentation** distinctions, not provider categories. No
panel ranks, recommends, badges, or defaults a provider, and none renders Fable.

### tmux is presentation only

The cockpit multiplexes *views*. `src/tmux/cockpit.ts` emits no `kill-session`, `kill-pane`,
`kill-server`, `respawn-pane`, or `send-keys` verb; `detachCockpit` uses only `detach-client`, and
`inspectCockpitPanes` uses only a read-only `list-panes -F` format query.

**Operationally observed 2026-07-21.** With a real broker running (pid 67959) and a real cockpit
tmux session:

1. `detachCockpit()` returned without throwing; the tmux session survived and the broker stayed
   `healthy: true`.
2. The entire tmux **server** was then killed. The broker remained `healthy: true` on the same pid
   and the dashboard still rendered from broker state.

Destroying the whole presentation layer changed no broker-owned state. Stopping actual work is
`cyberdeck stop <id>`, which goes through the broker — never a pane close.

## Commands run

```bash
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
mise exec -- pnpm probe
mise exec -- pnpm exec tsx scripts/probe-provider-capabilities.ts --read-only
node dist/src/cli.js broker start
node dist/src/cli.js broker status
node dist/src/cli.js list
node dist/src/cli.js broker stop
tmux new-session -d -s cyberdeck …  # the verbs launchCockpit issues, minus the TTY attach
tmux split-window -h -t cyberdeck
tmux kill-session -t cyberdeck      # cleanup of a session this pass created
```

Every provider-facing command above is metadata-only (`--version`, `--help`, documented status) or
an allowlisted read-only probe. `assertReadOnlyProbe` rejects prompt operands, `--model`,
print/prompt modes, session continuation, `login`/`logout`, and `install`/`update` before spawning.

### Observed version drift

`claude` moved `2.1.215` → `2.1.216` between the B1 capture and this pass. Cyberdeck issued no
update command; these runtimes update themselves. Every `metadata-observed` row above is therefore
date- and version-sensitive and should be re-probed rather than trusted indefinitely.

## Cleanup

Verified after the pass: no broker process, no `/tmp/cyberdeck-501.sock`, no tmux server, no
dashboard process. No pre-existing user-owned broker or tmux session was killed — none existed when
the pass began.

The broker appended exactly two entries to the pre-existing append-only journal at
`~/Library/Application Support/Cyberdeck/events.jsonl`: `broker.started` and `broker.shutdown`. No
session or job record was created. The journal predates this pass and was deliberately **not**
truncated.

## Zero-call workflow

```bash
mise exec -- pnpm test    # deterministic fixtures only; resolves no provider executable
mise exec -- pnpm probe   # --version only
mise exec -- pnpm exec tsx scripts/probe-provider-capabilities.ts --read-only
```

No fixture invocation contains Fable, an automatic-model or fallback flag, a dangerous permission
bypass, or a real provider executable resolution.

## Current limitations

These are limitations, not pending features, and none is a verified claim about future behavior.

- **No live provider evidence exists for any adapter.** Command construction and parsing are
  fixture-proven; nothing proves a provider accepts what Cyberdeck builds. A Claude result would not
  prove Cursor or Antigravity behavior, and starting a process would not prove conversation
  continuation.
- **The omitted-Claude-model gap is open.** The delegated-Fable guard rejects only an explicitly
  supplied `fable` model. An omitted model still passes, and the recorded baseline observed the
  native default displaying Fable. Every real Claude start must name an explicit ordinary non-Fable
  model. Broker policy does not close this.
- **`control.reconciliation` has a contract/type mismatch.** The broker answers
  `{ reconciledAt: null, … }` when composed without a control-plane runtime, but the A-owned
  `ReconciliationReport` types `reconciledAt` as `string`. B5 widened the field in the presentation
  layer (`ReconciliationView`) rather than edit an A-owned contract. **The final integration gate
  should decide where this is fixed.**
- **The session contract carries no watcher count.** The cockpit states the one-controller/
  many-watcher invariant but cannot display how many watchers are attached, because no field exists.
  It does not invent one.
- **`src/domain/session.ts` still closes `ProviderIdSchema` to `codex | claude`.** Sessions
  therefore cannot name `cursor` or `antigravity`, even though jobs can via the open registry. The
  cockpit renders whatever the record holds and does not paper over the difference.
- **There is no CLI surface for jobs, budgets, queue, or reconciliation.** A5 added none and B5 is
  excluded from adding CLI routing, so this state is reachable only through `cyberdeck dashboard`.
- **Antigravity self-updates.** `agy` replaced itself on disk during the B1 read-only capture. No
  `agy` probe can be described as leaving the installation untouched.
- **`pnpm probe` misreports the Node version.** It resolves `node` with `/usr/bin/which`, so it
  reported `/opt/homebrew/bin/node` `v26.4.0` while the project actually runs under the mise-pinned
  `v24.18.0` (`mise exec -- node --version`). This is pre-existing behavior in
  `scripts/probe-runtimes.ts`, which is not B5-owned; it is reported rather than changed. The
  provider rows are unaffected — `claude`, `agent`, `agy`, and `codex` are not shadowed this way.
