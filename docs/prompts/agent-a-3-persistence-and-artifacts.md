# Agent A3 — Persistence, recovery, and structured artifacts

You are the third **Agent A** implementation shot. `/Users/brandon/code/personal/cyberdeck` is the canonical repository and primary checkout, but you must **not** work there. Your already-provisioned worktree is exactly `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-a-future`; work only there. It is reused for A3–A5, while Agent B uses `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-b-future`. Do not create, request, switch, or repair another worktree. Use Claude Opus High. Do not use Fable.

## Operating rules

- Work inline alone. **Do not spawn subagents, delegate work, or use another agent for review.**
- Agent B is a separate human-launched top-level peer in another worktree. Do not contact, manage, merge, cherry-pick, or edit B's work.
- Do not edit B-owned provider adapters or presentation areas (`src/providers/**`, `src/client/**`, `src/tmux/**`, dashboard/cockpit and provider-facing CLI UX) unless the committed ownership document explicitly narrows that list. Use a handoff note for B-side needs.
- Preserve explicit provider, optional opaque model, optional opaque role, independent sandbox, and no routing/ranking/fallback. Never invoke Fable; preserve pre-launch delegated-Fable rejection.
- Explicit-string Fable rejection does not protect an omitted Claude model; the installed native default previously selected Fable. Never claim otherwise. Any live Claude start requires a human-supplied, operator-verified explicit ordinary non-Fable model. Persist optional model data honestly, but never reconstruct omission as proof of safe launch.
- The implementation runs in dependency-safe parallel waves. A3 may run alongside B3 only after Gate 1; use only the verified integrated predecessor baseline supplied in this worktree.
- Serialize any live broker/provider/tmux acceptance under one human operator and verify clean PID/socket/pane teardown between scenarios; do not overlap live checks across worktrees.
- Before reading or editing, verify `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, and `git worktree list --porcelain`. The current top level must equal `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-a-future`, not the primary checkout and not Agent B's worktree. Require the continuing Agent A branch and a clean status. The worktree is already provisioned; do not request or create another.
- Use fakes only for automated tests. Produce one clean conventional commit; do not push or merge.

## Baseline and prerequisites

Start by checking the worktree is clean and inspecting the log. The baseline must include A1 and A2, any B changes deliberately integrated by the human operator, and recorded evidence that the **post-A2+B2 top-level Codex structured-delegation gate passed**. The gate must have demonstrated one non-duplicated delegated job, structured completion, and acknowledged report-back. If that evidence is absent, A2/B2 are not integrated, or the contracts have drifted, stop and report the missing prerequisite without editing.

Read all control-plane contracts and tests, the executable Phase 2/3 plan, `src/broker/journal.ts`, `src/broker/main.ts`, session/job registries, paths/configuration, and the Phase 1 durability caveat. Preserve the truth that a broker-owned live PTY cannot be magically reconstructed after broker death.

## Objective

Make job state, results, report-back status, leases-to-be, and structured artifacts durable across broker restart, with deterministic recovery semantics and corruption-safe local storage. Do not claim live PTY recovery.

## Required scope

1. Evolve the append-only journal into a readable, validated persistence layer or add a snapshot-plus-journal repository behind a narrow interface. Preserve event ordering and schema/version provenance.
2. On startup, rebuild durable control-plane state deterministically. Recovery must be idempotent across repeated restarts and must not redispatch terminal jobs or duplicate report-back delivery.
3. Define honest recovery for work interrupted by broker death:
   - never claim the old PTY is still alive without verified ownership;
   - move jobs with unverifiable runtime ownership to an explicit interrupted/recovery-needed state or the A1-defined equivalent;
   - preserve terminal results exactly;
   - make retry/resume a later explicit decision, not an automatic provider fallback.
   - never resume or redispatch a Claude job with an omitted model as though current policy proved it non-Fable; require the explicit operator-verified ordinary model condition at any live launch boundary.
4. Implement atomic snapshots/compaction only if needed by the plan. Use write-temp, fsync/close as appropriate, and atomic rename; retain enough journal provenance to diagnose recovery. Tolerate an incomplete final JSONL line caused by a crash, but fail closed on earlier corruption instead of silently discarding history.
5. Implement a structured artifact store based on the A1 descriptors:
   - content-addressed or collision-safe IDs;
   - atomic writes;
   - recorded media type, byte length, digest, timestamps, producing job, and logical name/kind;
   - bounded reads and explicit missing/corrupt errors;
   - references from job results rather than embedding arbitrary blobs in events.
6. Treat terminal text/replay as unstructured session output unless an adapter submits a validated artifact. Do not scrape provider output into “structured” data.
7. Keep storage paths local and deterministic under the configured Cyberdeck state directory, injectable to temporary directories in tests. Prevent path traversal and never persist secrets or credentials in artifact metadata.
8. Add broker startup/shutdown integration tests covering restart rebuild, interrupted-job reconciliation, terminal-job preservation, pending report-back preservation, artifact round-trip, digest mismatch/corruption, and no duplicate dispatch.
9. Update architecture/operations documentation with the exact durability boundary, file layout, compatibility/version policy, and safe recovery behavior.

Likely files, after inspection:

- `src/broker/journal.ts`, `src/broker/main.ts`, `src/paths.ts`, `src/config.ts`
- new persistence/repository and artifact-store modules under `src/control-plane/` or `src/persistence/`
- A1/A2 events, job service, and result/artifact contracts where narrowly required
- `tests/broker/`, `tests/persistence/`, `tests/control-plane/`, and restart integration tests
- relevant architecture/README documentation

Do not add App Server transport, Git/worktree leases, concurrency queues, budget enforcement, automatic retries, provider adapters, or UI/CLI presentation.

## TDD and verification

Use TDD for storage and recovery. First demonstrate each failure with a focused test, then implement the minimum change. Include crash-shaped fixtures: empty store, valid replay, truncated tail, corrupt middle record, duplicate event ID, snapshot plus later events, interrupted in-flight job, repeated recovery, malicious artifact name/path, and digest mismatch. Tests must be deterministic and isolated in temporary directories.

Run:

```bash
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
git diff --check
```

Create exactly one conventional commit, expected shape:

```text
feat: persist jobs and structured artifacts
```

## Report back

Return:

- commit hash and subject;
- changed files and responsibilities;
- the on-disk layout, schema/version strategy, atomicity guarantees, and corruption behavior;
- the exact restart state mapping, especially what happens to an active PTY and in-flight job;
- how recovery represents an omitted Claude model without claiming it is safe to relaunch;
- artifact integrity and size/path safeguards;
- red/green tests and full test/check/build results;
- `git status --short` after commit;
- any Agent B handoff or A4 prerequisite, without implementing or merging peer work.
