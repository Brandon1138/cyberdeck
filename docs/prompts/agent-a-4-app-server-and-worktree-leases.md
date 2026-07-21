# Agent A4 — Codex App Server and repository/worktree leases

You are the fourth **Agent A** implementation shot. Work directly and inline as one top-level session. **Do not spawn subagents, delegate implementation/review, or use Fable.**

## How to run this prompt (portable — shell/CLI or Claude Desktop)

This prompt is designed to be pasted as-is into either a shell-backed coding session or Claude Desktop. It does **not** require the session to start in a particular directory, branch, or Git worktree.

- The canonical repository is `/Users/brandon/code/personal/cyberdeck`. The intended Agent A checkout is `.claude/worktrees/agent-a-future`, but that path is an operator convenience, not an implementation precondition.
- Do not create, switch, repair, merge, or rebase worktrees/branches merely to satisfy this prompt. Use the Cyberdeck checkout or connected folder the operator supplied.
- Never stop solely because the current top-level path, branch name, Git common directory, or worktree layout differs or cannot be inspected from Desktop.
- If shell/Git access is available, record the current top level, status, SHA, and recent history. If Git metadata is unavailable, inspect the actual source/contracts/tests and state which baseline facts were source-verified versus assumed.
- Deliver one cohesive A4 change. Commit it only when the session is in a clean isolated checkout and can do so safely; otherwise make the edits in the connected folder or return one applicable patch plus verification output. Lack of commit capability is not a reason to abandon implementation.

## Operating rules

- Agent B is a separate human-launched top-level peer in another worktree. Do not contact it, manage it, merge/cherry-pick its commits, or edit B-owned adapter/presentation code.
- Continue to treat `src/providers/**`, `src/client/**`, `src/tmux/**`, dashboard/cockpit, and provider-facing CLI UX as B-owned unless the committed ownership map says otherwise. The App Server work in this session is the control-plane transport/runtime integration, not a rewrite of B's terminal provider adapters or presentation.
- Preserve neutral provider/model/role policy. App Server support is an explicitly selected Codex execution transport, not a preferred provider, automatic route, fallback, or role mapping.
- Never invoke Fable. Automated tests use a fake App Server process and fake Git repositories; no model calls.
- Current explicit-string rejection does not prevent an omitted Claude model from resolving to native-default Fable; that happened in Phase 1. Never claim otherwise. Any live Claude start is forbidden without a human-supplied, independently operator-verified explicit ordinary non-Fable model. This Codex App Server session must not use Claude as a fallback.
- The implementation runs in dependency-safe parallel waves. A4 may run alongside B4 only from the human-integrated A3+B3 baseline.
- Serialize every live broker/App Server/provider/tmux check under one human operator. Do not overlap checks across worktrees; verify the broker PID, socket, App Server child, and tmux panes are clean before the next scenario.
- Any worktree behavior implemented in this shot must operate only through tested product abstractions and fixtures; prompt placement never authorizes manipulating the operator's implementation worktrees.
- Do not push, merge, rebase, or amend earlier commits.

## Baseline and prerequisites

The required **code baseline** is the human-integrated A3+B3 wave with the passed post-A2+B2 Codex gate evidence. Persistence/recovery and artifact storage must already exist and pass their restart tests. Verify this from Git ancestry when available; in Desktop, verify the corresponding source, contracts, tests, and recorded gate evidence. Do not hard-stop over checkout placement or unavailable Git metadata. Stop only for a real prerequisite failure: the required A3/B3 code is absent/incompatible, conflicts are unresolved, the repository cannot be reached, or A4 cannot proceed without crossing the committed ownership boundary. Report the exact mismatch.

Read the executable plan, App Server-related contracts/ports, job service, persistence/recovery, artifact store, current Codex terminal adapter only for boundary context, and relevant tests. Before coding against Codex App Server, inspect the **currently installed** Codex CLI's read-only help/protocol capabilities and any repository-pinned official protocol/schema material. Do not rely on remembered flags or launch a model. If the installed App Server protocol cannot be established safely, stop and report exact evidence rather than guessing.

## Objective

Add a supervised Codex App Server transport behind the neutral job runtime port and implement exclusive, durable repository/worktree leases so writable jobs cannot collide. Keep Phase 1 terminal sessions intact.

## Required scope

### Codex App Server control-plane integration

1. Implement a transport client/supervisor for the installed Codex App Server protocol with explicit process ownership, initialize/handshake, request correlation, notifications, cancellation, timeouts, bounded buffering, stderr capture, protocol validation, and clean shutdown.
2. Put the transport behind the runtime/adapter port established by A2. Jobs still require `provider: codex`; selecting App Server must be explicit in the execution request/configuration and must not affect Claude or terminal-session behavior.
   An App Server failure must never fall back to Claude, especially not to an omitted/native-default model.
3. Translate App Server lifecycle/output into existing structured job progress, result, usage-when-reported, and artifact contracts. Preserve unknown usage as unknown. Do not interpret model text as trusted control messages.
4. Handle disconnect/restart honestly with A3 persistence: mark unverified in-flight work interrupted/reconciliation-needed; never double-submit automatically; retain correlation IDs and diagnostic evidence.
5. Validate cwd, sandbox, model, and approval/permission settings explicitly. Do not broaden permissions or bypass App Server approvals to make tests pass.
6. Use a deterministic fake JSON-RPC/App Server fixture for all automated tests. No real Codex model call is required in this implementation session.

### Repository and worktree leases

7. Implement a durable lease manager based on A1 contracts. Canonicalize repository/worktree paths (including symlinks) and key leases so equivalent paths cannot obtain conflicting writable ownership.
8. At minimum support acquire, renew/heartbeat, validate/fence, release, expiry, startup recovery, and owner/job lookup. Lease acquisition and persisted job admission must be ordered atomically enough to prevent two writers from both believing they own the same target.
9. Use fencing tokens or an equivalent monotonically safe mechanism so an expired owner cannot continue mutating after a new owner acquires the lease.
10. Read-only jobs may share only if the committed plan/contracts allow it; workspace-write jobs must be exclusive. Never infer writability from provider/model/role.
11. If this session creates/removes Git worktrees, do so only through a narrow injected repository service with validated repo root, explicit branch/base, deterministic Cyberdeck-owned location, collision checks, and recoverable cleanup. Never delete an unverified directory or a worktree with user changes. A lease implementation may manage an existing supplied worktree without creating a new one if that is the narrower plan.
12. Persist lease events/state and reconcile them after restart. Orphan cleanup must fail closed and produce a report; it must not run destructive Git cleanup automatically.
13. Add integration tests for concurrent acquisition, canonical-path aliasing, expiry/fencing, restart recovery, App Server crash/cancel/timeout, and a fake App Server job that holds and releases a write lease exactly once.
14. Document the App Server protocol/version assumption, supervision boundary, lease key, fencing semantics, and manual orphan-remediation procedure.

Likely files, subject to inspection:

- new `src/app-server/**` transport/supervisor and fake fixture tests
- new lease/repository service modules under `src/control-plane/**` or `src/repositories/**`
- A2 runtime port and A3 persistence wiring
- `src/domain/events.ts`, `src/config.ts`, `src/paths.ts`, `src/broker/main.ts` where required
- integration tests and architecture/operations docs

Do not implement or redesign B-owned terminal adapters/CLI/UI, automatic provider selection, generic workflow routing, semantic memory, final scheduler budgets, or destructive orphan cleanup.

## TDD and verification

Use TDD. Start with failing protocol and lease tests, observe the failures, then implement minimal behavior. Protocol tests must cover handshake/version mismatch, out-of-order responses, notifications, malformed frames, cancellation, timeout, EOF, and duplicate terminal notification. Lease tests must cover path aliases, two writer races, heartbeat, expiry, fencing, stale release, restart, dirty worktree refusal, and idempotent release.

Run:

```bash
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
git diff --check
```

If committing is safe in the current checkout, create exactly one conventional commit, expected shape:

```text
feat: add app server and worktree leases
```

Otherwise deliver the same cohesive change as one patch/diff; report verification as pending where the current surface cannot execute it.

## Report back

Return:

- commit hash and subject, or a clear patch-delivery note when the current surface cannot commit safely;
- changed files and their App Server/lease responsibilities;
- observed installed App Server command/protocol/version evidence and the compatibility behavior implemented;
- process supervision, cancellation, disconnect, and duplicate-submission guarantees;
- confirmation that App Server failure cannot route to Claude and that omitted-model Claude safety was not overstated;
- lease canonical key, exclusivity, expiry, fencing, persistence, and orphan behavior;
- tests run with red/green evidence and full test/check/build results;
- `git status --short` after commit when Git is available;
- exact prerequisites and open handoffs for A5 or Agent B, with no peer merge performed.
