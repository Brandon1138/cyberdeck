# Agent B5 — Cockpit UX, provider acceptance, and documentation

You are the fifth and final **Agent B** implementation shot for Cyberdeck's runtimes/presentation track. Work directly and inline as one top-level session. **Do not spawn subagents, delegate work, or ask another agent to implement or review anything.**

## How to run this prompt (portable — shell/CLI or Claude Desktop)

This prompt is designed to be pasted as-is into either a shell-backed coding session or Claude Desktop. It does **not** require the session to start in a particular directory, branch, or Git worktree.

- The canonical repository is `/Users/brandon/code/personal/cyberdeck`. The intended Agent B checkout is `.claude/worktrees/agent-b-future`, but that path is an operator convenience, not an implementation precondition.
- Do not create, switch, repair, merge, or rebase worktrees/branches merely to satisfy this prompt. Use the Cyberdeck checkout or connected folder the operator supplied.
- Never stop solely because the current top-level path, branch name, Git common directory, or worktree layout differs or cannot be inspected from Desktop.
- If shell/Git access is available, record the current top level, status, SHA, and recent history. If Git metadata is unavailable, inspect the actual source/contracts/tests and state which baseline facts were source-verified versus assumed.
- Deliver one cohesive B5 change. Commit it only when the session is in a clean isolated checkout and can do so safely; otherwise make the edits in the connected folder or return one applicable patch plus verification output. Lack of commit capability is not a reason to abandon implementation.

## Repository and coordination model

- Agent A is a separate human-launched top-level peer in another worktree. It owns shared contracts/control-plane code and is not your subagent.
- Do not inspect or mutate Agent A's worktree. Do not merge, cherry-pick, rebase, or integrate any branch. A human/integration session must supply the complete approved baseline.
- Do not edit A-owned shared contracts/control-plane code. Likely examples are `src/domain/**`, `src/protocol/**`, `src/broker/**`, shared runtime/provider interfaces, and CLI routing. Confirm ownership from the integrated history.
- B5 may edit B-owned presentation code and user-facing docs, but must use existing A-track extension points. If UX requires a shared contract change, stop and report it rather than crossing ownership.
- Your deliverable is exactly one cohesive B5 cockpit, acceptance, and documentation change, committed when safe or returned as one patch otherwise.

## Required integrated baseline

The required **code baseline** contains:

- B1 capability probes/fixtures;
- B2 Claude adapter;
- B3 Cursor adapter;
- B4 Antigravity/`agy` adapter;
- the approved Agent A sequence through A5; and
- a green independent Codex A2+B2 integration-gate report that applies to the current ancestry.

This must be the operator-integrated A5 baseline; B5 is intentionally sequential after A5, not parallel with it. On canonical history, A5 is `718767955e2a56c1c314c13d6ac406b39e19370a` and the Phase 2/3 plan contains `A5 integration evidence — PASS (2026-07-21)`. When Git is available, record `git status --short --branch`, `git rev-parse HEAD`, recent history, all relevant A/B commit SHAs/features, and the earlier gate evidence. In Desktop without Git metadata, verify the corresponding source, contracts, tests, and recorded evidence from the connected folder. Do not hard-stop over checkout placement, branch naming, worktree layout, a longer equivalent SHA, or unavailable history. Stop only if required A1–A5/B1–B4 code is genuinely absent/incompatible, conflicts are unresolved, the repository cannot be reached, or B5 cannot proceed without changing an A-owned contract. Report the exact mismatch.

Read the current Phase 1 plan, README, session architecture, runtime baseline and acceptance docs, all A-track contract/control-plane docs, B1 evidence, B2–B4 adapter reports/code/tests, and current provider/runtime/tmux/dashboard/CLI source/tests. Inspect actual behavior before deciding the UI; file ownership listed below is a hypothesis.

## Provider, model, and paid-runtime policy

- Cyberdeck remains neutral: no provider ranking, recommendation, routing, fallback, role-to-provider mapping, role-to-model mapping, or automatic model selection.
- Interactive/headless is a runtime/presentation distinction, not a provider category. tmux is presentation only; pane closure must never be represented as process termination.
- Current-policy warning: the Phase 1 delegated-Fable guard rejects only an explicitly supplied `fable` model. It cannot make an omitted Claude model safe, and the recorded omitted-model native default displayed Fable. **Do not start or call Fable under any circumstances. Any real Claude start must include an operator-verified explicit ordinary non-Fable model.** Never claim current broker policy prevents native-default Fable; it does not. Never test top-level Fable allowance in this task.
- Mandatory automated acceptance uses deterministic B1 fixtures only and must make zero real provider/model calls.
- Read-only metadata probes (`--version`, `--help`, documented status commands) are allowed and must be recorded exactly.
- A real ordinary-model acceptance prompt is allowed only if the user has explicitly authorized paid-runtime calls for this B5 session. Approval must identify the provider/model scope; absence of an objection is not approval. Use an explicitly named ordinary non-Fable model, `read-only`/plan permissions, a harmless prompt, and the smallest number of calls needed. Never use automatic fallback.
- If paid calls are not explicitly authorized, do not ask a real provider a prompt. Complete deterministic and operational acceptance, mark conversational checks `NOT RUN — explicit paid-runtime authorization absent`, and do not overclaim them.
- Never run auth/login/logout/update/install commands, dangerous permission bypass, Cursor force/yolo/Smart Auto, or Antigravity permission bypass.

B5 begins only after A5 is integrated/applied into the checkout or connected folder supplied by the operator; no particular worktree path is required. All live broker, tmux, and provider scenarios must also be serialized: start one scenario, capture evidence, clean it up, and verify state before the next. Do not reuse a session when the scenario requires isolation.

## Objective

Polish the cockpit/dashboard so the integrated provider/runtime capabilities are legible without implying recommendations, then execute an honest provider acceptance pass and update durable documentation to describe exactly what is implemented, fixture-proven, operationally observed, live-proven, unsupported, or not run.

## Cockpit and dashboard scope

Use test-driven development for behavioral changes: add focused failing tests first, run and record the expected failure, then implement the minimum change.

The cockpit/dashboard should, using existing contracts only:

- Display provider identity, explicit model or a neutral `native-default`/unset label, opaque role or unassigned label, interactive/headless runtime mode, execution state, attachment state, and cwd when those fields exist.
- Represent capability/unsupported states honestly for Claude, Cursor, and Antigravity without ranks, badges implying quality, default recommendations, or automatic choices.
- Preserve one controller/multiple watcher semantics.
- Preserve broker ownership and tmux presentation-only behavior. Creating, reusing, closing, or killing a cockpit pane must not directly launch or kill provider executables.
- Render predictably in a normal terminal and remain testable with mocked tmux/process calls. Avoid provider-specific ANSI parsing in shared UI.
- Avoid adding new CLI/control-plane options. If a required datum is absent from the A5 contract, surface the gap in the report instead of editing A-owned code.

Likely B5-owned files, subject to inspection, are `src/client/dashboard.ts`, `src/tmux/cockpit.ts`, `tests/tmux/cockpit.test.ts`, focused dashboard tests, `README.md`, `docs/architecture/session-model.md`, `docs/setup/runtime-baseline.md`, and a new or updated integrated acceptance document under `docs/setup/`. `src/cli.ts` and shared schemas/protocol/broker code are presumed A-owned unless the integration history explicitly says otherwise.

## Acceptance requirements

First run deterministic acceptance for every registered provider/mode through fixtures and real Cyberdeck control paths where possible:

- command construction and exact explicit-model forwarding;
- read-only permission/sandbox mapping;
- interactive attach, detach, reattach, replay, watcher/controller behavior, and explicit stop;
- headless input/result/error/cancellation behavior supported by each adapter;
- malformed/partial output handling;
- pane closure detaches presentation without killing broker-owned interactive sessions;
- no fixture invocation contains Fable, automatic model/fallback flags, dangerous bypasses, or real provider executable resolution.

Then perform operational read-only inspection: build the CLI, start the broker if necessary, render/capture the cockpit/dashboard with fake or no provider sessions, inspect tmux pane metadata, and cleanly stop temporary processes. Do not leave broker, fixture, socket, or tmux state behind. Do not kill a pre-existing user-owned broker or tmux session; detect and stop if ownership is ambiguous.

Only with explicit paid-runtime authorization may you add the smallest live ordinary-model checks. Keep provider observations separate: a Claude result does not prove Cursor or Antigravity behavior, and process launch does not prove conversation continuation. Record exact command, explicit model, sandbox, timestamp, session ID/PID only as appropriate, outcome, cleanup, and approximate call count. A failed auth/status check is not permission to change auth.

## Documentation requirements

Update docs so a new operator can understand:

- supported providers and installed executable names;
- interactive versus headless behavior and whether headless is durable or one-shot per provider;
- exact explicit-provider and explicit-model examples that cannot accidentally invoke Fable;
- read-only versus workspace-write mappings and unsupported modes;
- broker versus tmux ownership, attach/watch/detach/stop semantics;
- capability evidence categories and the date/version sensitivity of live observations;
- the zero-call deterministic test/probe workflow;
- the Fable prohibition for automated/acceptance work and the absence of automatic model selection/fallback;
- current limitations without turning desired behavior into verified claims.

Do not rewrite the historical Phase 1 plan as though later work was part of Phase 1. Preserve historical evidence and add a clearly dated integrated acceptance section/document.

## Explicit exclusions

- No shared contract, domain, protocol, broker, registry, policy, or CLI routing changes.
- No new provider adapter behavior except a narrowly necessary B-owned presentation fix proven by tests; adapter defects should be reported back to their owning B session/integration coordinator.
- No workflows, queues, routing, rankings, recommendations, fallback, role semantics, worktree orchestration, semantic memory, or provider API/OAuth/quota work.
- No branch integration, push, PR, or merge.
- No Fable start/call, including a top-level allowance test.
- No paid runtime call without explicit authorization.

## Verification and final A5+B5 gate

At minimum, run:

```bash
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm test -- <the focused dashboard/tmux/acceptance tests>
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
mise exec -- pnpm probe
git diff --check
git status --short
```

Run any new provider-capability probe only in its allowlisted read-only mode. Verify temporary broker/tmux/socket/process cleanup with exact read-only inspection commands.

If committing is safe in the current checkout, create exactly one commit, suggested subject:

```text
feat: complete provider cockpit acceptance
```

Stage only B5-owned presentation/docs/tests. Otherwise deliver the same cohesive change as one patch/diff and identify verification that could not run on the current surface. Do not amend, push, or merge.

After B5 finishes, **stop for the mandatory final independent Codex gate over the integrated A5+B5 baseline**. Do not declare the overall phase complete and do not bypass the gate. The human operator launches a new top-level Codex integration session, supplies the approved A5+B5 changes regardless of their original worktree placement, and has it perform runtime-environment testing plus any narrowly required integration repair/polish before it verifies:

1. inspect A/B ownership and contract conformance;
2. run focused provider, runtime, broker/control-plane, tmux/dashboard, and acceptance tests;
3. run full install/test/check/build/probe;
4. verify fixture isolation and absence of real-provider/Fable calls in automated paths;
5. inspect docs against actual command behavior;
6. report any live checks not run due to missing paid-runtime authorization;
7. verify Phase 1 session behavior, structured delegation/report-back, persistence/recovery honesty, artifact validation, explicit App Server transport without duplicate dispatch/fallback, writable worktree lease fencing, and exact-once concurrency/budget reconciliation; and
8. confirm a clean integrated worktree and no leaked processes/sockets/App Server children/tmux sessions.

Only that independent green gate may authorize the integration coordinator to call the combined A/B work complete.

## Required report-back

Report:

- Starting baseline SHA and every integrated A1–A5/B1–B4 prerequisite commit/feature you verified.
- Final B5 commit SHA/subject when committed, or a clear patch-delivery note, plus every changed path.
- Cockpit/dashboard behavior added and the exact contract data used.
- A provider-by-mode acceptance matrix with separate columns for metadata-observed, fixture-proven, operationally observed, live-proven, unsupported, and not run.
- Exact probe, test, check, build, cockpit/tmux, cleanup, and any authorized live commands plus results/counts.
- Explicit confirmation of whether paid calls were authorized and made; name the explicit ordinary models if so.
- Explicit confirmation that no Fable start/call, automatic model selection/fallback, auth/config change, dangerous bypass, or A-owned edit occurred.
- Remaining limitations and any adapter/contract issue the final verifier must examine.
- Final `git status --short --branch` when Git is available, plus cleanup evidence.
- A clear handoff line: `READY FOR FINAL CODEX A5+B5 INTEGRATION GATE` or a concrete blocker.

Stop after the one cohesive change and report. Do not perform final integration or begin another implementation phase.
