# Agent A5 — Integration, concurrency, budgets, and reconciliation

You are the fifth and final **Agent A** implementation shot. Work directly and inline as one top-level session. **Do not spawn subagents, delegate implementation/review, or use Fable.**

## How to run this prompt (portable — shell/CLI or Claude Desktop)

This prompt is designed to be pasted as-is into either a shell-backed coding session or Claude Desktop. It does **not** require the session to start in a particular directory, branch, or Git worktree.

- The canonical repository is `/Users/brandon/code/personal/cyberdeck`. The intended Agent A checkout is `.claude/worktrees/agent-a-future`, but that path is an operator convenience, not an implementation precondition.
- Do not create, switch, repair, merge, or rebase worktrees/branches merely to satisfy this prompt. Use the Cyberdeck checkout or connected folder the operator supplied.
- Never stop solely because the current top-level path, branch name, Git common directory, or worktree layout differs or cannot be inspected from Desktop.
- If shell/Git access is available, record the current top level, status, SHA, and recent history. If Git metadata is unavailable, inspect the actual source/contracts/tests and state which baseline facts were source-verified versus assumed.
- Deliver one cohesive A5 change. Commit it only when the session is in a clean isolated checkout and can do so safely; otherwise make the edits in the connected folder or return one applicable patch plus verification output. Lack of commit capability is not a reason to abandon implementation.

## Operating rules

- Agent B is a separate human-launched top-level peer in another worktree. Do not contact or manage it, merge/cherry-pick its work, or edit B-owned provider adapters and presentation surfaces.
- Your baseline may already contain B commits integrated by the human operator. Treat them as read-only integration dependencies and make control-plane changes around their published contracts. Do not “clean up” B code opportunistically.
- Preserve neutral policy: explicit provider, optional opaque provider-native model, optional opaque role, independent sandbox; no rankings, recommendations, role semantics, automatic routing, or fallback.
- Never invoke Fable. Preserve delegated-Fable rejection before launch. Automated verification uses fakes; any later live model acceptance belongs to the separate human-launched gate.
- Explicit-string delegated-Fable rejection does not protect an omitted Claude model; Phase 1 observed the native default select Fable. Never claim current policy prevents this. Any live Claude start is forbidden unless the human supplies and independently verifies an explicit ordinary non-Fable model. Unknown/omitted model state must remain unsafe for live Claude dispatch and recovery, not be converted into a default.
- The implementation uses dependency-safe parallel waves. A5 begins only after the human-integrated A4+B4 baseline and completes before B5. Concurrency controls implemented here govern bounded runtime jobs, not the human implementation-session plan.
- Serialize all live broker/App Server/provider/tmux acceptance under one human operator. Never run A/B live checks concurrently; verify clean PIDs, socket, App Server children, and panes between scenarios.
- Do not push, merge, rebase, or amend other work.

## Baseline and prerequisites

The required **code baseline** is the human-integrated A4+B4 wave: A1–A4, B1–B4, and the passed post-A2+B2 Codex gate evidence. On the canonical history, the recorded wave baseline contains A4 `f54318d` and B4 `4919a31` plus the dated `A4+B4 integration evidence — PASS` section in the Phase 2/3 plan. B5 must not have begun yet because A5 completes neutral backend composition before B5 consumes it. All A3 restart/artifact tests and A4 fake App Server/lease tests must pass. Verify this from Git ancestry when available; in Desktop, verify the corresponding source, contracts, tests, and evidence. Do not hard-stop over checkout placement, a longer equivalent SHA, or unavailable Git metadata. Stop only for a real prerequisite failure: required A/B code is absent/incompatible, conflicts are unresolved, the repository cannot be reached, or A5 cannot proceed without editing B-owned implementations. Report the exact mismatch.

Operator sequence: integrate the completed parallel A4+B4 wave in a new integration chat, run A5 from that baseline, then integrate A5 into the checkout/folder supplied to B5. A5 and B5 are intentionally sequential, not parallel.

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

Review the full A5 diff plus integration-facing contract changes. If committing is safe in the current checkout, make exactly one conventional commit, expected shape:

```text
feat: reconcile jobs and enforce budgets
```

Otherwise deliver the same cohesive change as one patch/diff and identify verification that could not run on the current surface.

## Mandatory downstream B5 handoff and final integration gate

After this change, stop. The human operator must first integrate/apply A5 into the approved checkout or connected folder that will be supplied to B5; no particular worktree path is required. A5 must not launch B5 or claim that the final gate is ready before B5 finishes. After B5, the human operator integrates the approved A5 and B5 changes in a new top-level Codex session for runtime-environment acceptance, integration repair/polish, and the final gate. Neither A nor B may spawn that reviewer, and the gate must not use Fable.

The final Codex gate must inspect the actual integrated diff and independently run test/check/build plus the deterministic end-to-end acceptance. All live broker/tmux scenarios must run serially with verified cleanup between them. It must verify: Phase 1 session behavior remains intact; explicit provider and opaque model/role policy remains intact; delegated explicit Fable is rejected pre-launch without invoking it; omitted Claude model is not falsely treated as safe and no live Claude start occurs without a human-supplied, independently verified ordinary non-Fable model; structured delegation/report-back works; persistence/recovery is honest; artifacts validate; App Server failures do not duplicate jobs or fall back providers; writable worktree leases fence conflicts; concurrency/budgets reconcile exactly once; ambiguous/destructive recovery fails closed; and Agent A/B ownership integration has no missing adapter/UI/backend seam. Only the human may mark the Phase 2/3 plan complete after that gate passes.

## Report back

Return:

- commit hash and subject, or a clear patch-delivery note when the current surface cannot commit safely;
- changed files and responsibilities;
- scheduling order and concurrency reservation/release invariants;
- budget units, unknown-usage behavior, propagation, and enforcement points;
- admission/recovery behavior for omitted Claude models and the evidence that current policy was not overstated;
- reconciliation algorithm, findings, and fail-closed operator actions;
- red/green evidence and full test/check/build results;
- `git status --short` after commit when Git is available;
- exact A5 commit/baseline that must be supplied to B5, followed by the A5+B5 baseline expected by the final Codex gate;
- a paste-ready B5 handoff plus final-gate checklist/commands and every known residual risk, without claiming B5 or the gate has run.
