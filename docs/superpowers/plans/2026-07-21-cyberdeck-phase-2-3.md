# Cyberdeck Phase 2/3 Implementation Plan

**Goal:** Extend the Phase 1 neutral session broker with a **control plane** for bounded jobs:
durable jobs, structured delegation with report-back, persistence and recovery, structured
artifacts, Codex App Server control-plane integration, repository/worktree leases, and finally
concurrency, budgets, and reconciliation — without ever adding provider ranking, model
recommendation, automatic fallback, or a role catalog, and without ever launching Fable through
automation.

**Baseline:** Phase 1, ending at `docs: define cyberdeck phase one boundary`, plus A1's control-plane
contracts (this commit). A1 froze the shared ports and the provider-registration seam and wrote this
plan; it implemented no job execution, adapter, persistence, transport, worktree mutation, scheduler,
budget, or reconciliation.

**Execution model:** Ten sequential sessions — five Agent A (control plane) and five Agent B
(adapters/presentation) — plus two human-launched top-level Codex gates. They are **not** concurrent
workers. Within each track, never start the next session before its prerequisite baseline is
integrated and verified. Each session works inline in its own isolated worktree, spawns no subagents,
leaves exactly one clean conventional commit, and does not touch the other track's owned areas.

---

## Scope and policy locks (contractual)

Carried from Phase 1 and extended to the job plane:

- Provider is always explicit. In the job plane it is an **open, runtime-validated slug** that must
  be explicitly registered; arbitrary strings are rejected until registered. No implicit routing.
- Model is an optional provider-native opaque string. Role is an optional opaque user string with no
  capabilities or routing semantics. Sandbox is independent.
- No provider ranking, model recommendation, automatic provider/model fallback, or role catalog —
  anywhere, at any layer.
- A **session** (live PTY) and a **job** (bounded unit of work) are separate. A job MAY use a
  session but is not one provider process and never redefines attachment state as job state.
- Fable is never launched through automation. Delegated Fable is rejected before process launch.
  Only a human may deliberately type a top-level Fable start. This rule is never weakened.
- Tests use fixtures/fakes only. No Claude, Codex, or Fable model call in any automated test, and no
  live model usage spent in CI.

## Phase 1 cleanup decision (A1, evidence-based)

A1 audited Phase 1 for extension blockers. Decision: **no broad Phase 1 refactor is required to
begin Phase 2/3.** Specific findings:

- **Native-default-Claude / omitted-model safety gap — addressed, not closed by explicit-string
  rejection.** See the dedicated section below. A1 added a tested live-launch guard and this plan
  hard-blocks omitted-model Claude live checks; it does **not** claim current policy prevents
  native-default Fable.
- **`PhaseOneConfig` phase-specific naming — deferred to A5 as a scoped task.** Evidence: the name
  is imported by A-owned broker code (`session-registry.ts`, `broker/main.ts`) and by the B-facing
  integration test (`tests/integration/session-lifecycle.test.ts`). Config must grow in A5 to carry
  concurrency/budget declarations anyway, so renaming to a neutral `BrokerRuntimeConfig` (or
  extending into a `ControlPlaneConfig`) is folded into A5 to avoid churning the broker twice and to
  batch the B-facing test update as a single documented handoff. It is not a blocker for A2–A4.
- **`BrokerEventTypeSchema` is a closed enum — extended in A2, not now.** Job events (`job.*`) are
  added when durable jobs land. `BrokerEvent.data` is already an open record, so no A1 change.
- **Serialization / forward-compat — no Phase 1 change.** New envelopes carry `schemaVersion` and
  strip unknown keys; the JSONL journal already appends validated lines.
- **Session lifecycle coarseness — intentional, no change.** Jobs carry their own lifecycle union;
  the session `active` state is deliberately coarse.
- **All other areas — no additional cleanup required.** Evidence: the full Phase 1 suite (15 files,
  60 tests) is green on the A1 baseline; A1 added contracts without modifying any Phase 1 runtime
  behavior. The two unchecked live Claude acceptance steps remain the known, correctly-deferred
  incomplete live acceptance driven by the native-default-Fable observation.

## Native-default-Claude safety gap (priority)

Phase 1's delegated-Fable rejection examines only an **explicitly supplied** model string. An
**omitted** Claude model resolved to native-default Fable on the installed runtime. **Current policy
does not prevent native-default Fable, and no task in this plan may claim it does.**

**Safe live-launch invariant.** A live Claude start (top-level or delegated) is forbidden unless a
human operator supplies and has independently verified an explicit ordinary non-Fable model. An
omitted model is unsafe at the live Claude launch boundary.

Handling:

- A1 shipped `evaluateClaudeLaunchSafety(provider, model)` (`src/domain/policy.ts`): a tested pure
  guard treating a Claude launch with an omitted **or** Fable model as unsafe
  (`CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL`), non-Claude providers unconstrained. It does
  not enforce anything until called at the real spawn boundary.
- The neutral stored policy (`evaluateStart`) deliberately keeps `model` optional; enforcing there
  would conflate stored neutrality with launch safety and break Phase 1 fake-adapter delegation
  tests.
- **B (B1) wires `evaluateClaudeLaunchSafety` at the real Claude launch boundary** (real
  adapter/PTY path), so real Claude spawns with an omitted/Fable model are refused before a process
  starts, while fake adapters used in tests bypass it. This is the enforcement point that closes the
  gap.
- **Until B1's enforcement is integrated AND a human-launched Codex gate verifies it live, this plan
  hard-blocks all omitted-model Claude live checks.** No live Claude start (top-level or delegated)
  may occur with an omitted model. Both gates below verify that an omitted-model Claude start is
  refused before any process spawns.

## Ownership and dependency direction

See `docs/architecture/control-plane.md`. Summary:

- **Agent A** owns `src/domain/**`, `src/protocol/**`, `src/broker/**`, `src/config.ts`, and the
  persistence/recovery contracts and services.
- **Agent B** owns `src/providers/**`, `src/runtime/**`, `src/client/**`, `src/tmux/**`, the
  dashboard/cockpit, provider-facing CLI UX, and the concrete provider registration and
  dispatch/PTY adapters.
- **Human operator** owns all live broker/provider/tmux acceptance and both mandatory gates,
  serialized one scenario at a time.
- Dependency direction: `src/domain/**` depends only on `zod` + node stdlib; broker and persistence
  depend on domain; adapters implement domain **ports** and are injected; presentation depends on the
  client/broker protocol. No inward dependency into domain. No cycles.

## Live-check and integration protocol (all live/gate work)

Serialize every live broker/provider/tmux check under one human operator:

1. Prove the starting state (broker down, socket absent, no stray PIDs, no `cyberdeck` tmux session).
2. Run exactly one bounded scenario.
3. Stop and clean it; verify PIDs gone, socket removed, panes closed.
4. Only then start the next scenario. Never overlap live checks across the A and B worktrees.

Automated gate before any commit in every session:

```bash
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
git diff --check
git status --short
```

---

## Agent A sequence

### A1 — Control-plane contracts, executable plan, cleanup decision — **DONE (this commit)**

- [x] Runtime-validated, serializable contracts under `src/domain/`: control-plane primitives,
  extensible provider registration, bounded job (immutable request + lifecycle union), delegation
  intent, terminal result / report-back envelope, structured artifact descriptors + content
  references, worktree lease records, concurrency/budget declarations + usage, provider-neutral
  dispatch/completion/cancellation port, schema version + error codes.
- [x] Live-launch safety guard `evaluateClaudeLaunchSafety` (tested), stored policy left neutral.
- [x] Architecture note `docs/architecture/control-plane.md`.
- [x] This executable plan with the recovered A sequence, B sequence, and both Codex gates.
- [x] Focused red/green tests for every contract; full suite, check, and build green.

### A2 — Durable jobs, structured delegation, results, report-back

**Prerequisite:** A1 integrated and verified. **Owner:** Agent A.

- [ ] Add `job.*` broker events to `BrokerEventTypeSchema` (`job.created`, `job.dispatched`,
  `job.settled`, `job.reported`) with a focused failing test first.
- [ ] Implement an in-memory `JobRegistry` (analogous to `SessionRegistry`) that accepts a
  `JobRequest`, assigns a `JobId` + `CorrelationId`, tracks the `JobLifecycle`, and records a
  terminal `JobResult`. Inject the `JobDispatchAdapter` port; do not import concrete adapters.
- [ ] Implement structured delegation: a parent (job or session) submits a `DelegationIntent`; the
  registry records `parentJobId`/`parentSessionId`, dispatches the child, and routes the child's
  `JobReport` back to the parent by `correlationId`. Enforce delegation depth reuse of the existing
  policy; keep a job separate from a session.
- [ ] Extend the RPC protocol (`src/protocol/frames.ts`) and broker server with
  `job.submit`, `job.get`, `job.list`, `job.cancel`, and a report-back event frame. Validate every
  frame; return structured errors with `ControlPlaneErrorCode`.
- [ ] Tests (fakes only): job submit→dispatch→settle→report; delegation with correlated report-back;
  negative tests for invalid lifecycle transitions and unregistered providers; neutrality tests
  (arbitrary model/role opaque, provider explicit). No model calls.
- **Stop condition:** durable jobs, delegation, and report-back pass with a fake dispatch adapter;
  full suite/check/build green; one commit. Do **not** begin persistence/recovery.

### A3 — Persistence, recovery, and structured artifacts

**Prerequisite:** A2 **and** B2 integrated, **and Codex Gate 1 passed.** **Owner:** Agent A.

- [ ] Persist job records and reports to durable storage (extend the journal or add a job store),
  append-only, validated on write, forward-compatible on read (`schemaVersion` gating,
  `SCHEMA_VERSION_UNSUPPORTED` on unknown).
- [ ] Implement recovery: on broker restart, reconstruct job records and their terminal state from
  storage. Preserve the Phase 1 boundary — a live PTY is not recovered; a **job's** durable record
  and terminal result are. Make the session-vs-job recovery distinction explicit and tested.
- [ ] Implement structured artifact persistence behind `ArtifactDescriptor`/`ContentReference`
  (inline/file/external), without changing the descriptor contract. Digest/byteLength populated on
  write.
- [ ] Tests (fakes only): write→read round-trip; recovery after simulated broker restart; forward-
  compat unknown-field tolerance; artifact reference resolution; negative tests for corrupt/older
  records. No model calls.
- **Stop condition:** recovery reconstructs job state and artifacts deterministically; full
  suite/check/build green; one commit.

### A4 — Codex App Server control-plane integration + repository/worktree leases

**Prerequisite:** A3 integrated. **Owner:** Agent A (control-plane transport + lease service);
Codex App Server transport client is a documented handoff to Agent B where it touches provider code.

- [ ] Define the control-plane transport for the Codex App Server integration on the A side (request
  correlation, completion, cancellation) mapped onto the `JobDispatchAdapter` port. Do not implement
  Fable; do not launch any model in tests.
- [ ] Implement the repository/worktree **lease service** behind `WorktreeLeaseSchema`: acquire,
  release, conflict detection, expiry — **without** mutating real worktrees in tests (inject a fake
  git/worktree port). A held lease blocks a conflicting acquire (`LEASE_CONFLICT`).
- [ ] Tests (fakes only): dispatch/complete/cancel over the transport with a fake Codex App Server;
  lease acquire/release/conflict/expiry; recovery of lease records. No model calls.
- **Stop condition:** transport + leases pass against fakes; full suite/check/build green; one commit.
  Live Codex App Server acceptance is deferred to Gate 2 under the human operator.

### A5 — Integration, concurrency, budgets, reconciliation

**Prerequisite:** A4 **and** B4 integrated. **Owner:** Agent A.

- [ ] Rename `PhaseOneConfig` → a neutral config (e.g. `BrokerRuntimeConfig`/`ControlPlaneConfig`) as
  the scoped cleanup, updating A-owned broker code; coordinate the single B-facing integration-test
  update as a documented handoff.
- [ ] Implement concurrency admission and budget accounting behind `ConcurrencyDeclaration`,
  `BudgetDeclaration`, and `BudgetUsage` — enforcement only now, no ranking. Over-limit submissions
  are refused (`BUDGET_EXCEEDED`) or queued deterministically.
- [ ] Implement reconciliation: on restart, reconcile persisted job/lease/budget state with live
  runtime (orphaned jobs marked settled/failed with a reason; released leases; usage recomputed).
- [ ] Tests (fakes only): concurrency ceilings; budget exhaustion; reconciliation of orphaned
  jobs/leases after simulated crash; end-to-end control-plane flow with fake adapters. No model calls.
- **Stop condition:** concurrency, budgets, and reconciliation pass; full suite/check/build green;
  one commit. Then **Codex Gate 2**.

---

## Agent B sequence (peer track — summary and prerequisites)

Agent B is a separate human-launched peer. A1 specifies only the prerequisites and handoffs; it does
not implement any B task.

- **B1 — Provider registration + launch-safety enforcement + provider identifier evidence.**
  Prereq: A1 integrated. Implement `ProviderRegistry`; register `codex`/`claude` descriptors; wire
  `evaluateClaudeLaunchSafety` at the **real** Claude launch boundary so real omitted/Fable Claude
  spawns are refused before a process starts (fakes bypass). Produce integrated evidence to finalize
  the concrete **Cursor** and **Antigravity** provider slugs and register their descriptors. This
  evidence is the prerequisite for B3/B4.
- **B2 — Provider-neutral job dispatch adapters (Codex, Claude).** Prereq: A2 integrated + B1.
  Implement `JobDispatchAdapter` for Codex and Claude at the job level, distinct from the Phase 1 PTY
  session adapter. Fakes in A2 tests remain the automated path; live behavior is proven at Gate 1.
- **B3 — Cursor dispatch adapter + job presentation.** Prereq: B2 + A3 + finalized B1 Cursor id.
- **B4 — Antigravity dispatch adapter.** Prereq: B3 + A4 + finalized B1 Antigravity id.
- **B5 — Cockpit/dashboard/CLI for jobs, delegation, artifacts, budgets; final presentation.**
  Prereq: A5.

## Ordered integration prerequisites (both tracks)

```
A1 ─┬─ B1
    A2 ─── B2
            └── Codex Gate 1  (after A2 + B2, structured delegation works end to end)
    A3 ─── B3          (A3 requires A2 + B2 + Gate 1)
    A4 ─── B4
    A5 ─── B5
            └── Codex Gate 2  (after final A5 + B5 integration)
```

Integrate a track session only after its prerequisite baseline is verified. Never overlap live checks
across worktrees.

---

## Mandatory human-launched top-level Codex gates

Both gates are **human-launched top-level Codex** review/acceptance sessions — not children spawned
by Agent A or Agent B. Neither may use Fable. Both follow the live-check protocol (prove starting
state, one scenario, clean, verify PIDs/socket/panes).

### Codex Gate 1 — after A2 + B2, before A3 begins

**Purpose:** confirm structured delegation works end to end on live Codex before persistence is built.

**Pass conditions (all required):**

- [ ] A parent submits a bounded job; a **structured delegation** creates a child job; the child
  settles and its `JobReport` is routed back to the parent by `correlationId`, observed live.
- [ ] The delegated worker uses an **explicit Codex** provider (or a fake), with an arbitrary opaque
  role preserved and no role semantics applied.
- [ ] A delegated **Fable** attempt is refused before any process starts
  (`FABLE_REQUIRES_EXPLICIT_HUMAN_START`), and no new job/session/PID appears.
- [ ] An **omitted-model Claude** start (top-level or delegated) is **refused before any process
  spawns** via the B1-wired `evaluateClaudeLaunchSafety`; no Claude process is created. (If B1's
  enforcement is not yet integrated, the omitted-model Claude live check stays hard-blocked and the
  gate fails.)
- [ ] No Fable process is ever launched. Job and session records stay distinct.
- [ ] Starting state proven before, teardown verified after (PIDs gone, socket removed, panes closed).

### Codex Gate 2 — after final A5 + B5 integration, before Phase 2/3 is declared complete

**Purpose:** accept the full control plane end to end on live Codex.

**Pass conditions (all required):**

- [ ] Full job lifecycle on live Codex: submit → dispatch → run → settle → `JobReport` → artifacts
  persisted and resolvable.
- [ ] Recovery: after a deliberate broker restart, durable **job** records and terminal results are
  reconstructed; live PTYs are correctly **not** recovered (Phase 1 boundary preserved).
- [ ] A repository/worktree **lease** is acquired and released; a conflicting acquire is refused
  (`LEASE_CONFLICT`).
- [ ] Concurrency and budget limits are honored (`BUDGET_EXCEEDED` on exhaustion); reconciliation
  cleans orphaned jobs/leases after a simulated crash.
- [ ] Neutrality preserved throughout: explicit provider, opaque model/role, no ranking/routing/
  fallback/role-catalog observed.
- [ ] An **omitted-model Claude** start is still refused before any process spawns; no Fable process
  is ever launched.
- [ ] Starting state proven before, teardown verified after.

---

## Global stop conditions

- Stop A3 until A2 + B2 are integrated and **Codex Gate 1** has passed.
- Stop declaring Phase 2/3 complete until A5 + B5 are integrated and **Codex Gate 2** has passed.
- Stop any session that finds a dirty worktree, a missing prerequisite baseline, or unexplained
  cross-track changes; report the mismatch without editing.
- Never launch Fable through automation. Never claim explicit-string rejection closes the
  native-default-Claude gap. Hard-block omitted-model Claude live checks until B1 enforcement is
  integrated and gate-verified.
