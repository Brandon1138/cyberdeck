# MIK-84: Autonomous loops inside Cyberdeck's bounded system

Research only. No code changes accompany this document, and none should follow from it before the
architecture refactor (MIK-94 / GitHub #51) lands — see [Recommendation](#8-recommendation). Every
claim below is checked against the code and docs on `main` at `e22acbf`, as of **2026-08-18**, not
against what the feature is supposed to do.

> **Revision note.** The first draft of this document was written 2026-08-16 against `main` at
> `8576bcc`. Eleven commits landed between then and now, four of which change load-bearing claims:
> MIK-88/MIK-89 (`939bd29`) gave the worker plane a turn ledger with stated provenance and an
> instruction lifecycle with a delivery-hold ladder; MIK-93 (`502c2fd`) made admission ordering fair
> under a tie; MIK-85 (`5bc34bd`) gave the operator a lease-derived answer to "who owns this worker";
> and MIK-96/MIK-97 (`e22acbf`) _removed_ the `worker.start.cursor` capability the first draft cited
> as precedent for a loop-start gate. §§2.3, 3.3, 4.3 and 7 are materially different as a result.
> This revision also assumes MIK-98 (GitHub #55) resolves as **option 1** — peer bindings get a
> durable controller family — which is being implemented in parallel and is treated here as given.

## 0. What "loop" means here

MIK-84 asks about _autonomous loops_: runs that keep going — on a timer, in response to an event, or
by continuing themselves — without an operator initiating each turn. Cyberdeck has no such primitive
today. It has two substrates a loop would have to be built from:

- The **job plane** (`src/domain/job.ts`, `src/control-plane/**`): bounded, one-shot, headless work
  with an immutable request and a terminal result. It has real admission control, real budgets, and a
  real reconciler.
- The **worker plane** (`src/domain/worker-coordination.ts`, `src/broker/worker-coordination.ts`,
  `src/domain/worker-truth.ts`): durable, controller-owned, multi-turn interactive workers with
  leases, checkpoints, decision gates, an instruction queue, and — since MIK-88/89 — an authoritative
  per-worker state machine and a turn ledger. It still has none of the job plane's budget,
  admission, or reconciliation machinery.

The central fact this document keeps returning to: **a loop is shaped like a worker, not a job** — it
needs turns, checkpoints, and steering — but **the enforcement machinery that already exists is built
for jobs, not workers.** Closing that gap is most of what "post-refactor, loops become buildable"
should mean. §7 makes this an explicit prerequisite list; that list is this document's primary
output.

What changed since the first draft is _not_ that gap. It is that the worker plane now has an
honest **unit of account** it previously lacked. Before MIK-89, "one turn" was whatever the screen
scrape happened to notice; a worker that finished behind a dialog banked nothing, and
`workers_wait` on `completionTarget: 1` could never settle. A turn budget built on that number would
have been a budget denominated in a quantity the broker could not reliably count. That is no longer
true, and §2.3 rests on it.

## 1. Trigger model options

The trigger is the answer to one question: **what starts a loop iteration.** Three shapes are
available, with very different amounts of existing substrate under them.

### 1.1 Schedule (cron / interval)

Nothing in the codebase schedules anything. A repo-wide search for a periodic dispatch primitive
(`setInterval`, `cron`, a recurring-task table) turns up one hit outside tests — the App Server
adapter's request-timeout timers (`src/app-server/dispatch-adapter.ts`) — plus an internal 100 ms
socket-close timer in `src/broker/server.ts`. Neither is a scheduler. Building schedule-triggered
loops means building one from nothing: a durable "when next" store, a broker-owned tick, and —
critically — a decision about what happens when the broker was down across a missed tick.
Cyberdeck's whole persistence story is "never resume, never redispatch automatically"
(`docs/architecture/persistence-and-recovery.md`), so the only answer consistent with the rest of
the system is _report the missed tick, never catch it up silently_.

**Trade-off.** Cheapest to reason about (it depends on nothing else finishing first) and the easiest
to bound — a schedule has an obvious off switch, which is to stop enqueuing. But it is pure new
surface: no existing broker component partially does this. And a schedule answers only "when"; it
says nothing about "why now is safe," which this document treats as a bounding control (§2), not a
trigger property.

### 1.2 Event (react to something Cyberdeck already observes)

This is the trigger model with the most existing substrate to build on:

- **Workflow messages** (`src/domain/workflow.ts`) are already a passive-by-default, bounded
  inter-session mailbox: a `WorkflowMessage` is inert unless `wake: true`, and a `WorkflowRun`
  carries durable `maxMessages` (100, hard max 1 000), `maxTurns` (20, hard max 200) and `maxHops`
  (8, hard max 50) ceilings (`WorkflowLimitsSchema`, `src/domain/workflow.ts:3-7`). "Wake another
  session on a message" is close to an event trigger already, just not exposed as one.
  `docs/architecture/session-model.md` documents the passivity, and notes that cancelling a run does
  not stop participants already running.
- **`DECISION_REQUEST` / `CHECKPOINT` events.** A worker or its orchestrator can raise a durable,
  correlation-idempotent checkpoint (`requestCheckpoint`, `src/broker/worker-coordination.ts:968`)
  answered through the normal event-submission path (`submitEvent`, `:644`). An event-triggered
  iteration is naturally "the next thing that happens after this checkpoint is answered."
- **Instruction lifecycle transitions**, new since the first draft, are now a third candidate, but
  `completed` is not sufficient by itself. `InstructionLifecycleStateSchema`
  (`src/domain/worker-truth.ts:260-277`) runs
  `accepted → queued → rendered → submitted → acknowledged → completed`, with `undelivered` and
  `cancelled` as terminals, and `instructionTransitionAllowed` (`:296`) pins the legal moves. The
  screen path in `SessionRegistry.completeSemanticTurn` calls
  `advanceRenderedInstructions(runtime, "completed", runtime.completedTurns)` even when transcript
  capture produced only a `terminal-replay` scrape (`src/broker/session-registry.ts:2673-2754`). Only
  `recordCompletion(..., "provider-transcript")` increments `canonicalTurns` (`:2522-2536`). The
  autonomous trigger must therefore join the lifecycle edge to the matching completion-ledger entry
  and require `provenance: "provider-transcript"`, or equivalently prove that `canonicalTurns`
  advanced for that instruction's `expectedTurn`. A bare `completedAt` is observability, not authority
  to enqueue another iteration.

**Trade-off.** Reuses a durable, correlation-checked lifecycle, but the proof needed to authorize
recursion is not durable in that record today: `CompletionLedgerEntry.provenance` lives in the runtime
completion map, while `InstructionRecord` persists only `completedAt`. The design must persist the
matching completion target and provenance through `InstructionStore` and `LoopRunStore` (§§3.2, 6).
The first two mechanisms were also built for _bounded_ fan-out (a workflow run has hard caps; a
checkpoint answers exactly one correlation), and neither was built to be the outer trigger of an
indefinitely recurring run. Reusing them means either loosening those caps — risky, since the caps are
the only thing currently stopping a wake chain from running forever — or treating each loop cycle as
a fresh, separately-admitted run. The latter is safer and composes with §2's per-iteration bounding.
Triggering on a **provenance-qualified**
`instruction → completed` avoids the dilemma entirely: it observes an edge that already exists
rather than widening a cap that exists to stop recursion. The adapter must publish the instruction
id, `expectedTurn`, completion target, completion provenance, and before/after `canonicalTurns` in one
normalized boundary fact; if those facts do not agree, the loop stops fail-closed and surfaces
`operatorActionRequired` rather than retrying from a scrape.

Cursor and Antigravity can never satisfy this trigger: `ThreadTranscriptStore.captureProviderTurns`
returns native turns only for Claude and Codex, and makes fallback the only turn for Cursor and
Antigravity (`src/persistence/thread-transcript-store.ts:174-188`). A loop definition using
instruction completion or self-continuation must therefore be refused for those providers. A known
incapable provider is not allowed to start and then wait forever; a temporarily missing native turn
on a capable provider makes the current run terminal with an unprovable-completion finding. Such a
provider may still participate in schedule-, workflow-, or checkpoint-triggered loops only under the
explicit independent-trigger contract in §2.3: finite iteration and wall-clock bounds are required,
`maxCanonicalTurns` is absent, and no provider counter is approximated.

### 1.3 Self-continuation

This is the option most people mean by "loop," and it is the one Cyberdeck's own tool surface most
actively resists. The worker-facing MCP wrappers a worker actually gets are
`cyberdeck_signal_exception`, `cyberdeck_report_progress`, `cyberdeck_signal_risk`,
`cyberdeck_request_decision`, and `cyberdeck_respond_checkpoint`
(`docs/architecture/worker-coordination.md`) — report and answer-a-checkpoint tools. A worker holds
no `cyberdeck_worker_ctl` / `cyberdeck_lease` access; those are orchestrator-facing and require a
**stable controller identity**, which a worker's own session can never hold for itself (a worker is a
lease _subject_, never a lease _controller_). Concretely: nothing a worker's own process can call
re-instructs that same worker. Continuation can only be driven by whatever already holds the
controller lease — an orchestrator's durable binding, or a human controller — reading the worker's
output and choosing to re-enqueue through the instruction queue
(`SessionRegistry.submitInstruction`, which writes provider input without cancelling the active
turn).

**Trade-off.** This is a feature, not a gap to route around. "Self-continuation" that is genuinely
worker-mediated — the worker decides its own next turn with no external read of its output — has no
natural stopping point and no natural audit seam. The only thing that could stop it is the worker
itself, which is exactly the actor a runaway-loop kill switch cannot trust. Controller-mediated
continuation — a bounded loop-controller reads a checkpoint or a provenance-qualified instruction
completion, evaluates it against §2's gates, and either re-enqueues or stops — keeps the existing
invariant that a human
control attachment has absolute writer priority (`docs/architecture/session-model.md`), and keeps a
real actor with a real lease accountable for every "again."

**Recommendation:** build self-continuation only in this controller-mediated shape. Do not add a
worker-side auto-continue tool. Every active `LoopRun` gets one **dedicated** loop-controller binding
for its full lifetime: it drives that run's sequential iterations, and no active controller may own a
second `LoopRun`. Concurrent runs therefore use distinct controller bindings. This is deliberately
one controller per run, not one per iteration and not a shared controller service: `StopLoop(runId)`
can stop only that run's controller after settling its targets, while Fleet can force-stop that exact
controller if it ignores graceful termination.

### Summary

| Trigger                           | Existing substrate                                                               | New surface required                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Schedule                          | none                                                                             | a durable scheduler and a missed-tick policy, from scratch                                                                       |
| Event — workflow wake             | `WorkflowRun` caps, `wake: true`                                                 | loosen or wrap caps for outer-loop use                                                                                           |
| Event — checkpoint answered       | `requestCheckpoint` / `submitEvent`, correlation-idempotent                      | a controller that acts on the answer                                                                                             |
| Event — `instruction → completed` | `InstructionLifecycleStateSchema`, completion provenance, canonical turn banking | a controller that joins the edge to a matching provider-transcript completion; unavailable where native transcript is impossible |
| Self-continuation                 | instruction queue, controller-mediated only                                      | a bounded loop-controller role that _is_ the lease controller                                                                    |

## 2. Bounding controls

### 2.1 Leases and ownership for a run nobody is watching

The worker plane's `OwnershipSubject` lease is exactly the primitive an unwatched run needs — it is
already designed for "the controller went away, now what":

```text
released --acquire--> active
orphaned/expired --adopt--> active
active/contested --renew/authenticated call--> active
active/contested --same stable family reacquire--> active (new token/version)
active/contested --conflicting acquire/adopt--> contested
active/contested --release--> released
active/contested --TTL or observed-disconnect grace--> expired --> orphaned
```

(`src/domain/worker-coordination.ts:46-52`, `docs/architecture/worker-coordination.md`.) Tokens are
random, SHA-256-hashed at rest, bound to a _stable family_ identity rather than a conversation UUID
(`ControllerIdentitySchema` explicitly rejects a UUID as `controllerId`,
`src/domain/worker-coordination.ts:21-28`), and fenced by a monotonic lease version. A loop iteration
that outlives its watcher degrades exactly the way any unwatched worker degrades today: the lease
ages past its TTL, is swept to `orphaned`, and becomes adoptable — never silently reacquired
(`docs/architecture/worker-coordination.md`: "nothing is ever reacquired silently"). This part of the
substrate is solid enough to build on as-is.

**Two `BUGS.md` entries in this machinery are stale, in the substrate's favour.** Both are still
listed "Open" as of this revision (`BUGS.md:74`, `:90`), and both read as already fixed:

- _"a decision gate is cleared by an answer to any checkpoint, not the matching one"_ (found
  2026-07-27). Current code checks the answered checkpoint's `correlationId` against the subject's
  live `decisionGate.correlationId` before clearing it (`src/broker/worker-coordination.ts:838-843`),
  and `tests/integration/worker-coordination-events.test.ts:404-429` pins the fixed behaviour
  (answering `gate:a` leaves `gate:b` open). Most plausibly closed by the MIK-64/MIK-71 authoritative
  state machine work (`3cbc28f`).
- _"`inactive-controller` adoption is unreachable for a controller that died silently"_ (same day).
  `select()` for that scope returns a subject whose lease is `orphaned`/`expired` and past
  `expiresAt` regardless of whether a `disconnected` liveness observation was ever recorded
  (`src/broker/worker-coordination.ts:1229-1237`), and
  `tests/integration/worker-coordination-ownership.test.ts:295` pins it ("adopts a silently expired
  controller by inactive-controller without taking a live one").

Note that `BUGS.md`'s own preamble says the dated Open/Resolved log "may well be out of date" and
that only the Standing constraints section is non-stale. That is exactly the case here. This design
should not inherit a fear of gaps that no longer exist; the staleness itself is worth the operator's
attention but is outside this document's scope to correct.

**One finding that does not resolve in the substrate's favour, and still holds.**
`WorkerCoordinationService.expireLeases` (`src/broker/worker-coordination.ts:523-588`) is the only
code path that proactively sweeps a subject from `active` to `expired` → `orphaned`. A repo-wide
search for its callers returns **tests only** — re-verified at `e22acbf`. It is never invoked by
broker composition (`src/broker/main.ts`, `src/broker/worker-coordination-runtime.ts`). Expiry is
otherwise evaluated **lazily**, inside an authenticated call (`isExpired`/`expiredCopy`, `:1240-1264`):
a subject's on-disk lease state does not become `orphaned` until _something_ — a renew, an adopt
survey, an event submission — touches it again. For a loop nobody is watching, "nobody is watching"
and "nothing ever touches this subject again" are the same condition, so the lease can sit `active`
on disk indefinitely past its real TTL.

This is not a correctness bug — nothing can act on a stale token, and `OWNERSHIP_LOST` still fires on
the next real attempt — but an operator surveying "what is still running" through any surface that
reads raw lease state rather than calling through the service will see a false `active`. A loop
design needs one of: (a) a real periodic sweep wired into broker startup, or (b) every observability
surface routing through the service's lazy-expiry check. Never both left undone.

### 2.2 Checkpoints and decision-gate placement

Checkpoints are the natural bounding gate for a loop iteration: durable, correlation-idempotent, and
already distinguishing non-blocking progress markers from `decision-gate` checkpoints that pause the
worker's structured `decisionGate` state (`CheckpointRequestSchema.mode`,
`src/domain/worker-coordination.ts:286`). Placement guidance, grounded in what the schema allows:

- **One decision gate per subject, always.** `decisionGate` on `OwnershipSubject` is a single value,
  not a set (`src/domain/worker-coordination.ts:91-95, 105`). A loop cannot have two concurrent
  decision points outstanding on one worker — "should I continue past step 3, and separately should I
  spend the extra token budget" is not representable. Loop design must serialize decision points: one
  open gate, answered, closed, before the next opens.
- **The current checkpoint prompt is not itself a pause.** `deliverCheckpointPrompt` submits another
  provider instruction, and the worker may act during that turn. A correlated `CHECKPOINT` event
  updates the structured gate but `SessionRegistry.deliveryHold` does not consult it, so neither the
  prompt nor that event is an execution boundary. The loop substrate needs a durable phased gate:
  it admits exactly the correlated checkpoint exchange while denying ordinary instructions and
  mutation/tool execution, then becomes a decision-pending hold which only an explicit controller
  decision releases. Human-controller priority still outranks the loop, but it is not a substitute
  for this gate.
- **A decision gate is a pause, not a stop.** `mode: "decision-gate"` changes only the structured
  `decisionGate` field; it does not change the worker's lifecycle
  (`docs/architecture/worker-coordination.md`). A loop-controller reading state alone will not see a
  paused loop as different from a working one — it must read `decisionGate.state`, not
  `WorkerTruthState`.

Recommended placement: arm a `checkpoint-exchange` phase **before** either a checkpoint prompt or the
instruction that would start the next iteration can be delivered. That phase grants a one-shot
exception for the correlated checkpoint prompt and response event, while the execution boundary
rejects ordinary work and provider mutation/tool calls during that turn. Observing the matching
`CHECKPOINT` advances the gate to `awaiting-controller`; it does not clear it. The durable controller
decision is the only release edge from that phase: rejection stops the run, while approval permits
the next iteration instruction to be enqueued and executed. This avoids deadlocking the question
behind its own hold while keeping the worker inert with respect to loop work at every veto point.

### 2.3 Spend, turn, and wall-clock limits — who enforces what

This remains the sharpest finding in this document, with one part of it materially improved since the
first draft. Cyberdeck has real budget enforcement — for the **wrong plane** — but the worker plane
now has a countable turn.

**What exists, on the job plane.** `BudgetLedger` (`src/control-plane/budget-ledger.ts`) enforces
`maxJobs`, `maxWallClockMs`, `maxTotalTokens`, and `maxArtifactBytes` per **job-tree** scope (root
resolved by walking `parentJobId`), admission-time for count/time/already-known usage and post-run
for tokens/bytes, and fails closed (`UNPROVABLE_TOKEN_USAGE`) when a token ceiling is declared but any
settled job in scope reported no usage
(`docs/architecture/concurrency-budgets-and-reconciliation.md`). `AdmissionScheduler`
(`src/control-plane/admission-scheduler.ts`) enforces concurrency ceilings the same way,
deterministically and starvation-resistantly.

**MIK-93 matters here more than it looks.** `AdmissionScheduler.ordered()` now sorts by ascending
`enqueuedAt`, then by the scheduler's own **monotonic enqueue sequence**, and only then by `jobId` as
a defensive final fallback. Before, ties on a millisecond-resolution wall clock were broken by
`jobId.localeCompare` over random UUIDs — releasing same-millisecond submissions in an order unrelated
to arrival. A loop is precisely the workload that produces same-millisecond ties: it submits
repeatedly, mechanically, and from one caller. Two consequences a loop design must carry:

- Loop iterations now release in arrival order under a tie, so a loop cannot reorder itself against
  a concurrent human submission by luck of UUID. `enqueue()` is also a no-op for a known `jobId`, so
  a retrying loop cannot double-queue or push its own waiting iteration to the back of its tie.
- The sequence counter is **per-process and deliberately not persisted**, because the queue is
  in-memory and recovery interrupts everything queued rather than re-enqueuing it. A loop must
  therefore never treat "my next iteration is queued" as durable state. If a loop's queued iteration
  must survive a restart, that durability is the loop's own to provide — and doing it by making
  queued jobs recoverable would require seeding this counter past the highest recovered value, which
  the code comment already calls out.

**What does not exist, on the worker plane.** A grep for `budget`, `maxTokens`, `wallClock`, or
`spendLimit` across `src/domain/worker-coordination.ts` and `src/broker/worker-coordination.ts`
returns nothing. `src/control-plane/reconciler.ts` and `src/control-plane/runtime.ts` never reference
`worker-coordination.ts` or `OwnershipSubject` at all. The two substrates are architecturally
disjoint — confirmed against the code, not inferred from docs. `JobRequestSchema`
(`src/domain/job.ts:22-34`) has no checkpoint or turn concept either; "session is not job" is the
whole point of the split (`docs/architecture/control-plane.md`).

**What is new: a turn the broker can actually count.** `WorkerTruthInput` now carries
`completedTurns` ("turns the broker has counted, canonical or replay-derived") _and_ `canonicalTurns`
("subset of `completedTurns` backed by a provider-native transcript turn")
(`src/domain/worker-truth.ts:135-138`). MIK-89 added `reconcileCanonicalTurns`, which arms on every
chunk, fires after 1.5 s of quiet, and reads the transcript the provider itself wrote — with
`allowFallback: false` and a `provider-native` transport filter, so it is a record rather than a
second guess at the screen. Double-banking is closed four ways, including a synchronously-claimed
`turnCaptureOwner` (`src/broker/session-registry.ts:243`) that decides ownership between the screen
path and the reconcile path rather than discovering it after the fact.

This is the difference between a turn budget that is enforceable and one that is not. **A loop's turn
budget must be denominated in `canonicalTurns`, not `completedTurns`.** `completedTurns` includes
replay-derived turns — a scrape — and a budget that can be inflated by a spinner frame the broker
misread is not a budget. Where a provider writes no native transcript (Cursor, Antigravity; see §5),
`canonicalTurns` will not advance, and the honest consequence is that a turn-budgeted loop is **not
available** for those providers rather than silently falling back to the scrape. That is the same
posture as `UNPROVABLE_TOKEN_USAGE`: unknown usage is unknown, never zero.

**Supported-provider / trigger / budget contract.** Every loop policy, on every provider, declares
finite `maxIterations` and `maxWallClockMs`; the former debits durable `LoopRun.iterationOrdinal`, not
a provider turn counter. A provider with native transcript support (currently Claude or Codex) must
also declare finite `maxCanonicalTurns`; it may use schedule, workflow wake, checkpoint, provenance-
qualified instruction completion, or controller-mediated self-continuation. Cursor and Antigravity
may use only schedule, workflow wake, or checkpoint triggers. They must not declare a turn budget,
and their policy is rejected if it requests instruction-completion or self-continuation. Token limits
remain optional, but any declared token limit fails closed when its provider cannot report usage.
Thus an independent-trigger Cursor or Antigravity run is bounded by durable iteration and wall-clock
limits, never by a fabricated zero, scrape-derived `completedTurns`, or a counter that cannot advance.

**None of that accounting survives a broker restart today.** `BudgetLedger.scopes` is an in-memory
`Map` (`src/control-plane/budget-ledger.ts:68-71`), and `ControlPlaneRuntime` constructs a fresh
ledger on each start (`src/control-plane/runtime.ts:72-95`). Session recovery is equally unsuitable
as a loop ledger: `freshTruthState` initializes both `completedTurns` and `canonicalTurns` to zero,
including for every recovered session (`src/broker/session-registry.ts:319-337, 482-502`). A schedule
store cannot repair this for event-triggered or self-continuing loops because they have no schedule
record. Reconstructing bounds from those reset counters would give a recovered loop a fresh budget.

The target design therefore chooses durable, resumable loop state rather than making every recovery
terminal. `LoopRunStore` persists the `LoopRun` aggregate and its debit journal: immutable policy
snapshot, lifecycle, `startedAt`, current iteration ordinal and id, admitted and settled iteration
ids, cumulative canonical-turn debit, cumulative reported token usage, unknown-usage count, deadline,
last qualified trigger evidence, prompt-free per-iteration settlement/provenance summaries, the
rolling-history cursor, and an immutable stop record (`stopId`, actor, reason, requested time, and
terminal time). Admission and settlement are idempotent by
`(loopRunId, iterationId)` and the store commits the aggregate transition and debit before an external
enqueue or continuation becomes visible. `BudgetLedgerPort` reads and writes this durable state; an
in-memory cache may project it but may never be its authority.

**The one budgeted autonomous worker-plane run today** is the Scout profile: a 15-minute wall-clock
default enforced by settling in-flight output at cutoff and `SIGTERM`ing the process, with `maxTokens`
explicitly deprecated and ignored for termination (`docs/architecture/scout-profile.md`). It is fixed
to one tier, one provider, one model, read-only, and a single wall-clock dimension — a narrow,
hand-built precedent, not a general mechanism. Its shape is nonetheless a reasonable template for a
loop profile's own literal: a fixed profile carrying its own budget, verified at exit, with a
deprecated-but-still-accepted legacy field left in place rather than silently repurposed.

**Who enforces what, in the target design:**

| Bound           | Enforced by                                                                       | Checked when                                   | Failure mode                               |
| --------------- | --------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| Iteration count | loop policy over durable `LoopRun.iterationOrdinal`                               | before enqueuing iteration _n+1_               | stop, terminal, operator-visible           |
| Turn budget     | durable worker-plane budget ledger, denominated in `canonicalTurns`               | native-transcript provider only; admission and settle | refuse next admission; unprovable ⇒ refuse |
| Wall clock      | durable worker-plane budget ledger, Scout-shaped                                  | at admission and by a deadline the broker owns | settle in-flight output, then stop         |
| Token spend     | durable worker-plane budget ledger, where the provider reports usage              | post-iteration                                 | fail closed on unprovable usage            |
| Concurrency     | `AdmissionScheduler`, if iterations are jobs; otherwise a worker-plane equivalent | at admission                                   | queue, never substitute                    |
| Human override  | `deliveryHold` `human-controller`                                                 | on every write attempt                         | hold the instruction, do not write         |

The rows that do not exist yet are every row naming a worker-plane ledger and the store behind them.
**This design resolves that decision in favour of `LoopRunStore` plus a worker-plane
`BudgetLedgerPort` with the job plane's fail-closed posture.** Representing every iteration as a real
job-tree entry would let the existing ledger see it, but reopens how a bounded job with no mid-run
steering hosts checkpoints. Pointing the current `BudgetLedger` at a worker id is not an alternative:
its scope resolution walks `parentJobId`, a field `OwnershipSubject` does not have, and its debit state
is volatile anyway.

## 3. Observability

### 3.1 What the operator sees while a loop runs

Two different freshness stories exist, and a loop design must not conflate them:

- **Push-shaped.** A `DECISION_REQUEST` or pinned `CHECKPOINT` event is durable and stays pinned
  until explicitly resolved (`docs/architecture/worker-coordination.md`). An operator reading the
  event stream sees this promptly; this path is unaffected by the poll cadence below.
- **Poll-shaped.** Fleet's own view of ordinary progress is not. `waitForRefresh` is resumed only "by
  a key, by a chunk of `!` shell output, by `SIGWINCH`, by an attach transition, and by the transport
  closing — and by nothing else" (`BUGS.md:57`, still Open). A loop iteration that completes between
  two 500 ms ticks is up to half a second stale on screen. Nothing about a loop makes this worse _in
  kind_ — but a loop is precisely the thread an operator is _not_ attached to, so its state is read at
  whatever moment they glance over. If a loop ships, "the fleet row is current as of the last 500 ms
  tick" should be stated to the operator explicitly, and anything the operator must not miss should
  deliberately use the push-shaped event path.
- **State vocabulary is already sufficient.** A loop's thread renders from the single
  `projectWorkerTruth` projection (`src/domain/worker-truth.ts`, `docs/architecture/worker-truth.md`)
  the same way any worker's does. `starting`, `working`, `blocked-modal`, `blocked-composer`, `idle`,
  `stalled`, `provider-limit`, `errored`, `stopped`, `exited`, `failed` are all already meaningful for
  a loop iteration with no new plumbing. **A loop does not need its own status vocabulary**, and
  inventing one would re-create the pre-MIK-64 situation where each surface answered "what is this
  worker doing" from its own evidence.

**MIK-88 removed a specific way an unwatched loop could lie.** Before it, `blockedPromptIndexInTail`
enumerated dialog prose, so an onboarding wizard or a session-limit notice left `truth.modalOpen`
false, the worker read `stalled`, and `cyberdeck_thread_message` returned `rendered` for a payload
written into a surface that would never submit it. Detection now keys on the footer affordance — the
one part of a dialog whose shape does not vary with its wording. For a loop this closes the worst
unattended failure available: an iteration enqueued into a dead surface, reported as delivered, with
nobody watching to notice. The enqueue now comes back `queued` with `holdReason: provider-modal`.

### 3.2 Auditability afterward

Reconstructing "what did this loop do, and why did it stop" today means reading across **six
separate durable locations**, none of which join all the way through:

1. `events.jsonl` — the diagnostic `Journal` (`src/broker/journal.ts`), typed by
   `BrokerEventTypeSchema` (`src/domain/events.ts:3-34`). Session, scout, `orchestrator.stop.*` and
   job lifecycle events live here. There is no worker-event or checkpoint type in that enum at all.
2. `orchestration/worker-coordination-v1.jsonl` — the ownership/lease/checkpoint/event/audit
   transaction log. This is where a loop's checkpoints, decision gates and lease transfers live.
3. `control-plane/jobs.jsonl` + `control-plane/leases.jsonl` — job-plane state and worktree leases.
   Relevant only if a loop iteration is ever represented as a job.
4. The durable per-thread transcript (`docs/architecture/session-model.md`) — prompts and provider
   output, monotonically cursored, user-only file permissions, deliberately excluded from the
   metadata journal for privacy.
5. `orchestration/instructions.jsonl` — append-only full snapshots written by `InstructionStore.put`
   (`src/persistence/instruction-store.ts:6-22`). Every snapshot contains `InstructionRecord.message`
   plus actor, target, lifecycle, and correlation fields (`src/domain/instruction.ts:27-53`).
   `InstructionQueue.enqueue`, `applyState`, and `persistState` append again as the instruction moves
   through its lifecycle (`src/orchestration/instruction-queue.ts:61-95, 139-161, 210-222`).
6. `orchestration/workflow-messages.jsonl` — append-only `WorkflowMessage` records written by
   `WorkflowStore.putMessage` (`src/persistence/workflow-store.ts`). Each record retains the full
   message text that can trigger another loop iteration.

None of the six is wrong to keep separate — (4)'s privacy boundary and (2)'s fsynced-transaction
guarantees exist for documented reasons — but nothing stitches them into one "loop run" view. Prompt
text lives in both (4) and (5), not only in the transcript, and retention or privacy analysis that
accounts for one while ignoring the other is false. Shipping loops without a joined audit view asks
the operator to hand-correlate JSONL records by timestamp and worker id, which is a worse audit story
than a single provider conversation gets today.

**A partial join now exists and should be extended.** The instruction record
(`src/domain/instruction.ts:27-53`) already carries `workflowRunId`, `messageId`, `causationId` and
`hop`, alongside `renderedAt` / `submittedAt` / `completedAt` and an `expectedTurn` ordinal fixed at
render time. Add an explicit `loopRunId` to `InstructionRecord`, carry it through every
`InstructionStore.put` snapshot, and include the same id in the coordination-log transaction for the
iteration boundary, checkpoint, lease action, and stop. This joins (2), (4), and (5) without treating
`workflowRunId` as a loop id by convention; matching transcript events must carry both `loopRunId`
and `iterationId` in their data so the join does not depend on timestamps. The completion snapshot
must also carry the matched completion target and provenance required by §1.2. A stop-cancelled
instruction remains a terminal snapshot with `status: "cancelled"`, `cancelledAt`, and
`cancelledByStopId`; that `stopId` names the
immutable stop record in `LoopRunStore` and the matching coordination-log transaction. It is not
compacted into an anonymous terminal reason. A stop-settled instruction that had already reached
`rendered`, `submitted`, or `acknowledged` likewise carries `settledByStopId` and a disposition that
distinguishes `undelivered-before-submission` from `interrupted-after-submission`; `submittedAt`
remains proof that the latter may already have caused irreversible work. Whether the diagnostic
journal (1) and job-plane logs (3) also participate remains an explicit refactor decision;
instruction history and the coordination log are mandatory participants, not part of that open
question.

**Retention actively works against loop history.** `selectExpiredThreads`
(`src/domain/thread-retention.ts:45-78`) retires a finished thread after `maxAgeDays` (7 by default)
or once it falls outside the newest `maxThreads` (200 by default) window, whichever comes first,
unless pinned. A loop producing many short-lived threads across a week will silently age its own
history out on the same clock as everything else — unless whatever creates each iteration's thread also
pins it, and pinning every iteration of a frequent loop defeats the bound entirely (an unbounded
pinned set). That policy does nothing to (5): `InstructionStore.list` folds snapshots to the latest
record per id in memory, but the file itself remains append-only and retains every full prompt and
lifecycle transition (`src/persistence/instruction-store.ts:25-38`). Loop history therefore needs one
joined retention policy, not inheritance of the general thread default. Rotating workers would let
finished-thread retention engage, but it conflicts with the recommended worker-shaped, multi-turn
design and would make lease, model, and provenance continuity an iteration-boundary problem. This
design instead chooses a **rolling per-run window on the same worker thread**. Every loop policy has
finite `maxRetainedIterations` and `maxRetainedAgeDays` values, bounded by platform maxima; there is
no unlimited value. `RetainLoopHistory` runs after every iteration settlement, on a broker-owned
periodic sweep for the age bound, and at reconciliation. The first limit crossed removes full
payloads for the oldest settled iterations even while the thread and run remain active or paused.

That rolling operation is joined by `(loopRunId, iterationId)`: it compacts terminal instruction
snapshots and the matching transcript prompt/output events in one retention transaction, rewrites
each private JSONL atomically, and retains one prompt-free audit tombstone with ids, lifecycle result,
stop disposition, completion target, and canonical provenance. Before deleting payloads, it requires
the same provenance-qualified settlement to be durable in `LoopRunStore`; compaction can never erase
the only proof that authorized a later iteration. The current iteration, an unsettled iteration, and any
`accepted` / `queued` / `rendered` / `submitted` / `acknowledged` instruction are never eligible.
Pinning exempts a finished loop from general thread expiry, but **does not exempt it from the rolling
payload window**; otherwise pinning one active self-continuing thread recreates the unbounded history
this policy exists to prevent. Finished-thread retention later removes the remaining bounded window
and tombstones from both stores together.

### 3.3 Provenance: who owns this unwatched run (new since MIK-85)

The first draft had no answer to "at a glance, which orchestrator does this unwatched worker belong
to." MIK-85 (`5bc34bd`) provides one, and it is close to purpose-built for loops.

Each bound orchestrator gets a deterministic one-cell sigil from `◆ ◇ ▲ △ ■ □ ● ○`, hashed from its
durable controller identity, and the same shape closes every worker row whose lease it currently
holds (`src/client/owner-sigil.ts`). Three properties make this load-bearing here:

- **Ownership is read from the current lease controller, never from the creator recorded at
  dispatch.** That is precisely the question a loop poses: not "who started this" but "who is
  accountable for it right now."
- **Three states, not two.** A sigil for a held lease; `⊘` (`ORPHANED_OWNER_SIGIL`) for a worker that
  _was_ dispatched and now has no holder; nothing at all for a worker no controller ever held — the
  operator's own. `⊘` is exactly the rendering of "a loop whose controller died," which is the state
  §2.1 says an unwatched run degrades into. An operator scanning the fleet can now see it without
  querying anything.
- **Nothing is allocated and nothing is persisted.** The assignment is a pure function of the live
  roster, so it survives redraws, `--no-color` and broker restarts with no ledger to reconcile. The
  broker answers `fleet.orchestratorOwnership` with the controller identity each bound session speaks
  for, _derived from the binding key_ (`src/broker/server.ts:474`, read at
  `src/client/fleet.ts:731-746`).

Selection doubles as an ownership lens: while an orchestrator row is selected, every worker it does
not own drops to low intensity. For a loop that spans many workers under one controller, that is a
one-keystroke answer to "show me everything this loop owns."

Two limits to record. The alphabet is eight glyphs; a ninth concurrent orchestrator falls back to a
letter. A loop controller is dedicated per active `LoopRun` (§1.3), so this capacity pressure must be
visible rather than solved by sharing a controller whose stop action would cross run boundaries. One
such binding drives all iterations of its own run, never one binding per iteration. And because `⊘`
follows the _lease_, the §2.1 lazy-expiry finding leaks into this surface: a lease nothing has touched
still reads `active`, so the worker shows its owner's sigil rather than `⊘`. The sweep prerequisite
(§7.2) is what makes this display honest for a run nobody is watching.

## 4. Failure and kill-switch behaviour

### 4.1 Kill-switch paths

Two control paths exist, but only one can currently escalate to `SIGKILL`, and it is not
operator-direct:

- **Operator-direct, graceful only.** Fleet's stop action sends `session.stopOne`
  (`src/client/fleet.ts:3423-3430`), which calls `SessionRegistry.stop`
  (`src/broker/server.ts:429-433`). `stop` sends `SIGTERM`, sets `stopRequested`, and treats every
  later graceful request as an idempotent no-op (`src/broker/session-registry.ts:1253-1285`).
  `session.delete` is cleanup, not a kill path: `SessionRegistry.delete` refuses while `exitCode` is
  `null` (`:1380-1388`). This path bypasses capability and lease checks, but it cannot terminate a
  controller that ignores `SIGTERM`.
- **Peer-mediated.** `stopOrchestrator` (`src/orchestration/agent-control-service.ts`) refuses far
  more than it allows: a target stopping itself ("cannot stop itself through the peer-control tool"),
  a target that still owns non-terminal workers (`REQUIRES_HANDOFF`, MIK-55 handoff required first),
  and — separately from the handoff check — a **healthy live or starting** target outright
  (`APPROVAL_REQUIRED`, "Healthy live orchestrators require explicit operator authority"). Only past
  that gauntlet does the graceful-then-force escalation apply: `isStopRequested` must already be
  true, `forceStopGraceMs` must have elapsed, and only then `SIGKILL`. The worker-level escalation in
  `src/orchestration/worker-control-service.ts` mirrors it exactly.

For a loop that is itself orchestrator-shaped — a chain of workers under one binding, per §1.3 —
**nothing short of the operator's direct path can kill it while it is actively working.** A peer tool
cannot; the loop cannot stop itself. That is the correct default: it prevents a rogue peer from
silently killing a live loop. But the direct path is not currently a complete kill switch:
`SessionRegistry.forceStop` can send `SIGKILL` to an already-stopping process
(`src/broker/session-registry.ts:1288-1296`), while no operator-direct RPC or Fleet action exposes it.

The target design must add an operator-only `session.forceStopOne` RPC and matching Fleet escalation.
It is a second step after `session.stopOne`, requires `stopRequestedAt` to exceed the configured grace
period, calls the existing `SessionRegistry.forceStop`, and appends an audit event naming the operator,
session, loop run, graceful-request time, and escalation time. It performs no controller-lease,
handoff, or loop capability check: those checks would let the runaway controller veto its kill
switch. Fleet must keep the loop-controller visible as a normal orchestrator row, show the force
action while `exitCode` remains `null`, and report process exit before enabling delete.

**Stopping policy and stopping the processes are one ordered operation, not independent buttons.**
`StopLoop` first crosses a durable linearization point in `LoopRunStore`: under a run-scoped exclusion
shared with instruction delivery, it moves the run to non-runnable `stopping`, writes the immutable
stop request, and atomically revokes delivery authorization for every instruction belonging to the
run. `stopping` is deliberately not `stopped`; the stop record has `requestedAt`, but no `terminalAt`
yet. `InstructionPort` then materializes every `accepted` / `queued` record as `cancelled`. The current
instruction state machine already permits `accepted → cancelled` and `queued → cancelled`
(`instructionTransitionAllowed`, `src/domain/worker-truth.ts:281-300`); those are exactly the records
the current `InstructionQueue.flush` selects as pending. Each durable cancellation carries
`cancelledAt` and `cancelledByStopId`.

`StopLoop` next snapshots every iteration target and its instruction state. A target with a
`rendered`, `submitted`, or `acknowledged` instruction is in flight and must be terminated before the
loop-controller: `rendered` means bytes are visible but unconsumed, `submitted` means the provider
consumed them, and `acknowledged` means its turn started
(`InstructionLifecycleStateSchema`, `src/domain/worker-truth.ts:260-277`). The
`WorkerTerminationPort` adapter requests graceful termination through `SessionRegistry.stop`, waits
for the session record to report `exitCode !== null`, escalates after the configured grace period
through `SessionRegistry.forceStop`, and waits again. The real methods are signal operations, not
settlement operations: `stop` records `stopRequestedAt` and sends `SIGTERM`, while `forceStop` requires
that request and sends `SIGKILL` (`src/broker/session-registry.ts:1245-1296`). Neither method's return
proves process exit.

Exit observation is the settlement boundary. `SessionRegistry.handleExit` records the exit and calls
`advanceRenderedInstructions(runtime, "undelivered")`
(`src/broker/session-registry.ts:1800-1819`); that helper applies the real transition table and
publishes the instruction update (`:2633-2670`). `StopLoop` must additionally wait until
`InstructionQueue.applyState` has made that terminal update durable in `InstructionStore`; its
listener is asynchronous today (`src/orchestration/instruction-queue.ts:139-166`). A
rendered-but-unconsumed instruction therefore settles as stop-linked `undelivered` with disposition
`undelivered-before-submission`, and the terminated worker can never consume it later. If it races to
`submitted` or `acknowledged` first, the same existing table permits `undelivered`, but the audit
disposition is `interrupted-after-submission` and preserves `submittedAt`; stopping cannot claim that
already-started external work was undone. This distinction is required even though the enum comment
describes `undelivered` as pre-consumption: the actual table permits both `submitted → undelivered`
and `acknowledged → undelivered` (`src/domain/worker-truth.ts:273-290`), so terminal state alone cannot
make that claim. If canonical completion wins the race, `completed` and its provenance-qualified
settlement remain authoritative.

Only after every target worker has exited and every owned instruction is durably `cancelled`,
`undelivered`, or `completed` may `OperatorStopPort` stop **that run's dedicated loop-controller**, with the same
graceful/force/exit-observation distinction. Once the controller is also terminal, `StopLoop` writes
`terminalAt`, transitions `stopping → stopped`, and reports success. Failure to observe process exit
or persist a terminal instruction leaves the run `stopping` with `operatorActionRequired`; it is
never reported stopped. The stop audit consequently joins stop request, target-worker signal and
exit, per-instruction disposition, controller escalation and exit, and final run transition by one
`stopId`.

Cancellation persistence and delivery must also fail closed across a crash between the loop-state
commit and the instruction snapshots. Today `InstructionQueue.start` calls `flush` when
`onControllerReleased` or `onDeliveryBoundary` fires, and `applyState` calls it again after an
instruction reaches the provider (`src/orchestration/instruction-queue.ts:39-53, 146-166`). `flush`
then selects every `accepted` / `queued` record and calls `tryDeliver`, with no owning-run check
(`:98-123, 169-208`). The adapted flush must, under the same run-scoped exclusion as `StopLoop`, read
the record's `loopRunId` and revalidate its durable `LoopRunStore` state immediately before
`tryDeliver`. Missing, `stopping`, `stopped`, or otherwise non-runnable state persists `cancelled`
with the run's `stopId` and never calls `SessionRegistry.submitInstruction`. Startup replay performs
the same revalidation before opening delivery. Thus the non-runnable `LoopRunStore` transition is
authoritative even if the broker dies before every cancellation snapshot is appended; detach or
provider-modal clear cannot resurrect held work.

A loop whose controller is invisible in Fleet, whose row cannot reach force escalation, whose queued
instructions can survive `StopLoop`, or whose iteration worker can outlive a stopped report has no
kill switch and is not buildable.

One consequence of assuming MIK-98 option 1: once peer bindings hold durable controller identities,
a peer-bound loop-controller becomes a legal handoff target _and_ a legal `stopOrchestrator` target
subject to the same gauntlet. The `REQUIRES_HANDOFF` refusal then does real work for loops — a
loop-controller that still owns non-terminal iteration workers cannot be stopped out from under them
without an explicit handoff, which is the behaviour a loop wants.

### 4.2 Broker restart

All three substrates fail closed the same way, independently:

- **Job plane:** `queued` / `dispatched` / `running` → `interrupted` on restart, never resumed
  (`docs/architecture/persistence-and-recovery.md`). Recovery "never dispatches, retries, resumes,
  routes, or delivers report-back." Note the interaction with §2.3: the admission queue is in-memory,
  so a restart starts from an empty queue and a loop's pending iteration is simply gone, not delayed.
- **Worker plane:** in-memory lease tokens are lost; leases age out (subject to §2.1's lazy-expiry
  finding) and become adoptable — "nothing is ever reacquired silently."
- **Worktree leases:** a held, unexpired lease found at startup becomes a durable orphan because the
  previous owner cannot be verified; orphans block acquisition; recovery never runs Git cleanup, and
  `assessOrphanCleanup` always assumes dirty by default.

The consistent posture — nothing auto-resumes, nothing auto-deletes, every unverifiable thing becomes
an operator-facing non-destructive finding — still applies, but it is insufficient without durable
loop state. `ControlPlaneReconciler.reconcile()` (`src/control-plane/reconciler.ts:70`) only looks at
jobs, worktree leases, and artifacts. It neither surveys orphaned `OwnershipSubject`s nor loads a
loop-run/budget aggregate, because no such aggregate exists today.

`ReconcileLoops` must run before loop admission opens. It loads `LoopRunStore`, marks any persisted
`admitting` or `running` iteration `interrupted`, preserves its iteration id and every debit already
committed, and reports the joined worker/lease/run state as `operatorActionRequired` and
`destructive: false`. It never reconstructs usage from the recovered session's zeroed
`completedTurns`/`canonicalTurns`, never redispatches the interrupted iteration, and treats a missing
or ambiguous settlement debit as unknown usage. An operator may explicitly adopt the lease and resume
the **run**, but `AdvanceLoop` then re-evaluates the persisted policy and cumulative debit and may only
enqueue a new iteration id. It cannot replay the interrupted one. Event-triggered and
self-continuing loops follow this same path from `LoopRunStore`; absence of a `LoopScheduleStore`
record gives them no fresh budget and no exemption. If the run or debit journal is missing or fails
validation, reconciliation makes the run terminal with an unprovable-state finding.

A persisted `stopping` run is handled differently: reconciliation keeps delivery revoked and
idempotently resumes the §4.1 cancellation, target-worker termination, instruction settlement, and
controller termination sequence. It neither relabels the run `interrupted` nor makes it adoptable.
Only observed process exits plus durable terminal instruction snapshots permit `stopping → stopped`;
otherwise the run remains non-runnable with `operatorActionRequired`.

### 4.3 Fail-closed defaults, and the MIK-96 lesson

Every relevant boundary in this codebase defaults to refusal over guessing: an omitted or Fable Claude
model at launch (`evaluateClaudeLaunchSafety`, re-checked at admission — "defence in depth"), an
unprovable token ceiling (`UNPROVABLE_TOKEN_USAGE`), a dirty worktree at orphan cleanup
(`assessOrphanCleanup` always `safeToDelete: false`), a modal or occupied composer at delivery
(`deliveryHold`). A loop-start capability belongs in this family.

**But the first draft's cited precedent for that bit was removed, and understanding why changes the
recommendation.** It named `worker.start.cursor` — a durable, default-off, operator-only capability —
as the template. MIK-96/MIK-97 (`e22acbf`) deleted it. `CyberdeckCapabilitySchema`
(`src/domain/capability.ts:3-12`) now lists only `thread.list`, `thread.read`, `thread.enqueue`,
`worker.start`, `worker.start.fable`, `orchestrator.inspect`, `orchestrator.stop`, `workflow.run`;
`worker.start.cursor` survives solely in `RETIRED_CAPABILITIES`, filtered out on read so that
append-only bindings written while the toggle was on stay parseable.

The reason it was removed is the lesson: **the capability catalog advertised Cursor's whole model list
to every orchestrator, and dispatch then refused the provider outright.** A dispatch that followed
exactly what it was advertised came back `CAPABILITY_DENIED`, naming a remedy — `/cursor-workers on`
— that Fleet refused to run in the very state the denial was raised from. The gate was removed, not
the grant mechanism, precisely because a gate that disagrees with the surface advertising the
capability is worse than no gate.

Applied to loops, that yields three requirements rather than one:

1. A loop-start capability bit is still right: durable, off by default, operator-only-settable, never
   settable at runtime by a loop-controller or a worker.
2. It must be checked at **both** loop-definition time and at each iteration's actual launch — the
   `evaluateClaudeLaunchSafety` pattern of checking at submit _and_ at admission rather than trusting
   submit alone.
3. **Whatever surface advertises that loops are available must be derived from the same grant that
   gates them.** If a capability catalog, an MCP tool description, or a Fleet affordance tells an
   orchestrator it may start a loop, the gate must agree — and the remedy named in any denial must be
   runnable from the state the denial was raised in. This is the MIK-96 failure, and a loop-start bit
   is the exact shape that reproduces it.

`worker.start.fable` is untouched by MIK-96 and remains the live precedent for a durable, default-off,
operator-only grant.

## 5. Deferred limitations a loop must respect

`CLAUDE.md` records accepted, deliberate gaps. They are not bugs to fix on sight, and a loop design
must not assume any of them is solved. Four bear directly on loops:

- **A worktree with no `origin/HEAD` gets no baseline.** `src/nvim/worktree-changes.ts` diffs against
  `merge-base(origin/HEAD, HEAD)`; without that ref the change list is untracked files only and the
  title says `no baseline`. A loop that provisions a scratch repository per iteration — a plausible
  shape for a self-testing loop — lands in exactly the triggering case. The stated fix is to ask the
  operator for the base ref and record it, not to widen the guessing; a loop must therefore either
  dispatch into clones that have `origin/HEAD` or carry a declared base ref per iteration.
- **Cursor and Antigravity model columns are launch values only,** marked `~`, because neither writes
  a native transcript. This compounds §2.3: those providers give a loop neither a verifiable running
  model nor `canonicalTurns`. A turn-budgeted loop on those providers is not buildable honestly, and
  the design should say so rather than degrade to the scrape.
- **A provider's model list is only as current as its CLI on the broker's PATH.**
  `WorkerCapabilityCatalog` caches `agent models` / `agy models` for five minutes and falls back to a
  dated static catalog with `source: "fallback-catalog"` when the CLI is missing or times out. A loop
  that re-selects a model per iteration can therefore dispatch against a stale or fallback list for
  the life of the loop without an operator ever seeing the notice Fleet prints. A loop should resolve
  its model **once, at definition**, and record it — not re-resolve per iteration.
- **One socket namespace for all concurrent Cyberdecks.** `nvimServerAddress` keys on the tmux pane
  index alone, so two Cyberdecks run by the same operator can collide. Loops raise the odds of a
  long-lived instance sitting in the background while a second is started, which is the flagged
  trigger. Not a blocker for loops; a reason not to treat a loop's longevity as free.

Two non-deferred rules also constrain loops. A thread's pull-request indicator is attributed to the
branch that thread's work lands on, declared via `workspace` — so **a loop that wants per-iteration PR
visibility must dispatch each iteration with a declared `workspace`**, not rely on the directory. And
nvim is driven with `--remote-expr`, never `--remote-send`: no loop may inject keystrokes.

## 6. Hosting loops post-refactor: which layer owns what

MIK-94 / GitHub #51 targets Clean Architecture boundaries with dependencies pointing inward:

```text
CLI/TUI → adapters → application/use-cases → domain ← ports ← infrastructure
```

The issue's own sequencing note says the refactor "should precede infrastructure expansion and
autonomous-loop work so new behaviour lands on the intended boundaries rather than creating more
coupling that must immediately be migrated." This section says where each piece of a loop belongs so
that lands correctly.

**Domain — loop policy lives here, and only here.** A loop is a set of invariants: what bounds exist,
what a bound being exceeded means, when an iteration is permitted to start, what a decision gate
blocks. These are the same kind of rule as `projectWorkerTruth`'s ordering or
`instructionTransitionAllowed`'s table — pure functions over observed state, no I/O, no clock, no
provider knowledge. Concretely the domain owns: a `LoopPolicy` value (bounds and their units), a
`LoopRun` aggregate with the durable fields named in §2.3 and its own state machine, a pure
`evaluateLoopContinuation(policy, observed)` returning continue / gate / stop-with-reason, and the
rule that a turn budget is denominated in `canonicalTurns`. **The domain must not know the transport
that triggered an iteration** — a cron tick, a workflow message, and an instruction completion all
arrive as the same domain-level "iteration boundary observed" fact. That normalized fact still carries
typed evidence. An instruction boundary is admissible only when its instruction ordinal, completion
target, `provider-transcript` provenance, and canonical-turn increment agree (§1.2).

**Application — one use case per verb, coordinating domain and ports.** `StartLoop`, `AdvanceLoop`
(evaluate the policy and either enqueue the next iteration or settle), `StopLoop` (enter durable
`stopping`, revoke delivery, cancel pending instructions, terminate iteration targets, durably settle
their instructions, then terminate the controller), `ReconcileLoops` (the startup survey of §7.3), and
`RetainLoopHistory` (enforce the rolling settled-iteration window across transcript, instruction,
workflow-message, and coordination-event history after each settlement, on the age sweep, and at
reconciliation).
These coordinate; they do not accumulate policy. The refactor issue is
explicit that use cases "do not become miscellaneous service classes," and a loop is the single most
likely place for that to happen — "the loop service" that quietly grows the scheduler, the budget
arithmetic, the provider selection and the reporting is exactly the shady-logic outcome the refactor
exists to prevent.

**Ports the loop use cases need**, all defined inward and implemented outward:

| Port                    | Why the loop needs it                                                                                                          | Existing implementation to adapt                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `Clock`                 | wall-clock bounds and the scheduler tick, without importing timers into the core                                               | the broker's existing `now()` injection (`AdmissionScheduler`, `agent-control-service`)                                   |
| `LoopRunStore`          | durable `LoopRun` state, iteration ids, trigger evidence, cumulative debit journal, stop record, and delivery authorization    | none — new; schedule state cannot substitute for it                                                                       |
| `LoopScheduleStore`     | durable "when next", and the missed-tick record for scheduled loops only                                                       | none — new                                                                                                                |
| `BudgetLedgerPort`      | durable turn / wall-clock / token accounting with fail-closed posture                                                          | rules from `src/control-plane/budget-ledger.ts`, storage delegated to `LoopRunStore`, scope generalised off `parentJobId` |
| `AdmissionPort`         | one iteration at a time, fair under ties                                                                                       | `src/control-plane/admission-scheduler.ts`                                                                                |
| `ControllerLeasePort`   | acquire / renew / release / adopt, and the identity a loop-controller speaks as                                                | `src/broker/worker-coordination.ts`                                                                                       |
| `InstructionPort`       | enqueue; cancel pending instructions; await durable terminal state for in-flight instructions; revalidate run state at delivery | `InstructionQueue.flush` / `applyState` + `SessionRegistry.submitInstruction`, adapted to consult `LoopRunStore`          |
| `WorkerObservationPort` | `WorkerTruth`, matching completion-ledger provenance, and `canonicalTurns` delta for the iteration just finished               | `projectWorkerTruth` + `SessionRegistry.recordCompletion`                                                                 |
| `CheckpointPort`        | request a decision gate, observe its answer                                                                                    | `requestCheckpoint` / `submitEvent`                                                                                       |
| `AuditPort`             | loop and stop identifiers written through instruction snapshots and coordination transactions, optionally other logs of §3.2   | `InstructionStore` + the coordination log; `Journal` scope remains a decision                                             |
| `LoopHistoryPort`       | compact settled iterations across transcript, instruction, workflow-message, and coordination-event stores by rolling run window; expire finished history | `selectExpiredThreads` + new joined range-compaction/redaction APIs on transcript, `InstructionStore`, `WorkflowStore`, and worker-coordination persistence |
| `WorkerTerminationPort` | graceful/force termination of iteration targets, exit observation, and stop-linked instruction settlement                      | worker-control path over `SessionRegistry.stop` / `forceStop` / `handleExit`                                              |
| `OperatorStopPort`      | graceful stop plus operator-reachable force escalation and exit observation for the controller                                 | `SessionRegistry.stop` / `forceStop`, exposed by new operator-only RPC                                                    |
| `CapabilityPort`        | the loop-start grant of §4.3, checked twice                                                                                    | `src/domain/capability.ts`                                                                                                |

**Adapters — trigger transports, and nothing else.** A cron adapter, a workflow-message adapter and
an instruction-completion adapter each translate their own event into the one domain fact. The last
must join `InstructionRecord.expectedTurn` to its `CompletionLedgerEntry`, not forward a bare
`completed` lifecycle transition. This boundary keeps §1's three trigger models from becoming three
loop implementations. A controller may know a use case; the use case must never know which adapter
woke it.

**Infrastructure — timers, persistence, provider processes, tmux projection.** It implements
`LoopRunStore`, `LoopScheduleStore`, stop-aware `InstructionQueue` delivery, instruction-history
and transcript range compaction, and target/controller signal plus exit-observation actions; it does
not decide policy. The one thing that must not happen here is a loop's bounds being enforced by
infrastructure: a `SIGTERM` at a deadline is an infrastructure _action_, but the deadline itself is
domain policy. The
Scout profile is the cautionary example: its 15-minute bound is real and works, but it lives in the
profile's own implementation rather than in a rule anything else can reuse, which is why it is a
precedent rather than a mechanism.

**Where a loop must not land.** Not in the broker's `SessionRegistry`, which is a runtime; not in
Fleet, which is a projection; not in an MCP tool handler, which is a controller. If loop policy ends
up in any of the three, the refactor's dependency rule has been violated and the resulting behaviour
migrates with the infrastructure it was written into — the exact outcome #51 names as the reason to
sequence the refactor first.

## 7. Prerequisites the MIK-94 refactor must provide before loops are buildable

This is the primary output of this document. Each item is a boundary the refactor must establish, so
that nothing loop-shaped lands on the wrong one.

1. **A durable `LoopRunStore` and worker-plane budget ledger with the job plane's exact fail-closed
   posture**, exposed inward as `LoopRunStore` and `BudgetLedgerPort`. The store owns the aggregate,
   iteration ids, policy snapshot, trigger evidence, and idempotent cumulative debit journal described
   in §2.3; `LoopScheduleStore` is neither required nor sufficient for event-triggered and
   self-continuing runs. Budget scope is per loop run rather than per job tree — `BudgetLedger`'s scope
   resolution walks `parentJobId`, which `OwnershipSubject` does not have — and persisted rather than
   rebuilt from the current in-memory `BudgetLedger.scopes` or reset session counters. It must enforce
   finite iteration and wall-clock limits for every run; native-transcript providers additionally
   require a finite turn limit, while Cursor and Antigravity must omit it and use only independent
   triggers (§2.3, item 12). Tokens fail closed where declared but unprovable. **Turn budgets must be
   denominated in `canonicalTurns`, never `completedTurns`**: a replay-derived turn is a scrape, and a
   budget inflated by a misread spinner frame is not a budget.

2. **A real periodic lease-expiry sweep**, wired into broker startup/composition the way admission and
   reconciliation already are — closing the finding that `expireLeases`
   (`src/broker/worker-coordination.ts:523`) exists, is tested, and is called from nowhere in
   production (re-verified at `e22acbf`). A loop nobody is watching must not sit `active` on disk
   indefinitely because nothing happened to touch it. This is also what makes MIK-85's `⊘` honest for
   an unwatched run (§3.3).

3. **A worker-plane and loop-run reconciliation pass**, structurally parallel to
   `ControlPlaneReconciler`: before admission opens, survey orphaned `OwnershipSubject`s and load every
   non-terminal aggregate from `LoopRunStore`. It must interrupt persisted in-flight iterations,
   preserve committed debits, make missing settlements unprovable, and report
   `operatorActionRequired`, `destructive: false`. Adoption may continue only by evaluating durable
   state and creating a new iteration id; recovery never redispatches the interrupted iteration and
   never treats reinitialized `completedTurns`/`canonicalTurns` as budget authority. A persisted
   `stopping` run instead resumes the idempotent stop sequence with delivery still revoked and cannot
   become `stopped` until target/controller exits and terminal instruction snapshots are proven
   (§4.2).

4. **A per-`LoopRun` controller that is a real lease controller, on MIK-98's option-1 outcome.** Taking
   option 1 as given (peer bindings get a durable controller family), the refactor must ensure each
   active run receives one stable controller-family binding in the `ControllerIdentitySchema` sense —
   never a conversation UUID — and that no active binding controls two run ids. That binding remains
   through its run's iterations, then `StopLoop` targets only it after its iteration targets settle.
   Thus an operator can force-stop one runaway run without disrupting another. The invariant MIK-98
   states is the one loops depend on: _every capability a binding is granted must be honoured by the
   lease substrate for that binding._ Once that lands, the CLAUDE.md deferred entry for the peer
   asymmetry retires and this prerequisite is satisfied by construction; until it lands, a
   loop-controller built as a peer binding inherits a contradiction on day one.

5. **One loop-run identifier threaded through every mandatory audit participant.**
   `InstructionRecord` already carries `workflowRunId`, `messageId`, `causationId`, `hop`,
   `expectedTurn`, and the render/submit/complete timestamps (`src/domain/instruction.ts:27-53`). Add
   `loopRunId`, matching completion target, completion provenance, and stop-cancellation fields;
   persist them with the full message through every `InstructionStore.put` snapshot in
   `orchestration/instructions.jsonl`. The same `loopRunId` is mandatory on the coordination-log
   transaction for every iteration boundary, checkpoint, lease action, and stop; matching transcript
   events must carry `loopRunId` and `iterationId`, joining instruction history, thread transcript,
   and coordination state without a timestamp guess. Every cancelled loop instruction must retain
   `cancelledAt` and `cancelledByStopId`, naming the immutable `LoopRunStore` stop record and matching
   coordination transaction. Every stop-settled `rendered` / `submitted` / `acknowledged` instruction
   must retain `settledByStopId`, `submittedAt` when present, and a disposition distinguishing
   undelivered before submission from interruption after submission. The refactor must additionally
   decide whether the diagnostic journal
   (`BrokerEventTypeSchema` has no worker-event or checkpoint type) and job-plane logs are in scope.
   That open question cannot remove either mandatory participant.

6. **A stop-aware `InstructionPort` and target-worker termination path.** `StopLoop` must use a
   run-scoped exclusion shared with delivery, commit non-runnable `stopping` plus immutable `stopId`,
   revoke delivery, and cancel every `accepted` / `queued` record. The `InstructionQueue.flush` path
   must re-read durable run state immediately before `tryDeliver`; non-runnable or missing state
   writes a stop-linked `cancelled` snapshot and must not call `SessionRegistry.submitInstruction`.
   This check applies on controller release, delivery-boundary reopening, provider-state follow-up,
   and startup replay. For `rendered` / `submitted` / `acknowledged`, `WorkerTerminationPort` must call
   the real `SessionRegistry.stop` / `forceStop` sequence, observe `exitCode !== null`, and await the
   durable terminal instruction update produced from `handleExit`; a signal return is insufficient.
   Only then may the controller be stopped and the run become `stopped`. Unproved exit or settlement
   leaves `stopping` plus `operatorActionRequired` (§4.1).

7. **A joined rolling loop-history policy**, distinct from `DEFAULT_THREAD_RETENTION_DAYS` (7) and
   `DEFAULT_THREAD_RETENTION_COUNT` (200), covering thread events,
   `orchestration/instructions.jsonl`, `workflow-messages.jsonl`, and
   `worker-coordination-v1.jsonl` while the worker thread is still active. Workflow messages and
   coordination events/checkpoint questions contain full trigger payloads, so retaining either log
   unchanged would preserve loop content and disk growth outside the nominal bound. Every policy
   must have finite `maxRetainedIterations` and `maxRetainedAgeDays`; after each settlement, on a
   periodic age sweep, and at reconciliation, joined range compaction removes full payloads from all
   four stores for the first limit crossed by `(loopRunId, iterationId)`. Where an append-only store
   cannot safely compact a mixed transaction, it must persist only a bounded, prompt-free reference
   to the durable run/iteration audit record instead of the trigger text. The policy preserves
   current/unsettled instructions, writes prompt-free audit tombstones, and first verifies that
   canonical provenance is durable in `LoopRunStore`. Pinning may preserve the finished run and its
   bounded tombstones, never bypass the rolling payload cap. Finished-thread expiry later deletes the
   remaining bounded history from every participating store together (§3.2).

8. **A decision on how a loop gates on more than one concern per cycle.** `decisionGate` on
   `OwnershipSubject` is a single value, not a set (`src/domain/worker-coordination.ts:91-95`).
   "Continue past step 3?" and "spend the extra budget?" cannot both be open on one subject. Either
   loop policy serializes gates — the cheaper answer, and the one §2.2 recommends — or
   `DecisionGateSchema` changes. The refactor should not discover this mid-implementation.

9. **The durable, off-by-default, operator-only loop-start capability**, checked at loop-definition
   time _and_ at each iteration's launch, with the MIK-96 constraint attached: whatever surface
   advertises that loops are available must derive from the same grant that gates them, and any
   denial must name a remedy runnable from the state the denial was raised in (§4.3). This is why
   `worker.start.cursor` no longer exists, and a loop-start bit is the exact shape that reproduces
   that failure.

10. **A `Clock` port and a `LoopScheduleStore` port defined inward**, so that the schedule trigger —
   the only trigger with no existing substrate — cannot pull timer or persistence knowledge into the
   domain. The store must record a missed tick as a fact rather than a backlog: recovery never
   redispatches, and a scheduler that silently catches up after downtime contradicts every other
   recovery path in the system.

11. **One domain-level "iteration boundary observed" fact, with per-trigger adapters translating into
    it.** Schedule, workflow wake, checkpoint answered, and `instruction → completed` must all arrive
    at the same domain entry point. The instruction adapter must carry and verify instruction id,
    expected turn, completion target, `provider-transcript` provenance, and corresponding
    `canonicalTurns` increment; `InstructionLifecycleState.completed` alone is inadmissible. Without
    this normalized evidence, §1's trigger models become separate loop implementations or a terminal
    scrape becomes authority to recurse.

12. **A stated provider-capability rule for loops.** Every policy has finite `maxIterations` and
    `maxWallClockMs`. Native-transcript providers require finite `maxCanonicalTurns` and may use all
    triggers, subject to §1's provenance rules. Cursor and Antigravity have no canonical turns
    (`ThreadTranscriptStore.captureProviderTurns`, `src/persistence/thread-transcript-store.ts:174-188`):
    they may run only schedule, workflow-wake, or checkpoint-triggered policies; their policy must
    omit `maxCanonicalTurns`, and instruction-completion/self-continuation is refused. A declared
    token limit also requires reportable token usage. No rule substitutes `completedTurns`, a scrape,
    zero, or an estimate for unsupported counters. The refactor's provider-capability representation
    is where this belongs; #51 explicitly requires provider-specific capabilities to remain
    representable without contaminating the domain.

13. **Loop bounds enforced from the domain, actuated by infrastructure.** A deadline is a domain rule;
    the `SIGTERM` at that deadline is an infrastructure action. The Scout profile currently holds both
    in one place, which is why its 15-minute bound is a precedent rather than a reusable mechanism.
    The refactor must not reproduce that shape for loops.

14. **An operator-reachable force-stop path**, exposed inward as `OperatorStopPort` and outward through
    Fleet plus an operator-only `session.forceStopOne` RPC. After `session.stopOne` has remained
    pending for the grace period, it must call `SessionRegistry.forceStop` and audit the `SIGKILL`
    escalation without consulting loop capability, controller lease, or handoff state. The RPC must
    observe process exit rather than equate `forceStop` return with termination, and `StopLoop` cannot
    write `terminalAt` while either target workers or the controller remain live. Delete remains
    unavailable until process exit. Visibility without force escalation is not a loop kill switch
    (§4.1).

None of these is large in isolation — most are "build the worker-plane equivalent of a job-plane
component that already exists and is well understood," or "define inward the port that a loop would
otherwise reach around." That is exactly why they belong in the refactor rather than bolted onto the
current split: building them once, on the post-refactor architecture, is cheaper than building them
twice — once now, shaped around the job/worker split, and again after the refactor removes it.

## 8. Recommendation

### Options considered

- **Option A — build loops on the job plane now.** Represent each iteration as a job so the existing
  `BudgetLedger` and `AdmissionScheduler` apply unchanged. _Risk:_ a job has no mid-run steering, no
  checkpoints, and no instruction queue. Every loop that needs to be steered — which is every loop
  worth building — would need a parallel worker beside its job, and the two would disagree about
  state, which is the pre-MIK-64 failure the truth projection exists to prevent.
- **Option B — build loops on the worker plane now, with hand-rolled bounds.** Follow the Scout
  precedent: a fixed loop profile carrying its own wall-clock literal, enforced by the broker. _Risk:_
  it works, and that is the problem. It produces a second one-off bound with no ledger behind it,
  scoped to today's job/worker split, that must be rewritten the moment the refactor moves the
  boundary — plus it needs items 1–4, 6, 7, and 14 of §7 anyway to be safe when unwatched,
  recoverable, killable, and bounded on one long-lived worker thread.
- **Option C — build nothing until the refactor establishes the boundaries in §7, then build
  event-triggered loops first.** _Risk:_ loops are delayed by the refactor's timeline, and §7 grows if
  the refactor's sequencing changes.

### Recommended path: Option C

Do not build any loop primitive before MIK-94 lands. This is not a hedge; it follows from §7. Every
prerequisite listed is a worker-plane component that either does not exist (`LoopRunStore`, durable
budget ledger, reconciliation pass, stop-aware instruction delivery, schedule store, joined
retention, operator force RPC), or exists
but is unreachable in production (the lease sweep), or is an authorization question being decided
elsewhere right now (MIK-98). Building a loop today means
building all of §7 by hand, scoped to the current split, then re-scoping it. That is the "shady logic
migrates into the new architecture" outcome #51 explicitly sequences the refactor to prevent — the
issue says so in its own words.

**Order of operations once the refactor lands:**

1. **Event trigger first**, specifically provenance-qualified `instruction → completed` (§1.2), on a
   provider that supplies native transcripts. It has the most existing substrate, but ships only after
   the adapter joins lifecycle completion to completion-ledger provenance and a canonical-turn
   increment; a bare durable lifecycle edge is not enough. This forces budget, lease, and audit joins
   to be answered by real traffic instead of synthetic load.
2. **Self-continuation second**, once event-triggered loops are bounded, observable and killable per
   §§2–4 — and only in the controller-mediated shape of §1.3. Never a worker-side auto-continue tool.
3. **Schedule last.** It is the cheapest trigger to build and the easiest to get wrong quietly: a
   scheduler that silently catches up missed ticks after an operator was away is precisely the kind
   of autonomy this system exists to make explicit and refuse by default. Build it informed by the
   other two, not first because it looks simplest.

**Two guardrails to carry into whatever ships:**

- One dedicated loop-controller binding per active `LoopRun`, driving that run's many iterations but
  never shared with another active run. The sigil alphabet has eight glyphs (§3.3), so Fleet must
  surface capacity pressure rather than trade away run-targetable force stop. A loop invisible in the
  fleet list has no kill switch (§4.1).
- A loop is a lease subject's _controller_, and the operator is the controller's controller. Nothing
  in a loop design may weaken the rule that a human control attachment has absolute writer priority,
  or that operator-direct `session.stopOne` plus `session.forceStopOne` bypass loop capability and
  lease checks. Graceful-only stop is not a kill switch; a run is not `stopped` until its iteration
  workers, in-flight instructions, and controller are terminal, and stopped-run instructions never
  flush when a human detaches or a provider hold clears. Rolling history bounds apply while the
  worker thread is active and pinned. Durable `LoopRunStore` bounds remain authoritative across
  broker restart; recovered session counters never reset them.
