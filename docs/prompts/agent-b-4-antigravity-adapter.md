# Agent B4 — Antigravity/agy interactive/headless adapter

You are the fourth **Agent B** implementation shot for Cyberdeck's runtimes/presentation track. Work directly and inline as one top-level session. **Do not spawn subagents, delegate work, or ask another agent to implement or review anything.**

## How to run this prompt (portable — shell/CLI or Claude Desktop)

This prompt is designed to be pasted as-is into either a shell-backed coding session or Claude Desktop. It does **not** require the session to start in a particular directory, branch, or Git worktree.

- The canonical repository is `/Users/brandon/code/personal/cyberdeck`. The intended Agent B checkout is `.claude/worktrees/agent-b-future`, but that path is an operator convenience, not an implementation precondition.
- Do not create, switch, repair, merge, or rebase worktrees/branches merely to satisfy this prompt. Use the Cyberdeck checkout or connected folder the operator supplied.
- Never stop solely because the current top-level path, branch name, Git common directory, or worktree layout differs or cannot be inspected from Desktop.
- If shell/Git access is available, record the current top level, status, SHA, and recent history. If Git metadata is unavailable, inspect the actual source/contracts/tests and state which baseline facts were source-verified versus assumed.
- Deliver one cohesive B4 change. Commit it only when the session is in a clean isolated checkout and can do so safely; otherwise make the edits in the connected folder or return one applicable patch plus verification output. Lack of commit capability is not a reason to abandon implementation.

## Repository and coordination model

- Agent A is a separate human-launched top-level peer in another worktree. It owns shared contracts/control-plane work and is not your subagent.
- Do not inspect or mutate Agent A's worktree. Do not merge, cherry-pick, rebase, or integrate branches; the human/integration session supplies the approved baseline.
- Do not edit A-owned shared contracts/control-plane code. Likely examples are `src/domain/**`, `src/protocol/**`, `src/broker/**`, A1 provider/runtime interfaces, and CLI routing. Verify actual ownership from history and notes.
- Your deliverable is exactly one cohesive Antigravity adapter slice, committed when safe or returned as one patch otherwise.

## Required baseline

The required **code baseline** is the human-integrated A3+B3 wave. The independent Codex A2+B2 gate must already be green in the available ancestry/evidence, and B4 must not require A4's unintegrated changes. B4 is intended to run in parallel with A4 from that same code baseline regardless of whether one session is in a shell and the other is in Claude Desktop.

When Git is available, record `git status --short --branch`, `git rev-parse HEAD`, recent history, the B1–B3 commits/features, relevant A commits/features, and gate evidence. In Desktop without Git metadata, verify the corresponding adapter patterns, contracts, tests, and evidence from reachable source. Do not hard-stop over placement or unavailable history. Stop only if the required code is genuinely absent/incompatible, conflicts are unresolved, the repository cannot be reached, or `agy` cannot plug in without changing A-owned contracts; report the exact mismatch.

Read the Phase 1 plan, README, architecture/acceptance docs, B1 probes/fixtures, A1 contracts, B2/B3 adapter patterns, and all current provider/runtime/tmux source/tests. Preserve provider neutrality and process ownership.

## Paid-runtime and provider-policy boundary

This is a **fixture-only, zero-model-call implementation task**.

Current-policy warning: the Phase 1 delegated-Fable guard can inspect only an explicit model string. It does not make an omitted Claude model safe; the recorded native default displayed Fable. Any later real Claude start must use an operator-verified explicit ordinary non-Fable model. Never claim current broker policy prevents native-default Fable; it does not. B4 must not start any real provider.

- The recorded Antigravity executable is `agy`; confirm it from B1's current evidence.
- Allowed real commands are B1-approved read-only metadata probes such as `agy --version` and `agy --help`. Do not use `agy --print`, `--prompt`, `--prompt-interactive`, `--continue`, `--conversation`, or any invocation that can start/resume a provider session or send a prompt.
- Do not run update/install/plugin mutation commands or alter Antigravity authentication/configuration.
- Never use `--dangerously-skip-permissions`.
- **Do not start or call Fable under any circumstances.** Do not select a Fable model through Antigravity.
- Do not choose a model or agent automatically. Forward model/agent identifiers only if explicitly supplied by the shared contract and actually supported; otherwise omit them or report the contract mismatch.
- Do not add provider fallback, model aliases, inferred model pools, or behavior copied from Claude/Cursor.
- Tests must use B1's deterministic `agy` fixture with no authentication, network, provider process, or paid inference.

The implementation runs in dependency-safe parallel waves. B4 may run alongside A4 from the same integrated A3+B3 baseline; neither consumes the other's unintegrated changes. Separately, serialize every live broker/tmux/provider scenario with cleanup and state inspection between scenarios. B4's tests remain fixture-only.

## Objective

Implement a neutral Antigravity adapter around the installed `agy` CLI for its documented interactive and headless modes, faithfully represented through A1's contracts. If `agy` lacks a structured streaming format required by the contract, represent that limitation honestly; do not invent JSON events.

## Required behavior

Use test-driven development: add focused failing tests first, run and record the expected failure, then implement the minimum production code.

Cover only observed/documented behavior:

- Interactive launch using the documented `agy` invocation, cwd/workspace behavior, and broker-owned PTY.
- Headless launch using the documented print/prompt form only through fixtures. If the shared contract separates one-shot headless execution from durable sessions, honor that distinction.
- Read-only sandbox mapping to documented `plan` mode plus terminal sandboxing where appropriate. Workspace-write may map to documented `accept-edits` only if that precisely matches A1's semantics; never bypass permissions.
- Explicit `--model` and `--agent` forwarding only when explicitly requested and contractually represented. Never infer either value from provider, role, or runtime mode.
- Correct prompt/stdin handling based on actual `agy` help and fixture evidence. Do not assume Claude/Cursor stream-json support.
- Plain-text or structured result decoding exactly as documented, including stderr, non-zero exit, timeout/cancellation, and cleanup.
- Capability reporting that marks unsupported structured streaming, resume, or durable headless conversation behavior as unsupported/unverified rather than emulated silently.
- No tmux-owned provider process; cockpit/pane closure must remain presentation detach only for interactive sessions.

Likely B4-owned files, subject to inspection, are a new module such as `src/providers/antigravity.ts` or `src/providers/agy/**`, Antigravity-specific tests under `tests/providers/`, and B1 `agy` fixture extensions. Shared provider IDs/contracts, broker registration, domain/protocol schemas, and CLI routing are A-owned. Use the integrated extension point; do not edit shared code to force registration.

## Explicit exclusions

- No Claude, Codex, or Cursor behavior changes.
- No undocumented Google/Antigravity API, OAuth, credential, quota, or endpoint integration.
- No cockpit redesign or broad docs/acceptance pass.
- No automatic routing, fallback, retries, model pool logic, rankings, roles, workflows, or worktree orchestration.
- No live Antigravity session or paid inference.
- No Fable start/call.
- No A-owned contract/control-plane edit and no branch integration.

## Verification

At minimum, run:

```bash
mise exec -- pnpm test -- <the focused Antigravity adapter tests>
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
git diff --check
git status --short
```

Prove tests cannot spawn the real `agy` executable and explicitly reject dangerous permission bypass, implicit model/agent selection, and fabricated structured-event assumptions.

If committing is safe in the current checkout, create exactly one commit, suggested subject:

```text
feat: add antigravity runtime adapter
```

Stage only B4-owned files. Otherwise deliver the same cohesive change as one patch/diff and identify verification that could not run on the current surface. Do not amend, push, merge, or begin B5.

## Required report-back

Report:

- Starting baseline SHA and exact integrated prerequisite commits/features.
- Final commit SHA/subject when committed, or a clear patch-delivery note, plus every changed path.
- Exact interactive/headless argv/env/input/output mapping and sandbox mapping.
- Every unsupported or live-unverified `agy` capability, especially structured streaming and continuation.
- Evidence classification: read-only CLI metadata, deterministic fixture, or unverified live behavior.
- Focused/full verification commands and pass/fail counts.
- Confirmation that no real provider session, network-dependent model call, authentication/config change, dangerous bypass, automatic model/agent choice, or Fable start/call occurred.
- Confirmation that no A-owned files or other adapters changed.
- Any integration/acceptance risk B5 must surface.
- Final `git status --short --branch` when Git is available.

Stop after the one commit and report. Do not begin B5.
