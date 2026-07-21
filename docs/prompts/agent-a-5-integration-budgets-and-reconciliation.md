# Agent A5 — Integration, concurrency, budgets, and reconciliation

You are the fifth and final **Agent A** implementation shot. `/Users/brandon/code/personal/cyberdeck` is the canonical repository and primary checkout, but you must **not** work there. Your already-provisioned worktree is exactly `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-a-future`; work only there. It is reused for A3–A5, while Agent B uses `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-b-future`. Do not create, request, switch, or repair another worktree. Use Claude Opus High. Do not use Fable.

## Operating rules

- Work inline alone. **Do not spawn subagents, delegate work, or use agent teams for implementation/review.**
- Agent B is a separate human-launched top-level peer in another worktree. Do not contact or manage it, merge/cherry-pick its work, or edit B-owned provider adapters and presentation surfaces.
- Your baseline may already contain B commits integrated by the human operator. Treat them as read-only integration dependencies and make control-plane changes around their published contracts. Do not “clean up” B code opportunistically.
- Preserve neutral policy: explicit provider, optional opaque provider-native model, optional opaque role, independent sandbox; no rankings, recommendations, role semantics, automatic routing, or fallback.
- Never invoke Fable. Preserve delegated-Fable rejection before launch. Automated verification uses fakes; any later live model acceptance belongs to the separate human-launched gate.
- Explicit-string delegated-Fable rejection does not protect an omitted Claude model; Phase 1 observed the native default select Fable. Never claim current policy prevents this. Any live Claude start is forbidden unless the human supplies and independently verifies an explicit ordinary non-Fable model. Unknown/omitted model state must remain unsafe for live Claude dispatch and recovery, not be converted into a default.
- The implementation uses dependency-safe parallel waves. A5 begins only after the human-integrated A4+B4 baseline and completes before B5. Concurrency controls implemented here govern bounded runtime jobs, not the human implementation-session plan.
- Serialize all live broker/App Server/provider/tmux acceptance under one human operator. Never run A/B live checks concurrently; verify clean PIDs, socket, App Server children, and panes between scenarios.
- Before reading or editing, verify `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, and `git worktree list --porcelain`. The current top level must equal `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-a-future`, not the primary checkout and not Agent B's worktree. Require the continuing Agent A branch and a clean status. The worktree is already provisioned; do not request or create another.
- Make one clean conventional commit. Do not push, merge, rebase, or amend other work.

## Baseline and prerequisites

Verify a clean worktree, current branch, and recent log. The baseline must include A1–A4, the passed post-A2+B2 Codex gate evidence, and the human-integrated B1–B4 commits/contracts. B5 must not have begun yet: A5 completes neutral backend composition before B5 performs the final presentation/acceptance/documentation shot. All A3 restart/artifact tests and A4 fake App Server/lease tests must pass before edits. If B's expected interfaces are absent, contracts conflict, the baseline is dirty, or integration would require you to merge B, stop and report the exact mismatch.

Read the full Phase 2/3 plan, ownership/architecture docs, job and lease state machines, persistence/recovery, App Server transport, B-facing ports, configuration, broker startup/shutdown, and all integration tests.

## Objective

Complete the control-plane integration by enforcing neutral concurrency and explicit budgets, reconciling persisted jobs/runtimes/leases/report-backs after failures, and supplying deterministic end-to-end acceptance coverage. Do not declare the overall phase complete; a separate final Codex gate must do that after human integration.

## Required scope

1. Implement an admission/scheduling layer over durable jobs:
   - enforce configured global concurrency and any explicit per-provider/per-repository limits from the committed contracts;
   - use deterministic, starvation-resistant ordering (document it);
   - reserve a slot exactly once before dispatch and release it exactly once on every terminal/failed-to-launch path;
   - never select or substitute a provider/model based on capacity.
   - never admit a live Claude dispatch with an omitted/unverified model merely because a slot is available; preserve the explicit operator-verified ordinary non-Fable launch condition.
2. Implement explicit budgets established in A1. Support only measurable limits justified by available data, such as elapsed time, attempts, jobs/delegations, artifact bytes, or reported token usage. Treat unavailable usage as unknown, never zero. Define admission versus post-run enforcement and fail closed where a hard limit cannot be proven.
3. Preserve delegation depth and parent budget propagation without inventing role/model costs. Child reservations/usage must reconcile to their parent or root budget exactly once.
4. Implement a reconciliation pass that compares durable control-plane state with supervised runtime/App Server state, leases, artifacts, and report-back acknowledgements after startup or disconnect. It must:
   - avoid duplicate dispatch/completion/report-back;
   - interrupt or quarantine unverifiable in-flight work;
   - fence/release only leases proven stale under A4 rules;
   - surface orphaned runtimes, leases, artifacts, and pending reports as structured reconciliation findings;
   - require explicit operator action for destructive cleanup or ambiguous retry.
5. Integrate broker startup/shutdown ordering so persistence is ready before admission, reconciliation completes before new writable dispatch, and shutdown stops admission before draining/cancelling runtimes and persisting final state.
6. Add stable observability/control-plane queries for queue/admission, budget usage, reconciliation findings, and job/report-back state. Complete neutral backend composition/registration for the approved B2–B4 adapters using their already integrated extension points, including provider IDs and non-presentational CLI/control-plane routing where the current architecture places that wiring. Do not edit B-owned adapter implementations. Leave command copy, presentation, dashboard, and cockpit rendering to B5.
7. Add deterministic end-to-end tests using fake terminal/App Server adapters and temporary Git repositories. Cover at minimum:
   - mixed providers with explicit selection and no fallback;
   - concurrency saturation and fair release;
   - two jobs contending for one writable repository;
   - cancellation/timeout during launch and execution;
   - budget rejection/exhaustion with unknown usage;
   - broker restart during an in-flight job;
   - duplicate adapter completion and report-back acknowledgement;
   - stale lease fencing and non-destructive reconciliation;
   - a complete parent → child delegation → structured result/artifact → acknowledged report-back flow.
8. Update architecture, operations, acceptance, and Phase 2/3 plan checkboxes/evidence for Agent A's completed work. Distinguish automated fake-runtime evidence from any live provider evidence. Record remaining B integration items and the final gate; do not claim they passed in this session.

Likely files, only after inspection:

- new scheduler/admission, budget, and reconciliation modules under `src/control-plane/**`
- `src/config.ts`, domain events/contracts, persistence and lease services
- broker startup/server backend query wiring and neutral provider/CLI composition where required
- comprehensive `tests/control-plane/**` and `tests/integration/**`
- architecture/operations/acceptance docs and the executable Phase 2/3 ledger

Do not redesign B's adapters, client presentation, command copy, dashboard, or tmux presentation. A5 owns only the neutral registration/composition and non-presentational routing needed to make already integrated adapters reachable. Do not add automatic routing/fallback, semantic model pricing, role catalogs, semantic memory, or destructive cleanup.

## TDD and verification

Use TDD for each scheduler, budget, and reconciliation invariant: focused failing test first, observe the intended failure, minimal implementation, then green. Include race-oriented tests with controlled promises/fake clocks rather than sleeps where practical. Prove every reservation, terminal transition, lease, budget debit, and report acknowledgement is idempotent.

Run:

```bash
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
git diff --check
```

Review the full A5 diff plus integration-facing contract changes. Make exactly one conventional commit, expected shape:

```text
feat: reconcile jobs and enforce budgets
```

## Mandatory downstream B5 handoff and final integration gate

After this commit, stop. The human operator must first integrate A5 into the dedicated Agent B worktree's approved baseline and run B5. A5 must not launch B5, edit its worktree, or claim that the final gate is ready before B5 commits. After B5, the human operator integrates the approved A5 and B5 commits onto a fresh integration worktree and launches a **separate top-level Codex** review/acceptance session. Neither A nor B may spawn that reviewer, and the gate must not use Fable.

The final Codex gate must inspect the actual integrated diff and independently run test/check/build plus the deterministic end-to-end acceptance. All live broker/tmux scenarios must run serially with verified cleanup between them. It must verify: Phase 1 session behavior remains intact; explicit provider and opaque model/role policy remains intact; delegated explicit Fable is rejected pre-launch without invoking it; omitted Claude model is not falsely treated as safe and no live Claude start occurs without a human-supplied, independently verified ordinary non-Fable model; structured delegation/report-back works; persistence/recovery is honest; artifacts validate; App Server failures do not duplicate jobs or fall back providers; writable worktree leases fence conflicts; concurrency/budgets reconcile exactly once; ambiguous/destructive recovery fails closed; and Agent A/B ownership integration has no missing adapter/UI/backend seam. Only the human may mark the Phase 2/3 plan complete after that gate passes.

## Report back

Return:

- commit hash and subject;
- changed files and responsibilities;
- scheduling order and concurrency reservation/release invariants;
- budget units, unknown-usage behavior, propagation, and enforcement points;
- admission/recovery behavior for omitted Claude models and the evidence that current policy was not overstated;
- reconciliation algorithm, findings, and fail-closed operator actions;
- red/green evidence and full test/check/build results;
- `git status --short` after commit;
- exact A5 commit/baseline that must be supplied to B5, followed by the A5+B5 baseline expected by the final Codex gate;
- a paste-ready B5 handoff plus final-gate checklist/commands and every known residual risk, without claiming B5 or the gate has run.
