# Strigoi acceptance

Source/fixture acceptance is separate from live qualification. The initial Task 10 source at
`205912f` passed its independent scoped review and integrated checks. The subsequent whole-branch
review found five issues; remediation and a journal-integrity follow-up are now implemented.
Final whole-branch re-review and a fresh controller check/test/build are in progress for the draft PR.
Focused remediation coverage passed; no native provider acceptance or human semantic grading has run.

The selected isolated configuration is Codex `gpt-6.1-sol`, effort `high`, with cwd
`/Users/brandon/code/personal/cyberdeck/worktrees/strigoi-20261114`. Selection does not authorize
inference. The lifecycle, two controller-crash cases and seven semantic pairs require approval
of their concrete invocations before `--allow-inference` is used.

The original measurement table below describes the pre-remediation source. Current packets use
authenticated v2 page traversal and the archive appends incremental records. At 1,024 synthetic
records the final remediation sample read 17 inventory pages, wrote 564,547 index bytes in the
capture interval, and measured 6.36 ms unrelated binding delay during acknowledgement. Full log
validation after each append preserves integrity but leaves quadratic cumulative replay reads:
the final 768-capture interval took 63.06 s. Capture-time authority contention and production
capacity remain unqualified. Existing v1 packets remain readable with their original traversal cost.

## Integrated completion status

The controller's first full suite failed: 16 tests in 4 files, with 304 files / 4,145 tests
passing and 27 skips (457.43s). The full failed log is preserved. Pre-review completion fixed
optional Fleet inspection validation and updated the three stale palette/catalog/identity
expectations. The final focused run passed all four files plus affected Fleet, MCP, identity
and architecture checks: **12 files / 328 tests**, with typecheck passing. The controller's final
`pnpm check`, `pnpm test --maxWorkers=2`, and `pnpm build` all exited zero. The full rerun passed
**308 files / 4,168 tests**, with **1 file / 27 deliberate skips**, in **456.14 seconds**.
The opt-in scaling measurement was run separately. This is source/fixture evidence, not an
independent review or live qualification result; exact commands and log hashes are in the manifest.

Legacy Fleet performs one optional `strigoi.inspect` call. Unsupported RPC and malformed
inspection replies omit only resident display data, preserving ordinary rows and unknown
provider activity. Valid resident identities and hold details remain visible. No key handling,
worker allowlist, grant checks, liveness authority or Unknown-status implementation changed.

## Mechanical evidence

[Fault harness](../../tests/fixtures/strigoi/harness.ts) and
[production fixture](../../tests/fixtures/strigoi/production.ts) exercise the actual
SessionRegistry, instruction queue/receipts, production native-turn parser, immutable
packet/source stores, continuity, succession, worker coordination/custody, attention and
liveness. Provider OS processes and native responses alone are scripted. Native responses
contain synthetic JSON receipts, not semantic judgments. The harness makes no transition
or lease decisions; those belong to the production services.

Physical resident launch/exit counters retain the **maximum over the run**, including failed
effects, rather than reporting only the final active row. Assertions require <=1, durable
accounting for every accepted input, no repeated rendered instruction IDs, exact expected
holds, and automatic routine delivery. Persisted stores and participants are reopened.
Known fixture process ownership/custody survives service reconstruction; this is not proof
of surviving a real broker death. No provider-native or arbitrary external action is covered
by a claim of exactly-once effects.

| Boundary / scenario | Evidence |
| --- | --- |
| Every requested/checkpointing/sealed/retiring/launching/committed/adopting/reconciling/complete phase | Before/after actual CAS and before/after actual append-handle fsync in `strigoi-recovery.test.ts` |
| Aborted and suspended transitions | Exact terminal/desired-state checks; Task 6 suspension-at-each-phase regression |
| Lost checkpoint/adoption/stop/launch/adoption-receipt/worker/attention/delivery responses | Real effect executes, injected response loss, fresh services reopen the journal |
| Persisted stop/launch/adoption intents without a proven effect | Named holds below; no blind retry |
| Actual controller SIGKILL/restart after passive activation and before reserved launch | `strigoi-supervisor.test.ts`: fresh child process, production participants and persisted session recovery; exact hold, zero restart launches/submissions; synthetic process exits on controller pipe EOF |
| Input/result/cancel/grant concurrency | Actual queue, native receipt, attention cancellation and current grant writes concurrent with driver advance |
| Three renewals, no checkpoint process loss, retained old originals | Original rationale remains in immutable packet pages; no routine hold; one queued worker delivery |
| Corruption introduced after startup | Ordinary primary/peer grants and delivery remain usable; resident and unknown identities still reject; conservative retention remains fenced |
| Retained-history scaling | Opt-in `strigoi-scaling.test.ts`; synthetic 64/256/1024 inventories, packet traversal/ack time and unrelated binding-write delay |

Only these crash-ambiguity holds are accepted by this matrix: `checkpoint-outcome-unresolved`
for a recorded checkpoint attempt without a receipt; `adoption-outcome-unresolved` for a
recorded adoption attempt without a receipt; `retirement-unconfirmed` for a recorded stop
without observed exit; `launch-ownership-unresolved` for launch intent without an owned
runtime. Source IDs must exactly match the transition predecessor and, if allocated, its
successor. A generic error or any routine hold fails. Separate existing regression suites
assert `STRIGOI_WORKFLOW_CONTINUATION_REQUIRED` with the original run/message/session IDs,
unknown instruction outcomes, actual authority changes and missing evidence. Workflow
participant migration is still not supported; a pending archived-session reply is retained
for explicit continuation, never silently discarded or automatically retyped.

## Reproduce source checks

Use Node 24.18.0 and the specified environment on every command:

```sh
rtk proxy env PATH=/Users/brandon/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm exec vitest run tests/integration/strigoi-succession.test.ts tests/integration/strigoi-recovery.test.ts --maxWorkers=1
rtk proxy env PATH=/Users/brandon/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm exec tsc -p tsconfig.json --noEmit
rtk proxy env PATH=/Users/brandon/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm exec vitest run tests/architecture --maxWorkers=1
```

The controller runs final `pnpm check`, `pnpm test`, `pnpm build` with isolated fixture
socket permission after source stabilizes. A worker-sandbox partial suite is not full PASS.
Scaling is separately invoked with `STRIGOI_MEASURE_OUTPUT=/absolute/private/output.json`
in the same `rtk proxy env ...` command, then `pnpm exec vitest run
tests/integration/strigoi-scaling.test.ts --maxWorkers=1`. Run it without competing test
jobs. One sample per inventory reports an observation, not a capacity or latency SLO.

## Historical pre-remediation retained-history observation

One isolated warm-process run on Node 24.18.0, with no competing test jobs from this worker:

| Synthetic retained records | Packet pages | Traversal ms | Acknowledgement ms | Unrelated binding baseline ms | Unrelated binding during ack ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 64 | 2 | 15.7 | 24.9 | 4.0 | 27.2 |
| 256 | 5 | 115.7 | 140.9 | 5.2 | 142.2 |
| 1024 | 17 | 533.9 | 446.2 | 7.1 | 446.3 |

This confirms observable binding-authority contention. The largest synthetic packet had
1,042 references and a 497,708-byte source index; incremental capture of the final 768
records took 37.1 seconds. These are single samples, not percentiles, a production limit,
or an asymptotic benchmark. Page-size bounds do not bound aggregate work. Retention is
unbounded by design, so practical growth risk remains for the final reviewer/operator.
No latency SLO was supplied and no correctness failure was found in this bounded run;
no unrelated optimization or retention-policy change is included. Raw measurements and
sample limitations are embedded in the evidence manifest.

## Concrete isolated live runner (NOT RUN)

The runner composes the actual Task 7/8 participants before starting the queue. Its private
native home owns daemon/config/transcripts/sockets; it creates no Fleet/nvim and never opens,
removes, restarts or sends a command to the primary broker socket. The primary may remain
running. A new **absent** short state path is required; existing evidence and symlink aliases
are refused. Only the existing auth file is linked for native login. Private bodies, receipts
and credentials stay in the chosen state directory, outside Git. An exclusive lock marker,
fsynced process-ownership journal and final cleanup report preserve resource identities.
Cleanup stops owned sessions and invokes daemon stop with the isolated CODEX_HOME only;
unsupported native cleanup is explicitly unqualified and evidence is retained.

The selected model/cwd/effort are recorded above. The following reusable template still requires
those exact arguments and explicit execution approval; it is **not authorized to execute live**. Choose a fresh suffix for every run; an existing directory is refused.

```sh
rtk proxy env PATH=/Users/brandon/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm exec node --import tsx scripts/run-live-strigoi-gate.ts --mode lifecycle --state-directory /tmp/sg-operator-01 --cwd /OPERATOR/SELECTED/CWD --model OPERATOR_SELECTED_MODEL --validate-only
```

After reviewing that exact invocation and its output, operator approval replaces
`--validate-only` with `--allow-inference` and optionally adds explicit `--effort`.
This gate runs ten minutes of idle inspection, ordinary conversation, a real worker/result
and attention wait, three renewals, confirmed process exit, durable service reopen, and an
ordinary no-handoff conversation for human comparison. No automatic model fallback exists.
A provider modal or unavailable native capability is a failure/unqualified result, not an
excuse to inject terminal approval or substitute fixture evidence.

`gate-result.json` records source SHA/dirty status, Node/provider versions, model/effort/cwd,
phase timings, packet/coverage IDs, process ownership, canonical passive turns, submission
encoding attempts, unknown usage/cost and cleanup. Provider-initiated upstream inference
requests cannot be fully observed by the current adapter: `inferenceRequests.observed` is
null and passive qualification remains **UNQUALIFIED**, even if submissions and canonical
turns are zero. Do not relabel zero completed turns as zero inference requests. A provider
request-level trace is still required for the passive acceptance gate. The lifecycle mode itself still uses service reopen. The separate crash mode below actually
kills and restarts a child controller; native provider crash qualification remains NOT RUN.

## Separately supervised controller crash path

Select `--mode crash --case passive` or `--case reserved-launch`, each in a fresh absent state
directory. The first stops after initial passive activation without a checkpoint; the second
stops in the actual provider preparation seam after durable reservation/provisional session
persistence and before process spawn. A private IPC channel reports the boundary. The parent
fsyncs its journal, sends SIGKILL through its own live ChildProcess handle, awaits that exact
child's exit signal, then starts a new child with the same state and recovered session records.
This is a real controller-process death, not same-process service reconstruction; it composes
production Task7/8 services but does not expose the full broker socket/server.

```sh
rtk proxy env PATH=/Users/brandon/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm exec node --import tsx scripts/run-live-strigoi-gate.ts --mode crash --case passive --state-directory /tmp/sg-crash-01 --cwd /OPERATOR/SELECTED/CWD --model OPERATOR_SELECTED_MODEL --validate-only
```

Repeat with `--case reserved-launch` and `/tmp/sg-crash-02`. Live execution still requires
explicit approval of each exact invocation and `--allow-inference`; no provider was run here.
Native startup may require credentials/remote-control/modal support. An unavailable boundary
fails the run rather than pretending it was a successful injected crash.

Expected outcomes are deliberately conservative:

- `passive`: `retirement-unconfirmed`, exact predecessor session ID, unchanged active binding
  and incarnation, zero restart launches/submissions. No exit callback survived to prove native
  retirement, even when a synthetic process independently exits after pipe EOF.
- `reserved-launch`: `launch-ownership-unresolved`, empty source IDs as emitted by the production
  lifecycle hold, the same reserved successor ID, zero restart launches/submissions and unchanged
  incarnation. The runner never infers that a missing owned handle proves the process was absent.

`EXPECTED_HOLD_NO_DUPLICATE` qualifies those specific crash outcomes only. Routine renewal still
requires automatic completion without a hold. `crash-result.json`, `supervisor.jsonl` and
`child-resources.jsonl` retain selection, source/CLI versions, timestamps, process identities,
pre/post states, holds and cleanup scope. The parent creates an exclusive private directory/lock;
existing directories, aliases and stale lock markers cannot be resumed. Cleanup uses only live
child handles from this invocation. It never signals stored PIDs or process groups, discovers the
primary broker, or asserts retirement from process absence. The native daemon/home may survive
controller death: native orphan cleanup remains **UNQUALIFIED**, the directory is retained for
operator inspection, and the runner cannot be reused to kill old resources. Synthetic transport
uses a real Node child with a controller-owned stdin pipe and independently records EOF before
exiting; no provider executable or authentication is used in those tests.

Request observability inspection: `CodexProviderAdapter.submitInput` only encodes PTY input;
`ThreadTranscriptStore.readCompletionLedger` counts canonical completions;
`readProviderBudgetTelemetry` and `parseCodexBudgetTelemetryLine` read cumulative token/allowance
frames. None supplies a complete request-start/end/error trace for upstream inference. No
complete counter is inferred from these surfaces: request count stays null and **UNQUALIFIED**.
No telemetry proxy or provider/security expansion was introduced.

## Human semantic review

The versioned [case rubric](../../tests/fixtures/strigoi/semantic-cases.json) defines cases and
anchored 0–2 scores for intent retention, uncertainty, evidence use, appropriate initiative
and next action. Pass requires >=8/10, no critical failure, and human review with original
source/action IDs. Models cannot certify their own scores. Evaluate Alfred addressing,
changed instructions, unresolved choice, stale evidence, delegated versus personally managed
Orcs, uncertain effects and the original constraint/rationale across three handoffs.

Each case is selectable and fully specified in the rubric's `execution` object: exact prefixed
inputs, continuation question and renewal count. No conversation adaptation or evaluation code
is needed. Use one fresh private directory per pair. The semantic mode creates a fresh resident
and an ordinary no-handoff Orc with the same provider/model/effort/cwd, submits identical fixed
inputs to both, then renews only the resident before each matched continuation. This mode does
not claim the ten-minute passive gate; that remains the separate lifecycle mode.

| Case ID | Fixed scenario | Resident renewals |
| --- | --- | ---: |
| `alfred` | Same resident alias, entrusted review, outstanding publication approval | 1 |
| `changed-instruction` | Publication plan superseded by explicit review-only instruction | 1 |
| `unresolved-choice` | SQLite vs PostgreSQL; concurrent writers unknown; choice remains open | 1 |
| `stale-evidence` | CI-A passed; revision B has no result | 1 |
| `delegated-vs-personal` | Entrusted worker D vs operator-managed Orc P; no grant to P | 1 |
| `uncertain-effect` | EFFECT-17 submitted once, response lost, outcome unknown | 1 |
| `three-handoffs` | ORIGINAL-1 review-only constraint and unverified-evidence rationale | 3 |

Concrete validate-only template (repeat with each exact case ID and a fresh short directory):

```sh
rtk proxy env PATH=/Users/brandon/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm exec node --import tsx scripts/run-live-strigoi-gate.ts --mode semantic --case alfred --state-directory /tmp/sg-sem-01 --cwd /OPERATOR/SELECTED/CWD --model OPERATOR_SELECTED_MODEL --validate-only
```

After separate operator approval, replacing `--validate-only` with `--allow-inference` executes
that one pair. `semantic-pair.json` saves every exact prompt, completed instruction receipt,
provider transcript output, renewal transition and packet reference after each step. Unknown
native receipts or a held renewal fail the run and leave the pair INCOMPLETE. All scores and
human review fields remain unset; capture success is never semantic PASS.

The human reviewer reads original inputs, both arms' native outputs, all packet references and
available action traces; scores both arms on the five anchored criteria; and records reviewer,
date, source IDs/quotations, action differences and verdict rationale in the private rubric copy.
For `three-handoffs`, review all three intermediate continuations, not only the final answer.
Require >=8/10, no critical failure, and no unexplained failure/safety regression against the
matched baseline. Models' self-scores are ignored. Missing pairs or review remain NOT RUN.
These cases test stated next actions on explicitly synthetic facts, not actual publication or
worker custody effects (those have separate mechanical coverage). Private bodies remain outside
Git; only sanitized scores, hashes, version metadata and verdicts enter a public manifest.

See [evidence manifest](strigoi-evidence-manifest.json) for source/fixture evidence and remaining
gates. The local detailed worker report/logs live under
`.superpowers/sdd/2026-11-14-strigoi/task-10-report.md` and `task-10-logs/`.
