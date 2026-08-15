# MIK-84: Autonomous loops inside Cyberdeck's bounded system

Research only. No code changes accompany this document, and none should follow from it before the
architecture refactor lands — see [Recommendation](#6-recommendation). Every claim below is checked
against the code and docs on this branch (cut from `main` at `8576bcc`) as of 2026-08-16, not against
what the feature is supposed to do.

## 0. What "loop" means here

MIK-84 asks about *autonomous loops*: runs that keep going — on a timer, in response to an event, or
by continuing themselves — without an operator initiating each turn. Cyberdeck has no such primitive
today. It has two substrates that a loop would have to be built from:

- The **job plane** (`src/domain/job.ts`, `src/control-plane/**`): bounded, one-shot, headless work
  with an immutable request and a terminal result. It has real admission control, real budgets, and a
  real reconciler.
- The **worker plane** (`src/domain/worker-coordination.ts`, `src/broker/worker-coordination.ts`):
  durable, controller-owned, multi-turn interactive workers with leases, checkpoints, decision gates,
  and an instruction queue. It has none of the job plane's budget or reconciliation machinery.

The central fact this document keeps returning to: **a loop is shaped like a worker, not a job** — it
needs turns, checkpoints, and steering — but **the enforcement machinery that already exists is built
for jobs, not workers.** Closing that gap is most of what "post-refactor, loops become buildable"
should mean. Section 5 makes this an explicit prerequisite list.

## 1. Trigger model options

### 1.1 Schedule (cron / interval)

Nothing in the codebase schedules anything. A repo-wide search for a periodic dispatch primitive
(`setInterval`, `cron`, a recurring-task table) turns up nothing beyond an internal 100ms socket-close
timer (`src/broker/server.ts:185`) and the App Server adapter's request-timeout timers — neither is a
scheduler. Building schedule-triggered loops means building a scheduler from nothing: a durable
"when next" store, a broker-owned tick, and — critically — a decision about what happens when the
broker was down across a missed tick (Cyberdeck's whole persistence story is "never resume, never
redispatch automatically," so the honest answer is *report the missed tick, do not catch it up
silently*, matching every other recovery path in this codebase).

**Trade-off.** Cheapest to reason about (no dependency on anything else finishing first) and the
easiest to bound (a schedule has an obvious off switch: stop enqueuing). But it is pure new surface —
no existing broker component partially does this — and a schedule alone answers "when" and says
nothing about "why now is safe," which is a separate question this document treats as a bounding
control (§2), not a trigger property.

### 1.2 Event (react to something Cyberdeck already observes)

This is the trigger model with the most existing substrate to build on:

- **Workflow messages** (`src/domain/workflow.ts`) are already a passive-by-default, bounded
  inter-session mailbox: a `WorkflowMessage` is inert unless `wake: true`, and a `WorkflowRun` carries
  durable `maxMessages` (100), `maxTurns` (20), and `maxHops` (8) ceilings
  (`src/domain/workflow.ts:3-7`). "Wake another session on a message" is close to an event trigger
  already, just not exposed as one — `docs/architecture/session-model.md` documents it as "Workflow
  messages are passive mailbox entries unless `wake` is explicitly true," and cancellation is
  explicitly noted not to stop participants already running.
- **`DECISION_REQUEST` / `CHECKPOINT` events** are the other candidate. A worker (or its orchestrator)
  can already raise a durable, correlation-idempotent checkpoint (`requestCheckpoint`,
  `src/broker/worker-coordination.ts:968`) and have it answered through the normal event-submission
  path (`submitEvent`, `src/broker/worker-coordination.ts:644`). An event-triggered loop iteration is
  naturally "the next thing that happens after this checkpoint is answered."

**Trade-off.** Reuses machinery that is already durable, correlation-checked, and audited — no new
persistence format needed. The cost is that both existing mechanisms were built for *bounded*
fan-out (a workflow run has hard caps; a checkpoint answers exactly one correlation) and neither was
built to be the outer trigger of an indefinitely recurring run. Reusing them for that purpose means
either loosening those caps (risk: the caps are the only thing currently stopping a wake chain from
running forever) or treating each loop "cycle" as a fresh, separately-admitted workflow run — the
latter is safer and composes with §2's per-iteration bounding.

### 1.3 Self-continuation

This is the option most people mean by "loop," and it is the one Cyberdeck's own tool surface most
actively resists. The worker-facing MCP wrappers a worker actually gets are
`cyberdeck_signal_exception`, `cyberdeck_report_progress`, `cyberdeck_signal_risk`,
`cyberdeck_request_decision`, and `cyberdeck_respond_checkpoint`
(`docs/architecture/worker-coordination.md`) — report and answer-a-checkpoint tools. A worker holds no
`cyberdeck_worker_ctl` / `cyberdeck_lease` access; those are the orchestrator-facing three tools, and
they require a **stable controller identity**, which a worker's own session can never hold for itself
(a worker is a lease *subject*, never a lease *controller*). Concretely: nothing a worker's own process
can call re-instructs that same worker. Continuation can only be driven by whatever already holds the
controller lease — today, that is an orchestrator's durable binding or a human controller — reading
the worker's own `DECISION_REQUEST`/`CHECKPOINT` output and choosing to re-enqueue through the
instruction queue (`SessionRegistry.submitInstruction`, which "writes provider input without
cancelling the active turn," per `docs/architecture/worker-coordination.md`).

**Trade-off.** This is a feature, not a gap to route around. "Self-continuation" that is actually
worker-mediated (the worker decides its own next turn with no external read of its output) has no
natural stopping point and no natural audit seam — the only thing that could stop it is the worker
itself, which is exactly the actor a runaway-loop kill-switch cannot trust. Controller-mediated
continuation — a bounded loop-controller reads a checkpoint, evaluates it against the gates in §2, and
either re-enqueues or stops — keeps the existing invariant "a human control attachment has absolute
writer priority" (`docs/architecture/session-model.md`) intact, and keeps a real actor with a real
lease accountable for every "again." **Recommendation:** build self-continuation only in this
controller-mediated shape; do not add a worker-side auto-continue tool.

### Summary

| Trigger | Existing substrate | New surface required |
| --- | --- | --- |
| Schedule | none | a durable scheduler, from scratch |
| Event | `WorkflowRun`/message wake, `CheckpointRequest`/decision gate | loosen or wrap existing caps for outer-loop use |
| Self-continuation | instruction queue + checkpoint answer, controller-mediated | a bounded loop-controller role that *is* the controller |

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
random, SHA-256-hashed at rest, bound to a *stable family* identity rather than a conversation UUID
(`ControllerIdentitySchema` explicitly rejects a UUID as `controllerId`,
`src/domain/worker-coordination.ts:21-28`), and fenced by a monotonic lease version. A loop iteration
that outlives its watcher degrades exactly the way any unwatched worker degrades today: the lease
ages past its TTL, gets swept to `orphaned`, and becomes adoptable — never silently reacquired
(`docs/architecture/worker-coordination.md`: "nothing is ever reacquired silently"). This part of the
substrate is solid enough to build on as-is.

**Two findings that change the risk picture, in the substrate's favor.** `BUGS.md`'s dated log
currently lists two "Open" defects in exactly this machinery:

- *"a decision gate is cleared by an answer to any checkpoint, not the matching one"* (found
  2026-07-27). Current code checks the answered checkpoint's `correlationId` against the subject's
  live `decisionGate.correlationId` before clearing it (`src/broker/worker-coordination.ts:836-845`),
  and `tests/integration/worker-coordination-events.test.ts:404-429` pins the *fixed* behavior
  (answering `gate:a` leaves `gate:b` open). This reads as resolved, most plausibly by the
  MIK-64/MIK-71 "one authoritative worker state machine" work (`3cbc28f`).
- *"`inactive-controller` adoption is unreachable for a controller that died silently"* (found the same
  day). The current `select()` for that scope returns a subject whose lease is `orphaned`/`expired`
  and past `expiresAt` regardless of whether a `disconnected` liveness observation was ever recorded
  (`src/broker/worker-coordination.ts:1229-1237`), and
  `tests/integration/worker-coordination-ownership.test.ts:295` ("adopts a silently expired controller
  by inactive-controller without taking a live one") pins that behavior too.

Neither fix is reflected in `BUGS.md`'s "Open" section — the document is stale on the two entries
that matter most to "recovering a loop nobody is watching." That staleness is itself a finding worth
the operator's attention (outside this document's scope to correct), and this design should not
inherit a fear of gaps that no longer exist.

**One finding that does not resolve in the substrate's favor.** `WorkerCoordinationService.expireLeases`
(`src/broker/worker-coordination.ts:523-588`) is the only code path that proactively sweeps a subject
from `active` to `expired`→`orphaned`. A repo-wide search for its callers outside of tests returns
nothing — it is never invoked by broker composition (`src/broker/main.ts`,
`src/broker/worker-coordination-runtime.ts`). Expiry is otherwise evaluated **lazily**, only inside an
authenticated call (`isExpired`/`expiredCopy`, `src/broker/worker-coordination.ts:1240-1264): a
subject's on-disk lease state does not become `orphaned` until *something* — a renew, an adopt survey,
an event submission — touches it again. For a loop nobody is watching, "nobody is watching" and
"nothing ever touches this subject again" are the same condition, so the lease can sit `active` on
disk indefinitely past its real TTL. This is not a correctness bug (nothing can act on a stale token;
`OWNERSHIP_LOST` still fires on the next real attempt), but it does mean an operator surveying "what's
still running" via anything that reads raw lease state rather than calling through the service will
see a false `active`. A loop design needs one of: (a) a real periodic sweep wired into broker startup,
or (b) every observability surface routing through the service's lazy-expiry check rather than raw
state — never both left undone.

### 2.2 Checkpoint and decision-gate placement

Checkpoints are the natural bounding gate for a loop iteration: durable, correlation-idempotent, and
already distinguishing non-blocking progress markers from `decision-gate` checkpoints that pause the
worker's structured `decisionGate` state (`CheckpointRequestSchema.mode`,
`src/domain/worker-coordination.ts:286`). Placement guidance, grounded in what the schema actually
allows:

- **One decision gate per subject, always.** `decisionGate` on `OwnershipSubject` is a single value,
  not a set (`src/domain/worker-coordination.ts:91-95, 105`). A loop cannot have two concurrent
  decision points outstanding on the same worker — a "should I continue past step 3, and also should I
  spend the extra token budget" double-gate is not representable. Loop design must serialize decision
  points: one open gate, answered, closed, before the next opens.
- **Checkpoints ride the instruction queue, so they respect the human-controller-priority invariant for
  free.** `SessionRegistry.submitInstruction` never cancels an active turn and defers to a human
  control attachment (`docs/architecture/worker-coordination.md`, `docs/architecture/session-model.md`
  "Worker steering... A human control attachment has absolute writer priority"). A loop-controller that
  answers its own checkpoints through the same path inherits this for free: an operator who attaches
  mid-loop automatically outranks the loop's own continuation logic.
- **A decision gate is a pause, not a stop.** `mode: "decision-gate"` changes only the structured
  `decisionGate` field; it does not change `WorkerLifecycle`
  (`docs/architecture/worker-coordination.md`: "decision-gate checkpoints change only structured
  `decisionGate`"). A loop-controller reading lifecycle alone will not see a paused loop as different
  from a working one — it must read `decisionGate.state`, not `lifecycle`, to know whether continuation
  requires a decision first.

Recommended placement: put the decision gate **before** the instruction that would start the next
iteration is enqueued, not after — i.e., the loop-controller requests a `decision-gate` checkpoint,
waits for the answer, and only then calls the equivalent of "enqueue the next turn." This keeps the
worker itself inert (not mid-turn) at every point a human or a bounding check could veto the next
cycle, and it matches the existing precedent that a checkpoint answer is what unblocks
`submitInstruction`, not a side channel.

### 2.3 Spend and turn limits — the enforcement gap

This is the sharpest finding in this document. Cyberdeck already has real budget enforcement — for
the **wrong plane**.

`BudgetLedger` (`src/control-plane/budget-ledger.ts`) enforces `maxJobs`, `maxWallClockMs`,
`maxTotalTokens`, and `maxArtifactBytes` per **job-tree** scope (root resolved by walking
`parentJobId`), admission-time for count/time/already-known usage and post-run for
tokens/bytes, and fails closed (`UNPROVABLE_TOKEN_USAGE`) when a token ceiling is declared but any
settled job in scope reported no usage
(`docs/architecture/concurrency-budgets-and-reconciliation.md`). `AdmissionScheduler`
(`src/control-plane/admission-scheduler.ts:73`, `.enqueue()`:102, `.release()`:130) enforces
concurrency ceilings the same way, deterministically and starvation-resistantly.

None of it touches the worker plane. A grep for `budget`, `maxTokens`, `wallClock`, or `spendLimit`
across `src/domain/worker-coordination.ts` and `src/broker/worker-coordination.ts` returns nothing.
`src/control-plane/reconciler.ts` and `src/control-plane/runtime.ts` never reference
`worker-coordination.ts` or `OwnershipSubject` at all. The two substrates are architecturally
disjoint — confirmed, not inferred from the docs alone. `JobRequestSchema`
(`src/domain/job.ts:22-34`) has no checkpoint or turn concept either
(`docs/architecture/control-plane.md`: "Session is not job" is the whole point of the split). The
interactive, steerable, checkpoint-bearing shape a loop needs is a worker; the budget machinery that
already exists only ever looks at jobs.

The one place Cyberdeck *does* budget an autonomous worker-plane run today is the Scout profile: a
15-minute wall-clock default, enforced by settling in-flight output at cutoff and `SIGTERM`ing the
process, with `maxTokens` explicitly deprecated and ignored for termination
(`docs/architecture/scout-profile.md` "Budgets and parallelism"). It is fixed to one tier, one
provider, one model, read-only, and a single wall-clock dimension — a narrow, hand-built precedent, not
a general mechanism. It is nonetheless the closest existing analog to "a bounded autonomous run with a
hard kill at its edge," and its shape (a fixed profile carrying its own budget, verified on exit, with
a deprecated-but-still-accepted legacy field left in place rather than silently repurposed) is a
reasonable template for a loop profile's own literal.

**Implication for §5:** turn/spend limits for a loop cannot be bolted onto `BudgetLedger` by pointing
it at a worker id instead of a job id — the ledger's scope resolution walks `parentJobId`, a field that
does not exist on `OwnershipSubject`. Either the worker plane needs its own budget ledger with the same
fail-closed posture (unknown usage is unknown, never zero), or every loop iteration needs to be
represented as a real job-tree entry so the existing ledger can see it — which reopens the question of
how a bounded job (no mid-run steering, no checkpoints) hosts something that needs checkpoints. This is
not a detail; it is the central architectural decision loops are blocked on.

## 3. Observability

### 3.1 What the operator sees while a loop runs

Two different freshness stories exist today, and a loop design should not conflate them:

- **Push-shaped:** a `DECISION_REQUEST` or pinned `CHECKPOINT` event is durable and stays pinned until
  explicitly resolved (`docs/architecture/worker-coordination.md`: "Exceptions, decision requests, and
  intervention-required events remain pinned until explicitly resolved"). An operator reading the event
  stream, or a checkpoint answered through the instruction queue, sees this promptly — this path is not
  affected by the poll-cadence problem below.
- **Poll-shaped:** Fleet's own view of ordinary progress is not. `waitForRefresh` is resumed only "by a
  key, by a chunk of `!` shell output, by `SIGWINCH`, by an attach transition, and by the transport
  closing — and by nothing else" (`BUGS.md`, "Open: Fleet learns about provider progress only by
  asking, every 500 ms"). A loop iteration that completes between two 500ms ticks is up to half a
  second stale on screen, and nothing about a loop makes this worse in kind — but a loop is precisely
  the kind of thread an operator is *not* actively attached to, so its state is read from this same
  poll cadence at whatever moment the operator happens to glance over, not pushed to them. Worth
  restating to the operator explicitly if a loop feature ships: "the fleet row is current as of the
  last 500ms tick" is a true statement today and will remain true for a loop's row unless the
  push-shaped event path is deliberately used for anything the operator must not miss.
- Rendered status for a loop's own thread comes from the single `projectWorkerTruth` projection
  (`src/domain/worker-truth.ts`, `docs/architecture/worker-truth.md`) the same way any worker's does —
  `stalled`, `blocked-modal`, `blocked-composer`, and the terminal states are already meaningful for a
  loop iteration with no new plumbing. This is a genuine asset: a loop does not need its own status
  vocabulary.

### 3.2 Auditability afterward

Reconstructing "what did this loop actually do, and why did it stop" today means reading across
**four separate durable logs**, none of which join to each other:

1. `events.jsonl` — the diagnostic `Journal` (`src/broker/journal.ts`), typed by
   `BrokerEventTypeSchema` (`src/domain/events.ts:3-34`). Session, scout, `orchestrator.stop.*`, and
   job lifecycle events live here. There is no worker-event or checkpoint type in this enum at all.
2. `orchestration/worker-coordination-v1.jsonl` — the ownership/lease/checkpoint/event/audit
   transaction log (`docs/architecture/worker-coordination.md`). This is where a loop's checkpoints,
   decision gates, and lease transfers actually live.
3. `control-plane/jobs.jsonl` + `control-plane/leases.jsonl` — job-plane state and worktree leases
   (`docs/architecture/persistence-and-recovery.md`, `docs/architecture/app-server-and-worktree-leases.md`).
   Relevant only if a loop iteration is ever represented as a job.
4. The durable per-thread transcript (`docs/architecture/session-model.md`, "Durable thread feed") —
   prompts and provider output, monotonically cursored, user-only file permissions, deliberately
   excluded from the metadata journal for privacy. This is the only place the actual prompt text a
   loop sent itself lives.

None of these four is wrong to keep separate — (4)'s privacy boundary and (2)'s fsynced-transaction
guarantees exist for good, documented reasons — but nothing today stitches them into one "loop run"
view. A design that ships loops without a joined audit view is asking the operator to hand-correlate
four JSONL files by timestamp and worker id after the fact, which is a worse audit story than a single
provider conversation gets today.

**Retention actively works against this.** `selectExpiredThreads`
(`src/domain/thread-retention.ts:45-78`) retires a finished thread record after `maxAgeDays` (7,
default) or once it falls outside the newest `maxThreads` (200, default) window, whichever comes first,
unless the thread is pinned (`isRetirableThread`, `thread-retention.ts:28-33`; `keepPinned`,
`:18`). A loop that produces many short-lived worker threads across a week of scheduled or event-driven
runs will silently age its own history out of the fleet view on the same clock as everything else,
*unless* whatever creates each iteration's thread also pins it — and pinning every iteration of a
frequent loop defeats the retention bound's whole purpose (an unbounded pinned set). Loop history needs
its own retention story, not inheritance of the general-purpose default.

## 4. Failure and kill behavior

### 4.1 Kill-switch paths

Two genuinely different kill paths exist, and they are not interchangeable:

- **Operator-direct.** `session.stop` / `session.delete` are unconditional broker operations Fleet's
  `Ctrl+X` drives directly (`docs/architecture/session-model.md`, "Stop and delete"). No capability
  grant, no controller-lease check, no handoff requirement. This is the path that must remain able to
  kill a loop regardless of what the loop's own controller thinks.
- **Peer-mediated.** `stopOrchestrator` (`src/orchestration/agent-control-service.ts:440-562`) is what
  a peer orchestrator or tool actually calls, and it refuses far more than it allows: it refuses a
  target stopping itself ("cannot stop itself through the peer-control tool", line ~496), refuses a
  target that still owns non-terminal workers ("`REQUIRES_HANDOFF`... MIK-55 handoff is required
  before stopping it", line ~521), and — separately from the handoff check — refuses a **healthy live
  or starting** target outright regardless of handoff state ("Healthy live orchestrators require
  explicit operator authority", `APPROVAL_REQUIRED`, line ~535). Only past that gauntlet does the same
  graceful-then-force escalation as a worker stop apply (`isStopRequested` must already be true,
  `forceStopGraceMs` must have elapsed, only then `SIGKILL`). This mirrors the identical worker-level
  escalation in `src/orchestration/worker-control-service.ts:751-778`.

The practical read for a loop that is itself orchestrator-shaped (a chain of workers under one binding,
per §1.3's controller-mediated recommendation): **nothing short of the operator's direct path can kill
it while it is actively working.** A peer tool cannot; the loop cannot stop itself. This is the correct
default — it prevents a rogue peer from silently killing a live loop — but it means the *only* kill
switch a design can rely on for a live loop is the same one that already exists for every other
orchestrator: the operator's `Ctrl+X`/`cyberdeck stop`. No new kill mechanism needs to be invented;
what needs to be guaranteed is that a loop-controller's binding is always visible in Fleet as a normal
orchestrator row, so that path stays reachable.

### 4.2 Broker restart

All three substrates fail closed the same way, independently:

- **Job plane:** `queued`/`dispatched`/`running` → `interrupted` on restart, never resumed
  (`docs/architecture/persistence-and-recovery.md` restart-mapping table). Recovery "never dispatches,
  retries, resumes, routes, or delivers report-back."
- **Worker plane:** in-memory lease tokens are lost on restart; leases age out (subject to the §2.1
  lazy-expiry finding) and become adoptable — "the intended recovery path... nothing is ever reacquired
  silently" (`docs/architecture/worker-coordination.md`).
- **Worktree leases:** a held, unexpired lease found at startup becomes a durable orphan because the
  previous owner cannot be verified; orphans block acquisition; recovery never runs Git cleanup, and
  `assessOrphanCleanup` always assumes dirty by default
  (`docs/architecture/app-server-and-worktree-leases.md`).

The consistent posture — nothing auto-resumes, nothing auto-deletes, every unverifiable thing becomes
an operator-facing, non-destructive finding — is exactly what a loop needs after a broker restart mid
cycle, and it requires no new invention. What is missing is the join: `ControlPlaneReconciler.reconcile()`
(`src/control-plane/reconciler.ts:67-171`) only ever looks at jobs, worktree leases, and artifacts. It
has no worker-plane equivalent — nothing surveys orphaned `OwnershipSubject`s at startup and reports
them as a structured, `operatorActionRequired`, `destructive: false` finding the way job orphans are
reported. An operator recovering from a broker restart mid-loop today has the job-plane reconciliation
report and the raw worker-coordination log; they do not have a "here is every loop-shaped worker this
broker can no longer verify" summary.

### 4.3 Fail-closed defaults

Every relevant boundary in this codebase already defaults to refusal over guessing: an omitted or
Fable Claude model at launch (`evaluateClaudeLaunchSafety`, re-checked again at admission —
"defence in depth," `docs/architecture/concurrency-budgets-and-reconciliation.md`), autonomous Fable
and Cursor delegation (`worker.start.fable`/`worker.start.cursor`, off by default, durable,
operator-only-settable, `docs/architecture/session-model.md` and `src/domain/capability.ts:8-9`), an
unprovable token ceiling (`UNPROVABLE_TOKEN_USAGE`), a dirty worktree at orphan cleanup
(`assessOrphanCleanup` always `safeToDelete: false`). A loop-start capability belongs in this same
family: a durable, off-by-default, operator-only capability bit on the controlling binding — not a
runtime flag a loop-controller or worker could set for itself — checked again at the point each new
iteration actually launches, the same way `evaluateClaudeLaunchSafety` is checked at both submit and
admission rather than trusted from submit alone.

## 5. Hosting loops post-refactor — explicit prerequisites

A loop should not be its own third substrate. It is worker-shaped work (turns, checkpoints, steering)
that needs job-plane-grade enforcement (admission, budget, reconciliation) it does not currently have.
The refactor should close that gap, not paper over it. Concretely, before a loop is buildable, the
post-refactor architecture must provide:

1. **A worker-plane budget ledger with the job plane's exact fail-closed posture** — scoped per loop
   run (not per job-tree, since `parentJobId` does not exist on `OwnershipSubject`), enforcing turns
   and wall-clock at minimum, tokens where reported, and refusing further admission the moment usage
   becomes unprovable rather than assuming zero. This is §2.3's central finding, restated as a
   requirement.
2. **A real periodic lease-expiry sweep**, wired into broker startup/composition the way admission and
   reconciliation already are — closing the §2.1 finding that `expireLeases` exists but is called
   nowhere in production. A loop nobody is watching must not be able to sit `active` on disk
   indefinitely because nothing happened to touch it.
3. **A worker-plane reconciliation pass**, structurally parallel to `ControlPlaneReconciler`: at
   startup, survey orphaned `OwnershipSubject`s the same non-destructive, `operatorActionRequired` way
   job orphans are surveyed today. Without this, a broker restart mid-loop has no equivalent of the
   job-plane's recovery report.
4. **A resolved peer-binding capability model** — CLAUDE.md's own deferred item, and directly load-
   bearing here: a controller-mediated loop-controller (§1.3) is exactly the kind of actor that needs
   to both message *and* observe/control the workers it drives. Today a `:peer:` binding can enqueue
   (`thread.enqueue`) but cannot hold a stable controller identity for `worker_ctl`/`worker_events`
   (`stableController`, `src/orchestration/worker-control-service.ts:1184-1186`) — the exact MIK-71
   asymmetry. A loop-controller built as a peer binding inherits this contradiction on day one.
5. **A joined audit view across the four logs in §3.2** — or, more conservatively, a documented,
   deliberate decision that a loop's audit trail is scoped to the worker-coordination log plus the
   thread transcript only, with the job-plane logs explicitly out of scope unless a loop iteration is
   represented as a job. Either answer is acceptable; no answer is not.
6. **A loop-specific retention policy**, distinct from `DEFAULT_THREAD_RETENTION_DAYS`/`_COUNT`, so a
   frequent loop's history does not either (a) silently age out on the general 7-day/200-thread clock
   or (b) force pinning every iteration and defeat retention entirely.
7. **A decision on where a loop's turn budget lives relative to the single-decision-gate-per-subject
   limit** (§2.2): if a loop needs to gate on more than one concern per cycle (continue? spend more?),
   that is currently unrepresentable on one `OwnershipSubject` and either needs sequential gates or a
   schema change to `DecisionGateSchema`.
8. **The durable, off-by-default, operator-only loop-start capability bit** described in §4.3, checked
   at both loop-definition time and at each iteration's actual launch — never inferred from the
   presence of a schedule or event trigger alone.

None of these are large in isolation — most are "build the worker-plane equivalent of a job-plane
component that already exists and is well understood." That is exactly why they belong in the refactor
rather than bolted onto the current split: building them once, on the post-refactor architecture, is
cheaper than building them twice (once now, shaped around the job/worker split; once again after the
refactor removes that split).

## 6. Recommendation

Do not build any loop primitive before the architecture refactor. This is not a hedge — it follows
directly from §5: every prerequisite listed is a worker-plane component that either does not exist
(budget ledger, reconciliation pass) or exists but is unreachable in production (the lease sweep) or is
an open authorization question the operator has already deferred (the peer-binding asymmetry, per
CLAUDE.md). Building a loop today means building all of §5 by hand, scoped to the current job/worker
split, then re-doing the scoping the moment the refactor changes that split. That is the "shady logic
migrates into the new architecture" outcome the issue explicitly warns against.

When the refactor does land, the order of operations that keeps loops honest is: (1) trigger model —
build the **event** trigger first (§1.2), since it has the most existing substrate and forces the
budget/lease questions to get answered by real checkpoint traffic rather than synthetic load; (2) once
event-triggered loops are bounded, observable, and killable per §§2-4, add **self-continuation** in the
controller-mediated shape recommended in §1.3 — never worker-side; (3) add **schedule** last, once a
missed-tick-after-downtime policy has been exercised against real operator expectations by the other
two trigger models first. Schedule is the cheapest trigger to build and the easiest to get wrong
quietly (a scheduler that silently catches up missed ticks after an operator was away is precisely the
kind of autonomy this whole system exists to make explicit and refuse by default), so it should be
built last, informed by the other two, not first because it looks simplest.
