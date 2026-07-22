# Integrated provider acceptance (A5 + B5)

Captured on **2026-07-21** in Europe/Bucharest on darwin 27.0.0 arm64, against the integrated A5
baseline with the B1–B4 adapters composed.

This document describes the cockpit, the zero-call acceptance pass B5 ran, and the independent live
Codex Gate 2 that followed. It does not restate
Phase 1 history: [phase-1-acceptance.md](phase-1-acceptance.md) and
[runtime-baseline.md](runtime-baseline.md) remain the record of what Phase 1 verified, and
[provider-capability-evidence.md](provider-capability-evidence.md) remains the B1 read-only capture.

> **B5 itself made no provider or model call.** After explicit operator authorization, Gate 2 made
> exactly one read-only Codex App Server model turn. No Claude, Cursor, Antigravity, or Fable process
> was started; no authentication, configuration, install, or update command was issued.

## Evidence kinds

The cockpit and the code register keep these separate and never promote one into another.

| Kind | Meaning |
| --- | --- |
| `metadata-observed` | A read-only `--version`/`--help`/status command actually printed this, on this machine, on this date. Version-sensitive. |
| `fixture-proven` | Cyberdeck's own mechanics are proven by a deterministic fixture. Proves what Cyberdeck constructs and parses — never what the provider does with it. |
| `help-advertised` | The CLI's own help mentions it. Not proof it works. |
| `operationally observed` | Observed by running real Cyberdeck control paths (broker, cockpit, tmux) with no provider process involved. |
| `live-proven` | Demonstrated by a real authorized model call; Gate 2 provides this only for the Codex App Server path. |
| `unsupported` | Cyberdeck deliberately does not do this, or the provider documents no surface for it. |
| `not run` | Not attempted, and why. |

The B5 presentation register has no `live-proven` entries because it covers the B-track provider
claims that were not called. `tests/client/provider-capability-view.test.ts` enforces that boundary.
Gate 2's separate Codex evidence below is granted only by the recorded authorized turn.

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
| Omitted-model safety | — | yes — interactive and headless launch boundaries refuse before process construction | — | — | omission remains unsupported for real starts | live negative process proof intentionally unnecessary |
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

Codex is a Phase 1 built-in with an A4 App Server adapter rather than a B-track adapter.
`codex --version` reported `codex-cli 0.144.6` (metadata-observed). Gate 2 live-proved one read-only
headless turn through that adapter, including terminal result, durable artifact, report-back, and
restart reconstruction. Phase 1 interactive behavior remains recorded separately in
[runtime-baseline.md](runtime-baseline.md).

## Final Codex Gate 2 — PASS

Captured on **2026-07-21** after integrating B5 commit `5925cfe7e0fdc29298d9734b85143c180b638f1c`.
The operator explicitly authorized one paid, authenticated, read-only Codex App Server call using
the configured model. The instruction was exactly `Reply with exactly CYBERDECK_GATE_OK. Do not use
tools.`

- Live job `04e3c57e-87c7-48f7-84ec-aabb5588589b` completed once through explicit provider `codex`;
  opaque role `gate-opaque-role` remained presentation data, and no model was selected or inferred
  by Cyberdeck.
- The exact response `CYBERDECK_GATE_OK` was stored as a 17-byte content-addressed artifact,
  resolved before restart, reconstructed from durable job state after restart, and resolved again.
- The delegated child retained correlation with its deterministic parent and its report-back reached
  `delivered` exactly once.
- A third job in the same tree was refused `BUDGET_EXCEEDED`; a conflicting writable lease was
  refused `LEASE_CONFLICT`; the accepted lease was released.
- An omitted-model Claude submission was refused by the then-current explicit-model safety gate
  before any adapter/process boundary. No Fable
  process was started.
- The first live attempt exposed that installed Codex `0.144.6` omits `jsonrpc` on response and
  notification frames. It failed during initialize before `thread/start`, so no model turn was
  spent. The decoder now accepts that observed shape while rejecting an explicitly incompatible
  version; the subsequent single model turn passed.
- Startup found zero jobs/findings/provider processes. Restart reconstructed terminal state with
  zero provider processes and zero reconciliation findings. Teardown found no Cyberdeck broker,
  Codex App Server child, socket, dashboard, or gate temp directory. The pre-existing attached tmux
  session named `main` was left untouched.

The permanent `gate:live-codex` harness is fail-closed behind
`CYBERDECK_RUN_LIVE_CODEX_GATE=1`. Automated tests never set it and make no provider call.

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

- **Live provider evidence exists only for the Codex App Server adapter.** Claude, Cursor, and
  Antigravity remain fixture/help/metadata-proven only; the Codex result does not prove their runtime
  behavior or any conversation-continuation capability.
- **Omitted Claude remains intentionally unsupported, and now fails closed at launch.** The neutral
  stored/delegation policy retains omission, while both current interactive and headless Claude
  launch boundaries reject it before process construction. The recorded native default displayed
  Fable, so every real Claude start must name the intended explicit model. Explicit Fable is now an
  operator choice; autonomous Fable workers require `worker.start.fable`.
- **`control.reconciliation` has an honest nullable pre-pass state.** The shared
  `ReconciliationReport` now types `reconciledAt` as `string | null`, matching the broker's
  `{ reconciledAt: null, … }` response before a control-plane reconciliation pass.
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
- **The final-gate probe resolves the pinned Node correctly.** On 2026-07-21,
  `mise exec -- pnpm probe` reported the mise path and `v24.18.0`; the earlier B5 observation of a
  Homebrew Node was not reproduced and is superseded by the final-gate capture.
