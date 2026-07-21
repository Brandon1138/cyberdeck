# Agent B1 — Capability probes and deterministic adapter fixtures

You are the first of five sequential **Agent B** implementation sessions for Cyberdeck's runtimes/presentation track. Work directly and inline as one top-level Opus High session. **Do not spawn subagents, delegate work, or ask another agent to implement or review anything.**

## Repository and coordination model

- Canonical repository and primary checkout: `/Users/brandon/code/personal/cyberdeck` (reference only; do **not** work there).
- Work only in the dedicated linked Git worktree assigned to Agent B by the human operator. All five sequential B1–B5 sessions reuse that one Agent B worktree; Agent A uses a different isolated worktree.
- Agent A is a separate, human-launched top-level peer working in another worktree on shared contracts/control-plane work. Agent A is not your subagent.
- Before reading or editing, verify `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, and `git worktree list --porcelain`. The current top level must be the dedicated Agent B worktree, not the primary checkout and not Agent A's worktree. Require an Agent B track branch and a clean status. If isolation is not proven, stop without changes. Do not create, remove, switch, or repair worktrees yourself.
- Do not inspect, edit, commit in, or otherwise manipulate Agent A's worktree. Do not merge, cherry-pick, rebase, or integrate Agent A's branch. A human/integration session owns integration.
- Do not edit Agent A-owned shared contracts or control-plane code. In the current Phase 1 tree, likely A-owned areas include `src/domain/**`, `src/protocol/**`, `src/broker/**`, shared provider/runtime interfaces, and CLI command routing. Treat this list as a hypothesis: inspect the actual baseline and any ownership notes before deciding.
- Your deliverable is exactly one clean conventional commit containing only B1 work.

## Starting baseline and prerequisites

This task starts from the approved Phase 1 baseline on `main`; it does not depend on Agent A's unintegrated work. Before changing anything:

1. Record `pwd`, `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, and `git worktree list --porcelain`; confirm this is the dedicated Agent B worktree.
2. Record `git status --short --branch`, `git rev-parse HEAD`, and the recent log.
3. Require a clean worktree. If it is dirty, do not discard, overwrite, stash, or absorb someone else's changes; stop and report the exact paths.
4. Read the current `README.md`, `docs/superpowers/plans/2026-07-20-cyberdeck-setup-phase-1.md`, `docs/architecture/session-model.md`, `docs/setup/runtime-baseline.md`, and `docs/setup/phase-1-acceptance.md`.
5. Inspect the current provider/runtime/tmux implementation and tests, especially `src/providers/**`, `src/runtime/**`, `src/tmux/**`, `scripts/probe-runtimes.ts`, `tests/providers/**`, `tests/runtime/**`, `tests/tmux/**`, `tests/setup/**`, and `tests/fixtures/fake-agent.mjs`.
6. Use the pinned toolchain through `mise exec -- ...`. Do not update dependencies or runtimes.

The Phase 1 invariants remain binding: provider, model, role, sandbox, execution state, and attachment state are independent; the broker owns provider processes; tmux is presentation only; no automatic provider/model routing or fallback exists.

## Paid-runtime and safety boundary

This is a **zero-model-call** task.

Current-policy warning: the Phase 1 delegated-Fable check can reject only an explicitly supplied model string. An omitted Claude model still passes broker policy and previously caused the native Claude runtime to display Fable. Therefore, in this task and every later handoff, **any real Claude start must specify an operator-verified explicit ordinary non-Fable model**. Never claim that current broker policy prevents native-default Fable; it does not.

- Allowed probes are read-only metadata commands that cannot start a provider session, submit a prompt, alter authentication, install/update software, or mutate provider configuration. Examples include `--version`, `--help`, and a documented authentication-status command.
- Inspect help before using any less obvious subcommand. A model-list or account-status command is allowed only if the installed CLI documents it as read-only metadata and it does not start a session.
- Never pass a prompt, use Claude `--print`, Cursor `agent --print`, Antigravity `agy --print`/`--prompt`/`--prompt-interactive`, or start an interactive provider UI.
- **Do not start or call Fable under any circumstances.** Do not rely on an omitted Claude model, because the recorded native default has displayed Fable.
- Do not run login/logout/setup/update/install commands.
- Do not make automatic model selections, add fallbacks, infer a provider's behavior from another provider, or claim a capability that the installed CLI help and deterministic tests do not establish.
- Automated tests must use local fixtures only. They must make no Claude, Codex, Cursor, Antigravity, or Fable model call and require no provider authentication.

The ten planned implementation shots are five sequential Agent A sessions and five sequential Agent B sessions; they are **never ten concurrent sessions**. Within each track, the next session waits for its required integration baseline/gate. Separately, serialize every live broker/tmux/provider scenario under one operator with cleanup and state inspection between scenarios. B1 must not start any provider session at all.

## Objective

Create a small, reusable, read-only capability-probe layer plus deterministic fixtures that later B sessions can use to implement and test Claude, Cursor Composer/headless, and Antigravity/`agy` adapters without spending model usage or inventing provider behavior.

The output must distinguish three kinds of evidence:

1. **Observed now:** exact executable, installed version, help-advertised flags/modes, and read-only auth/status result where safely available.
2. **Fixture contract:** deterministic process behavior used by automated tests; this proves Cyberdeck mechanics only.
3. **Unverified runtime behavior:** anything that would require starting a session or making a model call.

## Scope

Use test-driven development: add focused failing tests first, run them and capture the expected failure, then implement the minimum needed to pass.

Implement the smallest coherent B1 slice that provides:

- Read-only capability probes for the installed `claude`, Cursor Agent executable (`agent` on the recorded baseline), and Antigravity executable (`agy` on the recorded baseline). Executable names and flags must come from current evidence, not memory.
- Probe results that are structured enough for tests and documentation, report missing executables without crashing, retain exact command provenance, and never upgrade help text into a live capability claim.
- Deterministic adapter fixtures capable of recording argv, cwd, selected environment variables, stdin, stdout/stderr, exit status, and interactive versus headless behavior needed by B2–B4.
- Deterministic provider-shaped output fixtures only where the installed CLI documents a format. Keep malformed/partial-frame cases available for parser tests. Do not fabricate undocumented fields and label synthetic data as fixture data.
- Tests proving the probe allowlist cannot invoke session-starting, prompt-taking, authentication-changing, update, or install commands.
- A concise evidence artifact under the existing setup/verification documentation structure if one is needed. It must include the capture date, exact commands, and an explicit statement that no provider or model session was started.

Likely B1-owned files, to be confirmed by repository inspection, are `scripts/probe-provider-capabilities.ts` or a narrowly extended probe module, focused tests under `tests/setup/`, fixture executables/data under `tests/fixtures/`, and possibly a B-owned capability evidence document under `docs/setup/`. Prefer extending existing patterns over creating a parallel framework. Do not change shared provider IDs, session schemas, broker RPC, policy, or CLI routing.

## Explicit exclusions

- No production Claude, Cursor, or Antigravity adapter implementation.
- No broker, protocol, domain, policy, registry, or CLI feature changes.
- No cockpit redesign.
- No provider ranking, role semantics, workflows, fallback, or automatic model selection.
- No worktree orchestration or integration work.
- No live interactive/headless acceptance and no paid inference.
- No Fable start, prompt, fallback, or capability check.

If a useful probe cannot be proven read-only, omit it and record it as unverified. If the requested fixture support would require changing an A-owned contract, stop and report the missing extension point instead of editing that contract.

## Verification

At minimum, run:

```bash
mise exec -- pnpm test -- <the focused B1 test files>
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
mise exec -- pnpm probe
git diff --check
git status --short
```

Run the new capability probe only in its explicitly read-only mode. Review its exact child-process commands before executing it. Confirm from test doubles that forbidden command shapes cannot run.

Then create exactly one commit, suggested subject:

```text
test: add provider capability probes and fixtures
```

Stage only B1-owned files. Do not amend another commit and do not push or merge.

## Required report-back

Report all of the following precisely:

- Starting baseline SHA and final commit SHA/subject.
- Every changed path and why it is B1-owned.
- Exact read-only probe commands run and their observed versions/capabilities.
- Explicit confirmation that no provider session, paid model call, authentication change, update/install, or Fable start/call occurred.
- Focused and full verification commands with pass/fail counts.
- Any capability left unverified and why.
- Any assumptions B2–B4 must preserve, including exact fixture entry points/formats.
- Final `git status --short --branch` showing the worktree is clean.

Stop after the one commit and report. Do not begin B2.
