# Agent A1 — Control-plane contracts and executable Phase 2/3 plan

You are the first of five sequential **Agent A** implementation sessions. `/Users/brandon/code/personal/cyberdeck` is the canonical repository and primary checkout, but you must **not** work in that checkout. Work only in the dedicated linked Git worktree assigned to Agent A by the human operator; all five sequential A1–A5 sessions reuse that one Agent A worktree. Agent B uses a different isolated worktree. This is an implementation session running on Claude Opus High. Do not use Fable for any purpose.

## Non-negotiable operating rules

- Work inline by yourself. **Do not spawn subagents, delegate work, or ask another agent to review or implement anything.**
- Agent B is a separate, human-launched top-level peer working in another worktree. Do not message it, manage it, merge or cherry-pick its commits, or edit its adapter/presentation-owned areas.
- Treat `src/providers/**`, `src/client/**`, `src/tmux/**`, dashboard/cockpit presentation, and provider-facing CLI UX as Agent B-owned unless current repository documentation explicitly establishes a narrower boundary. If a contract change needs B-side work, document the handoff; do not implement that side.
- Preserve Cyberdeck's neutral policy: provider is always explicit; model is an optional provider-native opaque string; role is an optional opaque user string with no capabilities or routing semantics; sandbox is independent. Add no provider ranking, model recommendation, automatic provider/model fallback, or role catalog.
- Never launch, probe, test, delegate to, or otherwise use Fable. Preserve the existing rule that delegated Fable is rejected before process launch and that only a human may deliberately type a top-level Fable start. Do not weaken that rule. Do not spend live model usage in automated tests.
- **Current safety gap:** delegated-Fable rejection examines only an explicitly supplied model string. An omitted Claude model previously resolved to native-default Fable, so current policy does not prevent native-default Fable. Never claim that it does. In this or any later live check, a Claude start is forbidden unless the human operator supplies and has independently verified an explicit ordinary non-Fable model. Keep `model` optional in neutral stored contracts where appropriate, but treat omission as unsafe at the live Claude launch boundary until the gap is explicitly resolved.
- The ten planned implementation sessions are five sequential Agent A sessions and five sequential Agent B sessions. They are not ten concurrent workers. Within each track, never start the next session before its prerequisite baseline is integrated and verified.
- Any live broker, provider, or tmux acceptance must be serialized under one human operator: prove the broker/tmux starting state, run one bounded scenario at a time, stop/clean it, and verify PIDs/socket/panes before the next scenario. Do not overlap live checks across A and B worktrees.
- Inspect before editing. The file lists below are hypotheses, not permission to edit blindly.
- Before reading or editing, verify `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, and `git worktree list --porcelain`. The current top level must be the dedicated Agent A worktree, not `/Users/brandon/code/personal/cyberdeck` and not Agent B's worktree. Require an Agent A track branch and a clean status. If isolation is not proven, stop without changes. Do not create, remove, switch, or repair worktrees yourself.
- Leave one clean conventional commit containing only this session's work. Do not push, merge, rebase, or amend another session's commit.

## Baseline and prerequisites

Begin with:

```bash
pwd
git rev-parse --show-toplevel
git rev-parse --git-common-dir
git worktree list --porcelain
git status --short
git branch --show-current
git log -8 --oneline --decorate
```

The worktree must be clean and based on the completed Phase 1 baseline (currently ending at `docs: define cyberdeck phase one boundary`). Read, at minimum, `README.md`, `docs/architecture/session-model.md`, `docs/setup/phase-1-acceptance.md`, `docs/setup/runtime-baseline.md`, the entire Phase 1 plan, and the relevant domain/protocol/broker tests and sources. If the worktree is dirty, the Phase 1 baseline is missing, or it already contains unexplained Phase 2/3 implementation, stop and report the mismatch without changing files.

Phase 1's known boundary is important: a session is a live broker-owned PTY; it is not a bounded job. Metadata is journaled, but an active PTY is not recovered after broker death. The Claude live acceptance was intentionally incomplete because the native default displayed Fable; do not “finish” it by invoking Fable.

## Objective

Establish the smallest stable, versioned control-plane contracts needed by both tracks, then write an executable Phase 2/3 implementation plan that sequences the remaining Agent A and Agent B work. Make an explicit, evidence-based decision about whether any Phase 1 cleanup is required before extension.

## Required scope

1. Inspect the existing `SessionRecord`, start-policy, broker-event, JSONL frame, registry, and RPC boundaries. Preserve compatibility with Phase 1 unless a change is essential and tested.
2. Define runtime-validated, serializable contracts for the future control plane. At minimum cover:
   - bounded jobs, their immutable request and lifecycle states;
   - explicit delegation intent and parent/correlation identifiers;
   - terminal job result/report-back envelopes;
   - structured artifact descriptors and content references, without implementing storage yet;
   - repository/worktree lease records, without implementing lease behavior yet;
   - concurrency and budget declarations/usage, without implementing scheduling yet;
   - a provider-neutral dispatch/completion/cancellation adapter port that B2–B4 can implement without waiting for A2;
   - an extensible provider-registration contract that preserves explicit selection and runtime validation without leaving the shared type permanently closed to only `codex | claude`; concrete Cursor/Antigravity identifiers must be finalized from integrated B1 evidence before B3/B4;
   - stable schema/version fields and error codes where cross-process compatibility needs them.
3. Keep “session” and “job” separate. A job may use a session/runtime, but must not redefine attachment state as job state or assume one job equals one provider process.
4. Use discriminated unions and Zod validation where they make invalid lifecycle data unrepresentable. IDs, timestamps, optional fields, and forward-compatibility behavior must be deliberate. Do not create a speculative framework or implement the later registries/services in this session.
5. Create a concise architecture note explaining the contracts, ownership boundaries, invariants, and the allowed dependency direction between domain, broker/control plane, persistence, adapters, and presentation.
6. Create an executable Phase 2/3 plan with checkable tasks, tests, integration baselines, Agent A/Agent B ownership, and stop conditions. It must encode this recovered Agent A sequence:
   - A1 contracts plus the executable plan and Phase 1 cleanup decision;
   - A2 durable jobs, structured delegation, results, and report-back;
   - A3 persistence, recovery, and structured artifacts;
   - A4 Codex App Server control-plane integration plus repository/worktree leases;
   - A5 integration, concurrency, budgets, and reconciliation.
7. Encode two mandatory **human-launched top-level Codex gates** in the plan:
   - after A2 and B2 are integrated and structured delegation works end to end, before A3 begins;
   - after final A/B integration, before Phase 2/3 is declared complete.
   These gates are review/acceptance sessions, not children spawned by Agent A or Agent B. They must not use Fable.
8. Audit Phase 1 for extension blockers or narrow cleanup needs (naming such as phase-specific configuration, event evolution, serialization, lifecycle ambiguity, or test debt). Give the omitted-Claude-model/native-default-Fable gap explicit priority: the plan must state the safe live-launch invariant and must not describe explicit-string rejection as complete prevention. Record tightly scoped cleanup with rationale/owner if code must change, or justify deferral while hard-blocking all omitted-model Claude live checks. Record other cleanup as either a scoped task or “no additional cleanup required” with evidence. Do not perform broad cleanup for aesthetics.

Likely files to inspect and possibly touch, only after confirming the fit:

- `src/domain/session.ts`, `src/domain/events.ts`, `src/domain/policy.ts`, `src/protocol/frames.ts`
- new control-plane contract modules under `src/domain/`
- matching tests under `tests/domain/` and/or `tests/protocol/`
- a new control-plane architecture note under `docs/architecture/`
- a new executable Phase 2/3 plan under `docs/superpowers/plans/`
- narrowly necessary updates to `README.md` or the Phase 1 architecture docs

Do not implement job execution, adapter processes, persistence/recovery, artifact storage, App Server transport, worktree mutation, schedulers, budgets, or reconciliation yet. A1 freezes shared ports and registration seams; it does not implement B-owned adapters.

## TDD and verification

For every executable contract change, first add a focused failing test, run it and observe the expected failure, then implement the minimum behavior and rerun it. Include negative tests for invalid state/shape and neutrality tests showing that arbitrary model and role strings remain opaque while provider remains explicit. Tests must use fixtures/fakes only—no Claude, Codex, or Fable model calls.

Finish by running:

```bash
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
git diff --check
git status --short
```

Review the diff for scope and ownership. Then create exactly one clean conventional commit, expected shape:

```text
feat: define control plane contracts
```

Use a different conventional subject only if the actual diff clearly warrants it.

## Report back

Return a concise, precise report containing:

- the commit hash and exact subject;
- files changed and the contract/plan purpose of each;
- the chosen Phase 1 cleanup decision and evidence;
- the final A/B ownership boundary and ordered integration prerequisites;
- how the omitted-Claude-model safety gap is blocked or scheduled for cleanup, without claiming current policy already closes it;
- the exact two Codex gates and their pass conditions;
- focused red/green tests run plus full test/check/build results;
- `git status --short` after the commit;
- any unresolved decision or handoff for Agent B, without implementing it.
