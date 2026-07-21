# Agent B2 — Structured Claude interactive/headless adapter

You are the second **Agent B** implementation shot for Cyberdeck's runtimes/presentation track. Work directly and inline as one top-level Opus High session. **Do not spawn subagents, delegate work, or ask another agent to implement or review anything.**

## Repository and coordination model

- Canonical repository and primary checkout: `/Users/brandon/code/personal/cyberdeck` (reference only; do **not** work there).
- Your already-provisioned worktree is exactly `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-b-future`; work only there. It is reused for B2–B5. Agent A uses `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-a-future`. Do not create, request, switch, or repair another worktree.
- Agent A is a separate, human-launched top-level peer in another worktree. It owns shared contracts/control-plane work and is not your subagent.
- Before reading or editing, verify `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, and `git worktree list --porcelain`. The current top level must equal `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-b-future`, not the primary checkout and not Agent A's worktree. Require the continuing Agent B branch and a clean status. The worktree is already provisioned; do not request or create another.
- Do not inspect or mutate Agent A's worktree. Do not merge, cherry-pick, rebase, or integrate Agent A's branch. The human/integration session must provide an already integrated baseline.
- Do not edit A-owned shared contracts or control-plane code. Likely examples are `src/domain/**`, `src/protocol/**`, `src/broker/**`, shared runtime/provider interfaces introduced by A1, and CLI routing. This is a hypothesis; inspect actual ownership notes and history before editing.
- Your deliverable is exactly one clean conventional commit containing only the Claude adapter slice.

## Required integration baseline

Do not start implementation until the current worktree cleanly contains the reconciled A1+B1+A2 baseline, including all of:

1. B1's read-only capability probes and deterministic adapter fixtures; and
2. A1's integrated runtime/provider contracts and extension points for interactive and headless/structured execution; and
3. A2's durable job control plane, concrete provider registry, typed `job.*` broker methods, and unchanged A1 `JobDispatchAdapter` port consumption.

Before changing anything, record `git status --short --branch`, `git rev-parse HEAD`, and recent history. Require a clean worktree. Identify the exact A1, B1, and A2 commits/features in the current ancestry and report them later. Do not integrate missing work yourself. If the reconciled baseline is absent, ambiguous, or insufficient to implement Claude without changing A-owned code, stop with a concrete contract gap and no edits.

Read the current Phase 1 plan, README, architecture and acceptance documents, B1 capability evidence, the A1 contracts, and all provider/runtime/tmux source and tests. Preserve the Phase 1 ownership rule: broker/runtime owns processes; interactive/headless is an execution/presentation dimension, not a provider classification.

## Paid-runtime and provider-policy boundary

This is a **fixture-only, zero-model-call implementation task**.

Current-policy warning: the Phase 1 delegated-Fable guard sees only explicit model strings. It does not protect a Claude start whose model is omitted, and the recorded omitted-model native default displayed Fable. **Any real Claude start in later acceptance must use an operator-verified explicit ordinary non-Fable model.** Never claim that current broker policy blocks native-default Fable; it does not. This task itself must not start real Claude at all.

- Use B1's deterministic Claude fixture for all executable behavior. You may rerun read-only `claude --version`, `claude --help`, and `claude auth status` only if needed to confirm drift.
- Never start an interactive Claude UI and never use `claude --print`, stream input, or any prompt against the real Claude executable.
- **Do not start or call Fable under any circumstances.** Do not test an omitted real Claude model: the recorded native default displayed Fable.
- Do not add `--fallback-model`, choose a model automatically, map roles to models, or silently replace a requested model.
- A model argument may be forwarded only when the caller explicitly supplied it through the A1 contract. Omission must remain omission in command construction; it is not permission for Cyberdeck to choose.
- Preserve `DISABLE_UPDATES=1`. Do not run auth/update/install/setup commands.
- Do not invent Claude flags, stream event types, exit semantics, resume behavior, or permission mappings. Use the installed help captured by B1 and the actual A1 contract. Unsupported behavior must fail closed or remain explicitly unsupported.

The implementation runs in dependency-safe parallel waves. This recovered run starts B2 from the reconciled A1+B1+A2 baseline; A3 and B3 remain blocked until B2 is integrated and Codex Gate 1 passes. Separately, serialize every live broker/tmux/provider scenario with cleanup and state inspection between scenarios. B2's tests remain fixture-only.

## Objective

Implement the production Claude adapter behind A1's contracts for both:

- the durable interactive PTY path; and
- the structured headless path exposed by the installed Claude CLI.

The adapter must present one neutral Cyberdeck provider implementation without making provider/model recommendations. Preserve the existing interactive behavior unless A1 deliberately changed its contract.

For bounded jobs, implement A1's unchanged `JobDispatchAdapter` exactly: `dispatch` acknowledges one
accepted job, `cancel` reports accepted/refused cancellation, and `onReport` emits validated terminal
`JobReport` values (including optional usage only when actually reported). Export the adapter so the
integration gate can register it through A2's `registerAdapter(adapter)` seam; do not edit A-owned
broker composition to force registration.

## Required behavior

Use test-driven development: write focused failing tests first, run them and record the expected failure, then add the minimum production code.

Cover, as supported by the integrated contract and observed CLI help:

- Interactive launch through `claude` with the existing session UUID/name behavior, cwd, and explicit sandbox-to-Claude permission mapping.
- Headless structured launch using only the exact `--print`, input-format, output-format, and streaming flags established by B1 evidence. Do not assume that a flag is valid merely because another provider supports it.
- Deterministic stdin encoding and stdout/stderr decoding through the A1 structured event contract, including partial chunks, multiple frames per chunk, malformed data, terminal result, non-zero exit, cancellation, and process cleanup.
- Explicit distinction between provider-native session persistence/resume and Cyberdeck process lifetime. Do not claim resume/continuation unless the contract and fixture prove the exact mechanics.
- Explicit model forwarding only; no default, recommendation, fallback, or role interpretation.
- Call `evaluateClaudeLaunchSafety(provider, model)` immediately before every real Claude process
  spawn, including both the existing interactive path and new bounded/headless path. An omitted or
  Fable model must fail before process construction; fixture injection must remain testable without
  resolving the real executable.
- `DISABLE_UPDATES=1` on every Claude process.
- Read-only and workspace-write permission mappings grounded in current Claude help and existing Phase 1 behavior. Never use bypass/dangerous permission flags.
- No raw provider-specific event leakage across A1's neutral boundary unless A1 intentionally provides an opaque metadata field.

Likely B2-owned files, subject to inspection, are `src/providers/claude.ts`, narrowly scoped Claude codec/adapter modules under `src/providers/claude/`, and Claude-specific tests under `tests/providers/` using B1 fixtures. The shared provider/runtime contract itself is A1-owned. Registration/composition may also be A-owned; use its extension point if present. Do not modify shared schemas, protocol frames, broker routing, policy, registry, or CLI to make the adapter fit.

## Explicit exclusions

- No Codex, Cursor, or Antigravity adapter work.
- No cockpit or docs redesign beyond a narrowly necessary Claude adapter note.
- No workflows, retries, provider fallback, rankings, role semantics, queues, or worktree orchestration.
- No live Claude conversation, acceptance prompt, or paid inference.
- No Fable start/call and no top-level/delegated Fable experiment.
- No edits to A-owned contracts/control-plane files and no integration/merge work.

If the installed Claude CLI cannot satisfy part of A1's structured contract, implement an honest capability rejection if the contract supports it; otherwise stop and report the precise mismatch. Do not fabricate provider behavior.

## Verification and the A2+B2 gate

At minimum, run:

```bash
mise exec -- pnpm test -- <the focused Claude adapter tests>
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
git diff --check
git status --short
```

Confirm tests use B1 fixtures and cannot resolve or spawn the real Claude executable.

Then create exactly one commit, suggested subject:

```text
feat: add structured claude runtime adapter
```

Stage only B2-owned files. Do not amend, push, or merge.

After this commit, **stop for the mandatory Codex integration verification gate covering A2+B2**. You do not perform or bypass that gate in this worktree. The human/integration session must combine the approved A2 and B2 commits on a fresh integration baseline, then launch a separate top-level Codex verification session. Using fakes first, that gate must prove end to end: one structured delegation request, one child job, one bounded adapter execution, one validated terminal result, one acknowledged report-back, no duplicate dispatch/completion, and no ownership or neutrality regression. It must run focused tests plus full test/check/build and verify fixture isolation with no Fable or paid provider call. A live ordinary-model check is optional only with explicit operator authorization and, for Claude, an operator-verified explicit ordinary non-Fable model. B3 and A3 must not begin until that gate is explicitly reported green.

## Required report-back

Report:

- Starting baseline SHA plus the exact integrated A1, B1, and A2 prerequisite commits/features.
- Final commit SHA/subject and every changed path.
- Exact interactive argv/env and headless argv/env/stdin/output mapping implemented.
- Which behaviors are observed from CLI metadata, which are fixture-proven, and which remain unverified live.
- Focused and full verification commands with pass/fail counts.
- Confirmation that the real Claude runtime was not started, no paid/Fable call occurred, and no automatic model/fallback behavior was added.
- Confirmation that no A-owned file or other provider adapter was changed.
- Any contract gap or follow-up the A2+B2 verifier must examine.
- Final clean `git status --short --branch`.
- A clear handoff line: `READY FOR CODEX A2+B2 INTEGRATION GATE` or a concrete blocker.

Stop after the one commit and report. Do not begin B3.
