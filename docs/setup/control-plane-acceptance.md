# Control-plane acceptance and operations (A5)

This note records what A5's automated acceptance actually proves, what remains live-unverified, and
what an operator does when reconciliation reports a finding. It deliberately distinguishes
**automated fake-runtime evidence** from **live provider evidence**: A5 produced only the former.

## What the automated acceptance covers

`tests/integration/control-plane-acceptance.test.ts` drives the composed `ControlPlaneRuntime`
end to end with deterministic fake terminal/App Server runtimes and **real temporary Git
repositories** (`git init` into a temp dir, removed afterwards). No provider process is ever
resolved or spawned, no model call is made, and no paid usage is spent.

| Scenario | What it proves |
|----------|----------------|
| Mixed providers, explicit selection | `codex`, `cursor`, and `antigravity` each run on their own adapter; an unregistered provider is refused (`PROVIDER_NOT_REGISTERED`); a failing runtime never spills over to another provider |
| Concurrency saturation and fair release | Jobs beyond the ceiling stay queued and are admitted in enqueue order as slots free |
| Two jobs contending for one writable repository | The second job is blocked (`MAX_CONCURRENT_PER_REPOSITORY`) and dispatched only after the first settles; a second writable lease on the same canonical repository is refused (`LEASE_CONFLICT`) |
| Cancellation/timeout during launch and execution | Failed launch settles and returns its slot; cancellation reaches the adapter and settles as `cancelled`; a reported timeout settles as `timedOut`; no slot leaks |
| Budget rejection/exhaustion with unknown usage | Reported tokens debit the tree's scope once; a provider reporting nothing leaves usage unknown and makes the declared ceiling fail closed (`BUDGET_EXCEEDED` / `UNPROVABLE_TOKEN_USAGE`) |
| Broker restart during an in-flight job | The durable request survives, the job is `interrupted`, it is **not** redispatched, and reconciliation reports it as unverifiable in-flight work |
| Duplicate adapter completion and report-back | A duplicate terminal report is ignored; usage is debited once; acknowledgement is idempotent |
| Stale lease fencing and non-destructive reconciliation | Only the provably expired lease is fenced (token increments); the unexpired one remains a blocking orphan; cleanup is refused and both repositories are left intact |
| Parent → child delegation → artifact → acknowledged report-back | Lineage/correlation preserved, opaque role untouched, artifact resolvable by digest, artifact bytes debited, report-back acknowledged, reconciliation left clean |

Focused invariants live in `tests/control-plane/admission-scheduler.test.ts`,
`budget-ledger.test.ts`, `job-admission.test.ts`, `reconciler.test.ts`, and `runtime.test.ts`.

## What remains live-unverified after A5

- Every provider adapter's live behavior (Codex App Server, Claude, Cursor, Antigravity). All A5
  evidence is fixture-based.
- Live broker/tmux acceptance of admission, budgets, and reconciliation. These belong to the
  human-launched final gate, serialized one scenario at a time.
- Omitted Claude remains forbidden because it is not an explicit operator choice. Explicit Fable is
  permitted on operator paths; autonomous Fable workers require the durable `worker.start.fable`
  grant before the launch boundary. Admission still prevents free capacity from promoting an
  omitted model into a launch.

## Operator runbook

### Reading control-plane state

Over the broker socket (structured state only; no presentation):

```text
control.queue           → limits, admissionOpen, reservations, queued entries with blockedBy
control.budget          → declaration plus per-scope usage and exhaustion reason
control.reconciliation  → the most recent reconciliation findings and quarantined job ids
job.reportBacks         → every report-back handoff and its delivery state
job.list / job.get      → durable job records, usage, and report-back state
```

### Responding to reconciliation findings

Every finding is non-destructive (`destructive: false`). Cyberdeck performs no cleanup on its own.

| Finding | What happened | Operator action |
|---------|---------------|-----------------|
| `unverifiable-in-flight-job` | A job was in flight but no runtime vouches for it; it was quarantined as `interrupted` | Inspect the job and its repository, then explicitly resubmit or abandon it. Nothing is retried automatically |
| `orphaned-runtime` | A runtime claims a job the control plane has no record of | Inspect and stop that process manually; Cyberdeck refuses to kill a process it cannot correlate |
| `orphaned-lease` | A held lease survived a restart and its owner cannot be verified; it still blocks writable acquires | Inspect the worktree and owner job, then resolve the orphan explicitly (`resolveOrphan` with operator confirmation). No Git cleanup is ever automatic |
| `orphaned-artifact` | Stored content no job result references | Inspect before removing; A5 deletes no artifacts |
| `pending-report-back` | A settled child's handoff is not acknowledged | The parent must acknowledge it. Reconciliation never re-delivers or self-acknowledges |

### Budget exhaustion

`BUDGET_EXCEEDED` names its reason: `MAX_JOBS`, `MAX_WALL_CLOCK_MS`, `MAX_TOTAL_TOKENS`,
`MAX_ARTIFACT_BYTES`, or `UNPROVABLE_TOKEN_USAGE`. The last one means a settled job reported no
usage while a token ceiling was declared, so remaining headroom cannot be proven — that is a
deliberate fail-closed refusal, not a miscount, and it is resolved by the operator raising or
removing the ceiling, or by starting a new job tree.

### Startup and shutdown expectations

Admission is closed until recovery and reconciliation finish, so a job submitted during startup waits
rather than launching. Work found already persisted is never resumed on startup. On shutdown,
admission closes first, in-flight jobs are cancelled through their adapters, and the durable records
reflect the final state.

## Verification commands

```bash
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
git diff --check
```
