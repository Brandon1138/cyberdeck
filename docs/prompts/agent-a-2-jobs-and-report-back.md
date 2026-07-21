# Agent A2 — Durable jobs, structured delegation, results, and report-back

You are the second of five sequential **Agent A** implementation sessions. `/Users/brandon/code/personal/cyberdeck` is the canonical repository and primary checkout, but you must **not** work there. Continue only in the dedicated linked Git worktree assigned to Agent A and reused across A1–A5; Agent B has a different isolated worktree. Use Claude Opus High. Do not use Fable.

## Operating rules

- Work inline alone. **Do not spawn subagents, delegate work, or use agent teams for implementation or review.**
- Agent B is a human-launched top-level peer in another worktree. Do not manage, contact, merge, cherry-pick, or modify B's work.
- Do not edit B-owned provider adapters or presentation surfaces: `src/providers/**`, `src/client/**`, `src/tmux/**`, dashboard/cockpit UI, or provider-facing CLI UX. Treat file paths as hypotheses and respect the ownership map committed by A1 if it is more precise.
- Preserve explicit provider selection and opaque model/role strings. Add no routing, rankings, semantic roles, fallback, or provider-specific job policy.
- Never launch or invoke Fable. Preserve rejection of delegated Fable before any process starts. Automated and acceptance tests use fakes and spend no model usage.
- Current rejection only detects an explicit Fable model string; an omitted Claude model previously selected native-default Fable. Do not claim current policy prevents that. Any live Claude start is forbidden without a human-supplied, operator-verified explicit ordinary non-Fable model. Stored model data may remain optional under the neutral contract, but omission must not be treated as live-launch safety.
- The five A sessions and five B sessions are sequential within their tracks, never ten concurrent sessions. Do not start downstream work from an unintegrated baseline.
- Serialize all live broker/provider/tmux checks under one human operator. Do not overlap checks across worktrees; verify clean start and complete PID/socket/pane cleanup between scenarios.
- Before reading or editing, verify `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, and `git worktree list --porcelain`. The current top level must be the dedicated Agent A worktree, not the primary checkout and not Agent B's worktree. Require the continuing Agent A branch and a clean status. If isolation is not proven, stop without changes. Do not create, remove, switch, or repair worktrees yourself.
- Make one clean conventional commit. Do not push, merge, rebase, or amend prior commits.

## Baseline and prerequisites

Verify a clean worktree, branch, and recent log. The baseline must include the human-integrated A1 control-plane contracts/adapter port/registration seam, architecture note, executable Phase 2/3 plan, recorded Phase 1 cleanup decision, and B1 capability evidence. Do not infer or consume uncommitted B changes. If those prerequisites are absent, conflict with the source, or the worktree contains unexplained edits, stop without modifying files.

Read the current README, session architecture, control-plane architecture, Phase 2/3 plan, contract modules, registry/server/RPC seams, and their tests before deciding placement. A bounded job is durable control-plane state, distinct from a live PTY session.

## Objective

Implement the control-plane backend for durable jobs and structured delegation, including deterministic lifecycle transitions, terminal results, and an explicit report-back handoff. Build ports that Agent B can drive without placing provider-specific parsing or presentation in Agent A's code.

## Required scope

1. Implement a job registry/service around the A1 contracts with validated transitions for creation/admission, assignment or start, completion, failure, and cancellation. Reject stale, duplicate, or illegal terminal transitions deterministically.
2. Give every job stable identity, correlation/parentage, timestamps, an explicit provider, optional opaque provider-native model, optional opaque role, sandbox, working directory/repository context, and immutable request payload as defined by A1. Do not smuggle routing decisions into defaults.
3. Implement structured delegation as a control-plane operation, not as free-form terminal scraping:
   - validate the delegation request before any runtime launch;
   - preserve parent/correlation links and the configured depth/concurrency policy;
   - reject delegated Fable before invoking a launch port;
   - do not treat that explicit-string check as protection against an omitted Claude model; enforce or propagate the committed safe-launch requirement that live Claude dispatch needs an operator-verified explicit ordinary non-Fable model;
   - make retry/idempotency behavior explicit so a repeated request cannot silently create duplicate jobs.
4. Implement the control plane's use of the provider-neutral dispatch/completion/cancellation adapter port frozen by A1. Do not redesign that port during the parallel B2 shot; if it is insufficient, stop and report the exact contract gap. The control plane owns state; Agent B-owned adapters translate provider/runtime events through the port. Do not edit provider adapters here.
5. Store and expose a terminal result envelope containing status, summary/error, structured output references, usage fields when reported, and provenance. Absence of usage must remain unknown, never fabricated as zero.
6. Implement report-back as a durable, idempotent control-plane handoff from a completed child job to its parent/caller. Track pending/delivered/failed acknowledgement state or the equivalent contract established by A1. A job must not be considered successfully reported merely because terminal text appeared.
7. Expose the minimum broker-side API needed for B2 to submit/query/cancel jobs, ingest adapter completion, and acknowledge report-back. Prefer typed method schemas over ad hoc `unknown` params. Preserve existing Phase 1 session methods. Using the integrated B1 evidence and A1 registration seam, finalize the approved canonical Cursor and Antigravity provider identifiers plus their unsupported-until-registered behavior before B3/B4; do not implement their adapters or invent capabilities.
8. Emit the job/delegation/result/report events established by A1, with secrets and full prompt bodies excluded from routine journal metadata.
9. Provide a deterministic fake adapter/runtime harness and an integration test proving a parent request produces one child job, one terminal result, and one acknowledged report-back without a real model call.

Likely areas, subject to repository inspection:

- A1 job/delegation/result contracts under `src/domain/`
- a new `src/control-plane/` job registry/service consuming the A1 adapter port
- `src/domain/events.ts`, `src/domain/policy.ts`, `src/config.ts`
- broker routing/schema integration in `src/broker/server.ts` and possibly `src/protocol/frames.ts`
- focused `tests/control-plane/`, broker, policy, and integration tests

Do not implement durable disk recovery or artifact blobs (A3), Codex App Server or worktree leases (A4), scheduling/budget enforcement/reconciliation (A5), or B-owned adapter/CLI/UI behavior.

## TDD and verification

Work test-first. For each lifecycle/idempotency/policy behavior, write the smallest failing test, run it to confirm the intended failure, then implement and rerun. Cover at least illegal transitions, duplicate submission, duplicate completion/report acknowledgement, missing parent, delegated Fable rejection before launch-port invocation, arbitrary opaque roles/models, adapter failure, cancellation, and the fake end-to-end report-back path.

Run the full gate:

```bash
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
git diff --check
```

Review ownership and scope, then make exactly one conventional commit, expected shape:

```text
feat: add durable job control plane
```

## Mandatory integration stop after this session

Do **not** begin A3. After A2 and the separately human-run B2 are complete, the operator must integrate their clean commits onto a fresh baseline and launch a separate top-level Codex gate. That gate must run serially with every other broker/tmux check and verify, using fakes first and an explicitly approved ordinary non-Fable runtime only if the operator chooses, that structured delegation works end to end: one request, one child job, one bounded execution, one structured terminal result, one report-back acknowledgement, no duplicate dispatch, and no ownership-policy regression. If Claude is exercised at all, its model must be explicit and independently operator-verified as ordinary/non-Fable; omission is forbidden. A3 is blocked until that gate passes. You do not launch the gate and you do not merge B2.

## Report back

Report exactly:

- commit hash and subject;
- files changed and the behavior added;
- job state machine, idempotency keys, and report-back acknowledgement semantics;
- the A1-frozen adapter/runtime port and the exact A2 control-plane consumption semantics Agent B implements against, with no B-side edits made;
- the exact behavior for an omitted Claude model and evidence that no claim of native-default Fable prevention was made;
- red/green test evidence and full test/check/build results;
- `git status --short` after commit;
- the A2+B2 integration assumptions and exact Codex-gate command/scenario the human should run;
- any blocker that prevents the gate from being meaningful.
