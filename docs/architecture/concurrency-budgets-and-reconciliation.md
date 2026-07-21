# Concurrency, budgets, and reconciliation (A5)

A5 completes the neutral control-plane backend: an admission layer over durable jobs, explicit
budgets measured only from data Cyberdeck actually holds, a reconciliation pass that compares
durable state with supervised runtimes/leases/artifacts/report-backs, and the startup/shutdown
ordering that binds them together. It adds no ranking, recommendation, automatic routing, fallback,
role semantics, model pricing, or destructive cleanup.

| Module | Responsibility |
|--------|----------------|
| `src/control-plane/admission-scheduler.ts` | Deterministic queue, slot reservation/release, concurrency ceilings, startup gate |
| `src/control-plane/budget-ledger.ts` | Per-scope budget admission and post-run debits |
| `src/control-plane/reconciler.ts` | Structured findings comparing durable state with runtimes, leases, artifacts, report-backs |
| `src/control-plane/runtime.ts` | Composition + startup/shutdown ordering + neutral adapter registration |
| `src/config.ts` | `BrokerRuntimeConfig` (renamed from `PhaseOneConfig`), now carrying the declarations |

## Admission and concurrency

**Limits.** `ConcurrencyDeclaration` carries `maxConcurrentJobs`, `maxConcurrentPerProvider` (keyed
by the open provider id — a limit, never a rank), and the additive A5 field
`maxConcurrentPerRepository`. Every limit is optional; an unset limit is *no* limit, never an
invented default. The per-repository ceiling is a scheduling bound only: exclusive **writable**
access is still proven by an A4 worktree lease, never by this counter.

**Ordering.** The queue is scanned in a total, deterministic order — ascending `enqueuedAt`, ties
broken by ascending `jobId` — so a fake clock produces reproducible results.

**Starvation resistance.** `admitNext()` reserves a slot for the first *eligible* candidate in that
order. A younger job may pass an older one only when the older one's own provider or repository
bucket is saturated. Because the scan order is global FIFO, the first member of any bucket the scan
reaches is that bucket's oldest waiting job, so ordering *within* a bucket is strictly FIFO. Every
admitted job holds exactly one slot and returns it on every terminal path, so each bucket drains and
its oldest member is admitted next: no job is passed over indefinitely.

**Exactly-once reservation and release.** `enqueue` ignores a job id it already knows, so a retry
cannot double-queue. `admitNext` moves a candidate from the queue to the reservation map, so a job
can hold at most one slot. `release(jobId)` returns `true` exactly once. The control plane tracks
`holdsSlot` per job entry and releases on **every** exit path: settlement (completed, failed,
cancelled, timed out), failed-to-launch, interruption reported by an adapter, quarantine, and
cancellation of a still-queued job (which is withdrawn instead, holding no slot).

**Neutrality.** Capacity never influences *what* runs, only *when*. A blocked job is never admitted
under a different provider, model, or repository, and spare capacity never triggers a substitution.

**Launch safety.** Free capacity is not a reason to start a live Claude job whose model is omitted
or Fable. `evaluateClaudeLaunchSafety` is re-checked at the admission boundary, so such a candidate
is held and reported as blocked rather than promoted into a launch. This is defence in depth: the
submit path already refuses it. Explicit-string Fable rejection does **not** protect an omitted
Claude model — an unknown model stays unsafe and is never converted into a default.

## Budgets

**Scope.** One budget scope per **job tree**, identified by the root job id (resolved by walking
`parentJobId` with a cycle guard). A delegated child therefore debits its parent's/root's budget
rather than receiving a fresh allowance, and every debit is keyed by job id so it applies exactly
once regardless of retries or duplicate reports. Independent top-level submissions are independent
tasks with independent allowances: Cyberdeck enforces no global spend cap it was never given.

**Units — measurable only.** `maxJobs` (admitted jobs, children included), `maxWallClockMs` (elapsed
since the scope opened), `maxTotalTokens` (reported usage), `maxArtifactBytes` (persisted artifact
byte lengths). There is deliberately no currency, per-model, or per-role cost model; inventing one
would fabricate provenance no provider gave us.

**Admission vs. post-run.** Job count, elapsed wall clock, and already-recorded token/byte totals are
enforced **at admission**, before a slot is reserved or any provider is launched; an over-budget
submission is refused with `BUDGET_EXCEEDED` and creates nothing. Tokens and artifact bytes are only
observable **after** a job settles, so they are debited post-run and bind the next admission. A
running job is never killed mid-flight to reclaim budget.

**Unknown usage fails closed.** An absent usage report means *unknown*, never zero: `totalTokens`
stays absent until some job actually reports tokens, and `jobsWithUnknownUsage` counts the settled
jobs that reported nothing. When a token ceiling is declared and any settled job reported no usage,
the remaining headroom cannot be proven, so the scope refuses further admission with reason
`UNPROVABLE_TOKEN_USAGE`. Without a declared token ceiling, unknown usage is recorded and blocks
nothing.

## Reconciliation

`ControlPlaneReconciler.reconcile()` runs at startup (after recovery) and can be re-run after a
disconnect. It is conservative by construction:

- It never dispatches, completes, acknowledges, retries, kills, or deletes anything, so nothing is
  duplicated.
- **Unverifiable in-flight work is quarantined**: a non-terminal job no supervised runtime claims is
  moved to `interrupted` with a reason. Quarantine is not a terminal outcome — it fabricates neither
  success nor failure — and requires explicit operator action. Quarantine is idempotent.
- **Leases** are handled under the A4 rules only: recovery releases provably **expired** leases
  (fencing tokens increase monotonically) while a held lease whose owner cannot be verified stays
  held and blocking, reported as an orphan for explicit operator resolution. No Git directory,
  branch, or worktree is ever removed.
- **Orphaned runtimes** (a runtime claiming a job the control plane never recorded) are reported,
  not killed — Cyberdeck refuses to terminate a process it cannot correlate.
- **Orphaned artifacts** (stored content no job result references) are reported, not deleted.
- **Pending/failed report-backs** are surfaced without re-delivery or self-acknowledgement.

Every finding carries `operatorActionRequired` and `destructive: false`. Running the pass twice
observes the same state, changes nothing, and returns the same findings.

## Startup and shutdown ordering

`ControlPlaneRuntime` owns the ordering the broker depends on. The admission scheduler **starts
closed**, which is what makes the ordering enforceable rather than merely conventional:

1. **Startup** — construct persistence (jobs, artifacts, leases) → `controlPlane.recover()` →
   `reconcile()` → `openAdmission()` → offer the queue. Nothing is dispatched against unreconciled
   state. Work found already persisted is *not* resumed when admission opens: recovery interrupted
   it because its runtime ownership is unverifiable.
2. **Shutdown** — `closeAdmission()` **first**, so no new job starts while draining → cancel each
   non-terminal job through its adapter → await pending adapter reports → durable records reflect
   the final state. Shutdown is idempotent, and a submission made afterwards stays queued forever
   rather than launching.

## Composition and reachability

`composeJobDispatchAdapters` (`src/broker/main.ts`) registers one adapter per canonical provider id:
A4's `codex` App Server adapter (sharing the runtime's single lease manager) plus the Agent B-owned
`claude`, `cursor`, and `antigravity` adapters, consumed unmodified through the frozen dispatch port.
Registration order carries no ranking or preference; registration only makes an explicitly requested
provider selectable.

Non-presentational control-plane routing is exposed as broker RPC — `control.queue`,
`control.budget`, `control.reconciliation`, and `job.reportBacks` — returning structured state only.
Command copy, dashboard, cockpit, and any job/budget rendering remain Agent B's B5 work, and A5 adds
no CLI commands for them.
