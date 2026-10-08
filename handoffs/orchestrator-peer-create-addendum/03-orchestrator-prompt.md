# Dispatch prompts (MIK-257)

Proposed dispatch: implementation worker **Codex `gpt-6.1-sol`, effort `xhigh`, workspace-write, auto
approval, Cyberdeck-provisioned worktree**; reviewer **Codex `gpt-6.1-sol`, effort `xhigh`, read-only**
(the MIK-256 reviewer at this setting found two highs and four mediums). Claude `opus` at `high` is the
fallback for either role. Fable workers need the `worker.start.fable` grant, which the dispatching Orc
does not hold. Cursor workers block on approval prompts.

## Worker prompt

```text
Implement Linear MIK-257 as planned in /Users/brandon/code/personal/cyberdeck/handoffs/orchestrator-peer-create-addendum (read README.md, 00-spec.md, 01-implementation-plan.md, 02-acceptance.md in that order; the decisions are made, do not reopen them).

Goal: cyberdeck_orchestrator_create has no live-peer cap; every create requires an `approval` argument quoting the operator's express approval, refused with APPROVAL_REQUIRED when absent; the approval and a lineage depth are journaled and persisted on the peer binding and reported by inspect; peers keep the creator's full grant and may create peers under the same rule; prompt text and docs say so.

You are in a Cyberdeck-provisioned worktree on your own branch. Do not commit; the orchestrator commits on the host. Use Node 24.18.0 (/Users/brandon/.local/share/mise/installs/node/24.18.0/bin first in PATH). Never touch the live broker, ~/Library/Application Support/Cyberdeck, or the main checkout at /Users/brandon/code/personal/cyberdeck.

Follow 01-implementation-plan.md T1 to T8 in order. Keep all new logic in src/domain/orchestrator.ts and src/orchestration/orchestrator-peer-service.ts; agent-control-service.ts is at its file-size ceiling. Keep the MIK-256 serialization, mutationId replay, scope narrowing, brief delivery and actorSessionId-stripping behaviour and their tests. Replace the cap tests with the approval and lineage tests listed in T7. `grep -rn "PEER_LIMIT\|MAX_LIVE_PEERS\|cannot create peers" src tests docs README.md CLAUDE.md` must come back empty.

Gate before you report: pnpm check, full pnpm test, tests/architecture green. Write your report to handoffs/orchestrator-peer-create-addendum/reports/worker.md: files changed, tests added/replaced with counts, the exact grep output, anything in T5 you could not verify, and open questions. Then stop.
```

## Reviewer prompt

```text
Read-only review of the MIK-257 change in <worktree path> against origin/main (f1619a5). Spec: handoffs/orchestrator-peer-create-addendum/00-spec.md. Look for: a path that creates a peer without a journaled approval; any way a peer's grant exceeds its creator's; a regression in mutationId replay or per-creator serialization now that the cap is gone; schema or binding-log incompatibility with MIK-256 records lacking createdBy.approval/depth; prompt or tool text that still promises a cap or non-transitivity; ratchet or dependency-rule violations. Report findings as high/medium/low with file:line and a concrete failing scenario each, to handoffs/orchestrator-peer-create-addendum/reports/review.md. Do not edit files.
```
