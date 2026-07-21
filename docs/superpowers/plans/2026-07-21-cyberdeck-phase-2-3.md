# Cyberdeck Phase 2/3 Implementation Plan

**Goal:** Extend the Phase 1 neutral session broker with a **control plane** for bounded jobs:
durable jobs, structured delegation with report-back, persistence and recovery, structured
artifacts, Codex App Server control-plane integration, repository/worktree leases, and finally
concurrency, budgets, and reconciliation — without ever adding provider ranking, model
recommendation, automatic fallback, or a role catalog, and without ever launching Fable through
automation.

**Recovered baseline:** Phase 1 plus integrated A1 (`7a4aa0c`), B1 (`da6a445`), and A2
(`8db5543`). A1 froze the shared ports and registration seam. B1 supplied capability probes and
deterministic fixtures. A2 implemented the durable job control plane and concrete registry. The
optional `usage` field A2 added to `JobReport` is ratified as an additive contract extension;
absence remains unknown, never zero.

**Execution model:** Ten implementation shots arranged in dependency-safe parallel waves, plus two
human-launched top-level Codex gates:

```text
A1 + B1
A2 + B2
Codex Gate 1
A3 + B3
A4 + B4
A5
B5
Codex Gate 2
```

Each track reuses its own isolated worktree, and a human integration session advances both
worktrees to the verified shared baseline between waves. Parallel implementation is allowed only
within the displayed wave; live broker/provider/tmux checks remain serialized under one operator.
Each shot works inline, spawns no subagents, leaves exactly one clean conventional commit, and does
not touch the other track's owned areas.

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
- **B2 wires `evaluateClaudeLaunchSafety` at the real Claude launch boundary** (real
  adapter/PTY path), so real Claude spawns with an omitted/Fable model are refused before a process
  starts, while fake adapters used in tests bypass it. This is the enforcement point that closes the
  gap.
- **Until B2's enforcement is integrated AND a human-launched Codex gate verifies it, this plan
  hard-blocks all omitted-model Claude live checks.** No live Claude start (top-level or delegated)
  may occur with an omitted model. Both gates below verify that an omitted-model Claude start is
  refused before any process spawns.

## Ownership and dependency direction

See `docs/architecture/control-plane.md`. Summary:

- **Agent A** owns `src/domain/**`, `src/protocol/**`, `src/broker/**`, `src/config.ts`, and the
  persistence/recovery contracts and services.
- **Agent B** owns `src/providers/**`, `src/runtime/**`, `src/client/**`, `src/tmux/**`, the
  dashboard/cockpit, provider-facing CLI UX, and concrete dispatch/PTY adapters. B1 owns only its
  capability probes and fixtures; A2 owns the concrete registry/control-plane service.
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

### A1 — Control-plane contracts, executable plan, cleanup decision — **DONE (`7a4aa0c`)**

- [x] Runtime-validated, serializable contracts under `src/domain/`: control-plane primitives,
  extensible provider registration, bounded job (immutable request + lifecycle union), delegation
  intent, terminal result / report-back envelope, structured artifact descriptors + content
  references, worktree lease records, concurrency/budget declarations + usage, provider-neutral
  dispatch/completion/cancellation port, schema version + error codes.
- [x] Live-launch safety guard `evaluateClaudeLaunchSafety` (tested), stored policy left neutral.
- [x] Architecture note `docs/architecture/control-plane.md`.
- [x] This executable plan with the recovered A sequence, B sequence, and both Codex gates.
- [x] Focused red/green tests for every contract; full suite, check, and build green.

### A2 — Durable jobs, structured delegation, results, report-back — **DONE (`8db5543`)**

**Prerequisite:** A1 integrated and verified. **Owner:** Agent A.

- [x] Add typed job/delegation/report events to `BrokerEventTypeSchema` with focused coverage.
- [x] Implement an in-memory job control-plane service that accepts a
  `JobRequest`, assigns a `JobId` + `CorrelationId`, tracks the `JobLifecycle`, and records a
  terminal `JobResult`. Inject the `JobDispatchAdapter` port; do not import concrete adapters.
- [x] Implement structured delegation: a parent (job or session) submits a `DelegationIntent`; the
  registry records `parentJobId`/`parentSessionId`, dispatches the child, and routes the child's
  `JobReport` back to the parent by `correlationId`. Enforce delegation depth reuse of the existing
  policy; keep a job separate from a session.
- [x] Extend the broker server with typed `job.*` methods while preserving Phase 1 session methods.
- [x] Tests (fakes only): job submit→dispatch→settle→report; delegation with correlated report-back;
  negative tests for invalid lifecycle transitions and unregistered providers; neutrality tests
  (arbitrary model/role opaque, provider explicit). No model calls.
- **Outcome:** durable jobs, delegation, and acknowledged report-back pass with a fake dispatch
  adapter; the control plane consumes the unchanged A1 port; full suite/check/build green. A3 has
  not begun.

### A3 — Persistence, recovery, and structured artifacts — **DONE (`1448b38`)**

**Prerequisite:** A2 **and** B2 integrated, **and Codex Gate 1 passed.** **Owner:** Agent A.

- [x] Persist job records and reports to durable storage (extend the journal or add a job store),
  append-only, validated on write, forward-compatible on read (`schemaVersion` gating,
  `SCHEMA_VERSION_UNSUPPORTED` on unknown).
- [x] Implement recovery: on broker restart, reconstruct job records and their terminal state from
  storage. Preserve the Phase 1 boundary — a live PTY is not recovered; a **job's** durable record
  and terminal result are. Make the session-vs-job recovery distinction explicit and tested.
- [x] Implement structured artifact persistence behind `ArtifactDescriptor`/`ContentReference`
  (inline/file/external), without changing the descriptor contract. Digest/byteLength populated on
  write.
- [x] Tests (fakes only): write→read round-trip; recovery after simulated broker restart; forward-
  compat unknown-field tolerance; artifact reference resolution; negative tests for corrupt/older
  records. No model calls.
- **Outcome:** commit `1448b38f2f44bb3825db15b06f5c3cacfdf29b9c` reconstructs jobs and
  artifacts deterministically; full suite/check/build green; one ownership-isolated commit.

### A4 — Codex App Server control-plane integration + repository/worktree leases — **DONE (`f54318d`)**

**Prerequisite:** the A3+B3 wave integrated. **Owner:** Agent A (control-plane transport + lease service);
Codex App Server transport client is a documented handoff to Agent B where it touches provider code.

- [x] Define the control-plane transport for the Codex App Server integration on the A side (request
  correlation, completion, cancellation) mapped onto the `JobDispatchAdapter` port. Do not implement
  Fable; do not launch any model in tests.
- [x] Implement the repository/worktree **lease service** behind `WorktreeLeaseSchema`: acquire,
  release, conflict detection, expiry — **without** mutating real worktrees in tests (inject a fake
  git/worktree port). A held lease blocks a conflicting acquire (`LEASE_CONFLICT`).
- [x] Tests (fakes only): dispatch/complete/cancel over the transport with a fake Codex App Server;
  lease acquire/release/conflict/expiry; recovery of lease records. No model calls.
- **Stop condition:** transport + leases pass against fakes; full suite/check/build green; one commit.
  Live Codex App Server acceptance is deferred to Gate 2 under the human operator.
- **Outcome:** commit `f54318d870e0dab94b5e76babfb2e30e0787ef68` adds the bounded App Server
  adapter, protocol validation, durable fenced lease manager/store, non-destructive orphan handling,
  and fixture-only interruption/lease integration coverage.

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

Agent B is a separate human-launched peer working from its dedicated track worktree.

- **B1 — Provider capability probes and fixtures — DONE (`da6a445`).** Read-only evidence finalized
  canonical ids `cursor` and `antigravity` and executable mappings `agent` and `agy`. B1 did not
  implement the registry, a production adapter, or launch-safety wiring.
- **B2 — Claude job dispatch adapter + launch-safety wiring.** Prereq: reconciled A1+B1+A2.
  Implement `JobDispatchAdapter` for Claude, wire `evaluateClaudeLaunchSafety` at every real Claude
  spawn boundary, and use B1 fixtures for all automated behavior. Live behavior is proven only at
  Gate 1.
- **B3 — Cursor dispatch adapter + job presentation — DONE (`2304025`).** Parallel-wave prereq: B2
  + Gate 1; implemented from the integrated A3 result in this inline wave while preserving the B
  ownership boundary. Uses canonical id `cursor` and executable evidence `agent`.
- **B4 — Antigravity dispatch adapter — DONE (`4919a31`).** Parallel-wave prereq: integrated A3+B3;
  implemented the canonical `antigravity` / `agy` interactive command builder and bounded plain-text
  dispatch adapter without widening A-owned contracts or making a real provider call.
- **B5 — Cockpit/dashboard/CLI for jobs, delegation, artifacts, budgets; final presentation.**
  Prereq: A5.

## Ordered integration prerequisites (both tracks)

```text
A1 + B1               integrated
A2 + B2               integrate, then Codex Gate 1
A3 + B3               integrate before the next wave
A4 + B4               integrate before A5
A5                    integrate before B5
B5                    integrate, then Codex Gate 2
```

## A3+B3 integration evidence — PASS (2026-07-21)

The wave starts at verified baseline `994d555e74c8cf477e42e02220c530949978e0b4`. A3 is the
ownership-isolated commit `1448b38f2f44bb3825db15b06f5c3cacfdf29b9c` (`feat: persist jobs and
structured artifacts`). B3 starts from that committed result and is the ownership-isolated commit
`2304025e3ef54fcf38ffd3ab9393c8922902e9d8` (`feat: add cursor runtime adapter`). Review of
`994d555..2304025` found no ownership crossover: B3 adds only Cursor provider code, its focused
tests, and Cursor adapter documentation. It consumes A1/A2 domain ports and registration seams and
does not import or depend on A3 persistence internals.

### Persistence, recovery, and artifact evidence

- `control-plane/jobs.jsonl` is append-only, schema-validated, provenance-tagged, and fsynced on
  each complete state snapshot. Replay retains ordering, strips unknown fields on schema version 1,
  rejects unsupported versions and earlier corruption, rejects duplicate persistence event IDs,
  and tolerates only an unterminated final crash fragment.
- Restart reconstructs immutable requests, terminal results, usage, lineage, idempotency keys, and
  report-back state. Stored `queued`, `dispatched`, or `running` work becomes `interrupted` because
  old runtime ownership is unverifiable. `interrupted` and `settled` records are preserved.
  Recovery never redispatches, retries, resumes, routes, or delivers report-back; repeated recovery
  is idempotent and a recovered idempotency key prevents duplicate dispatch.
- An omitted Claude model stays omitted data on recovery and is never interpreted as safe to
  relaunch. Live PTYs are not reconstructed.
- Artifact content is SHA-256-addressed with collision-safe descriptor UUIDs. Metadata records
  logical name/kind, media type, byte length, digest, creation time, and producing job. Content and
  metadata use write-temp, file fsync, atomic rename, and directory fsync. Bounded reads validate
  UUID, version/schema, root containment, exact content path, regular-file type, length, and digest;
  missing, corrupt, oversized, traversal, and unresolved-external cases are explicit errors.

### Cursor fixture evidence and limits

- The B1 evidence-backed provider id/executable mapping is `cursor -> agent`. A read-only
  `agent --help` metadata inspection confirmed the current `--workspace`, `--sandbox`, `--mode`,
  `--print`, `--output-format stream-json`, `--stream-partial-output`, and `--model` surface. It
  started no session and sent no prompt.
- Deterministic fixtures prove interactive command construction and bounded/headless mechanics:
  explicit cwd/workspace, read-only `--sandbox enabled --mode plan`, workspace-write with explicit
  sandbox and no fabricated read-only mode, positional headless instruction, explicit-model-only
  forwarding, split/multiple frames, malformed/truncated output, injected terminal interpretation,
  non-zero exit, process error, cancellation, timeout, cleanup, and duplicate protection.
- Tests prove the adapter emits none of `--force`, `--yolo`, `--auto-review`, `--approve-mcps`,
  `--trust`, continuation/resume, worktree, API-key, fallback, or unrequested-model flags. Every
  adapter test injects the recording fixture or an in-memory process; the installed `agent` cannot
  be spawned by those tests.
- Cursor's real `stream-json` field schema, terminal-result fields, plan/ask runtime behavior,
  workspace-write runtime behavior, provider-native continuation, and live model execution remain
  **live-unverified**. The default result interpreter fails closed. Phase 1's closed interactive
  session union still makes broker registration of Cursor interactive sessions unsupported; B3
  supplies the broker-PTY-ready command builder without editing that A-owned contract.

### Verification and teardown

- A3 focused: `mise exec -- pnpm exec vitest run tests/persistence/job-store.test.ts
  tests/persistence/artifact-store.test.ts tests/integration/job-recovery.test.ts
  tests/integration/broker-recovery.test.ts tests/control-plane/job-control-plane.test.ts
  tests/domain/job.test.ts` — **6 files / 55 tests passed**.
- B3 focused: `mise exec -- pnpm exec vitest run tests/providers/cursor-adapter.test.ts` — **1 file
  / 15 tests passed**.
- Full: `mise exec -- pnpm test` — **35 files / 248 tests passed**; `mise exec -- pnpm check`,
  `mise exec -- pnpm build`, and `git diff --check` all passed.
- No real Cursor/Claude/Codex/Antigravity session, provider/model call, paid usage, Fable call,
  authentication mutation, automatic routing, model selection, or fallback occurred. Final
  read-only inspection found no Cyberdeck socket, `cyberdeck` tmux session, exact Cursor CLI
  process, recording fixture process, or Cyberdeck broker process.

The A3+B3 wave is integrated. A4 and B4 are unblocked from the resulting evidence commit; neither
has begun in this session.

## A4+B4 integration evidence — PASS (2026-07-21)

The wave starts at the recorded A3+B3 integration baseline
`9239a81f840ec85b2784c9aa06bc6a054bd2a3b6`. A4 is
`f54318d870e0dab94b5e76babfb2e30e0787ef68` (`feat: add app server and worktree leases`), and B4 is
`4919a31e08ceb7dfe14acbf237c3092f5bfc7c56` (`feat: add antigravity runtime adapter`). Both commits
are present directly in the canonical `main` ancestry. Review found no cross-wave conflict: A4 owns
the App Server transport, job interruption mapping, and durable lease service; B4 adds only
Antigravity provider modules, its focused tests, and adapter documentation. B4 consumes A1's open
provider/dispatch contracts and does not depend on A4 internals.

### App Server and lease evidence

- The fixture-backed App Server adapter performs validated JSON-RPC initialization, explicit
  `thread/start` and `turn/start`, correlated completion, `turn/interrupt` cancellation/timeout,
  bounded diagnostics, duplicate suppression, and exact-once cleanup. It never routes or falls back
  to another provider, and missing model/usage data remains omitted rather than inferred.
- Repository/worktree identities are canonicalized, read-only sharing and workspace-write conflicts
  are enforced, fencing tokens increase monotonically, and acquire/renew/release/expiry changes are
  persisted before return. Restarted held leases become blocking orphans until explicit matching-token
  resolution; no Git directory, branch, or worktree is ever deleted automatically.
- Installed Codex inspection was metadata-only. App Server execution remains fixture-proven and
  live-unverified until the final human-launched gate.

### Antigravity evidence and limits

- The evidence-backed mapping is `antigravity -> agy`. Read-only commands use documented
  `--mode plan --sandbox`; workspace-write fails closed because the documented `accept-edits` mode
  would widen semantics. Explicit models are forwarded once, omitted models stay omitted, and role
  is never mapped to `--agent`.
- Headless instructions use the documented `--print` value and empty stdin. Output remains bounded,
  untrusted plain text because `agy` exposes no structured output contract; the default terminal
  interpreter therefore fails closed rather than treating exit zero as proof of success.
- Fixtures prove construction, output bounds, cancellation, timeout, duplicate protection, and
  cleanup without resolving or spawning installed `agy`. Interactive registration remains blocked by
  the intentionally closed Phase 1 session-provider union and is left for A5 composition review/B5
  presentation rather than patched across ownership boundaries.

### Verification and teardown

- Focused A4+B4 verification passed **5 files / 40 tests**.
- Full verification passed **40 files / 288 tests**; `mise exec -- pnpm check`,
  `mise exec -- pnpm build`, and `git diff --check` also passed.
- The initial sandboxed full-test attempt failed only because the managed sandbox denied temporary
  Unix-socket listeners (`EPERM`); the same suite passed unchanged with socket permission.
- No real provider/model call, Fable call, authentication mutation, automatic routing, model
  selection, fallback, or destructive worktree action occurred.

The A4+B4 wave is integrated. A5 is unblocked from this recorded baseline; B5 remains blocked until
A5 is completed and human-integrated, preserving the required sequential order.

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

- [x] A parent submits a bounded job; a **structured delegation** creates a child job; the child
  settles and its `JobReport` is routed back to the parent by `correlationId`, observed live.
- [x] The delegated worker uses an **explicit Codex** provider (or a fake), with an arbitrary opaque
  role preserved and no role semantics applied.
- [x] A delegated **Fable** attempt is refused before any process starts
  (`FABLE_REQUIRES_EXPLICIT_HUMAN_START`), and no new job/session/PID appears.
- [x] An **omitted-model Claude** start (top-level or delegated) is **refused before any process
  spawns** via the B2-wired `evaluateClaudeLaunchSafety`; no Claude process is created. (If B2's
  enforcement is not yet integrated, the omitted-model Claude live check stays hard-blocked and the
  gate fails.)
- [x] No Fable process is ever launched. Job and session records stay distinct.
- [x] Starting state proven before, teardown verified after (PIDs gone, socket removed, panes closed).

**Gate 1 evidence — PASS (2026-07-21, human-launched top-level Codex).** B2 commit `8ecaac5`
was integrated without content drift as `fbc91a5` on `integration/a1-b1-a2` (stable patch id
`b52e42492513ac3e6394600db2b7143535c3084e`). The operator first found one pre-existing broker
with only an already-exited detached Codex record, stopped it through the targeted `broker stop`
request, and then verified no broker PID, `/tmp/cyberdeck-501.sock`, or `cyberdeck` tmux session.

A temporary fixture-only harness composed A2's real `JobControlPlane` with B2's real
`ClaudeJobDispatchAdapter` through `registerAdapter`. It observed exactly one parent, one structured
child, one fake process construction, one validated terminal report with the requested
`correlationId`, one pending then acknowledged report-back, and a deduplicated retry. The arbitrary
role `luna-high-scout` remained on the job record and never affected argv/model selection. Delegated
Fable plus top-level and delegated omitted-model Claude attempts all failed before the adapter spawn
count or job count changed. The harness passed once and was removed after the run.

Focused verification passed 5 files / 60 tests. The full gate passed 30 files / 213 tests, followed
by successful `pnpm check`, `pnpm build`, and `git diff --check`. B1 fixtures were used; the real
Claude or Codex executable was never resolved or spawned by the gate, no Fable or paid-provider call
occurred, and no live-model acceptance was attempted. Final teardown again showed no broker PID,
socket, or tmux cockpit. Pre-existing Claude Desktop sessions used an explicit Opus model and were
not Cyberdeck children. A3 and B3 are unblocked from this verified integrated baseline.

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
  native-default-Claude gap. Hard-block omitted-model Claude live checks until B2 enforcement is
  integrated and gate-verified.
