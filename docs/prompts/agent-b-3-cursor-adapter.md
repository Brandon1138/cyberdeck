# Agent B3 — Cursor Composer interactive/headless adapter

You are the third **Agent B** implementation shot for Cyberdeck's runtimes/presentation track. Work directly and inline as one top-level Opus High session. **Do not spawn subagents, delegate work, or ask another agent to implement or review anything.**

## Repository and coordination model

- Canonical repository and primary checkout: `/Users/brandon/code/personal/cyberdeck` (reference only; do **not** work there).
- Your already-provisioned worktree is exactly `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-b-future`; work only there. It is reused for B2–B5. Agent A uses `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-a-future`. Do not create, request, switch, or repair another worktree.
- Agent A is a separate human-launched top-level peer in another worktree and owns shared contracts/control-plane work. It is not your subagent.
- Before reading or editing, verify `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, and `git worktree list --porcelain`. The current top level must equal `/Users/brandon/code/personal/cyberdeck/.claude/worktrees/agent-b-future`, not the primary checkout and not Agent A's worktree. Require the continuing Agent B branch and a clean status. The worktree is already provisioned; do not request or create another.
- Do not inspect or mutate Agent A's worktree and do not merge, cherry-pick, rebase, or integrate any branch. A human/integration session supplies the baseline.
- Do not edit A-owned shared contracts/control-plane code. Likely examples are `src/domain/**`, `src/protocol/**`, `src/broker/**`, the A1 provider/runtime contracts, and CLI routing; verify actual ownership from the integrated history.
- Your deliverable is exactly one clean conventional commit containing only Cursor adapter work.

## Mandatory prerequisite gate

B3 may begin only on the clean human-prepared post-B2 baseline with an explicit **green independent Codex A2+B2 integration-gate report**. It may run in parallel with A3; it must not require A3's unintegrated changes. Before editing:

1. Record `git status --short --branch`, `git rev-parse HEAD`, and recent history.
2. Require a clean worktree.
3. Identify the integrated prerequisite commits/features and the gate evidence.
4. Confirm the gate proved one delegation request, one child job, one bounded execution, one validated terminal result, one acknowledged report-back, and no duplicate dispatch/completion, in addition to focused tests plus full test/check/build. If the gate is absent, failed, stale relative to the current baseline, or incomplete, stop without changes. Do not self-certify or integrate it.

Read the Phase 1 plan, README, architecture/acceptance docs, B1 evidence/fixtures, A1 contracts, the Claude implementation from B2, and all current provider/runtime/tmux source and tests. Reuse contract and test patterns; do not copy Claude-specific assumptions into Cursor.

## Paid-runtime and provider-policy boundary

This is a **fixture-only, zero-model-call implementation task**.

Current-policy warning: the Phase 1 delegated-Fable guard rejects only an explicit `fable` model. An omitted Claude model can pass policy and previously selected the native Fable default. If any later integrated verification starts real Claude, it must use an operator-verified explicit ordinary non-Fable model. Never claim the current broker prevents native-default Fable; it does not. B3 must not start Claude or any other real provider.

- The recorded Cursor CLI executable is `agent`, but confirm the integrated B1 evidence rather than hard-coding from this prompt alone.
- You may use only B1-approved read-only metadata probes such as `agent --version`, `agent --help`, and documented read-only status/about commands if needed for drift confirmation.
- Never start Cursor Agent/Composer interactively, never pass a prompt, and never use real `agent --print`.
- Do not run login/logout/update/install-shell-integration, create-chat, resume, worker, or other state-changing/session-starting commands.
- **Do not start or call Fable.** Do not ask Cursor to choose Fable or any other model.
- Do not use `--auto-review`, model auto-selection, fallback, Smart Auto, `--force`, `--yolo`, automatic MCP approval, or silent trust escalation.
- Forward `--model` only when explicitly supplied through the shared contract. Never invent a native model name or infer one from Claude/Codex aliases.
- Automated tests must use B1's deterministic Cursor fixture and require no authentication or network access.

The implementation runs in dependency-safe parallel waves. B3 may run alongside A3 from the same post-Gate-1 baseline; neither consumes the other's unintegrated changes. Separately, serialize every live broker/tmux/provider scenario with cleanup and state inspection between scenarios. B3's own tests are fixture-only.

## Objective

Implement Cursor as a neutral Cyberdeck provider adapter for both the interactive Composer/Agent presentation and the documented headless mode, using A1's integrated contracts and B1's observed CLI surface.

## Required behavior

Use test-driven development: write focused failing tests, run and record the expected failure, then implement the minimum needed.

Cover only behavior grounded in current Cursor help and the shared contracts:

- Use the actual Cursor Agent executable and explicit workspace/cwd handling documented by the installed CLI.
- Interactive launch suitable for a broker-owned PTY. Cyberdeck/tmux remains presentation; Cursor must not own a tmux pane as session lifetime.
- Headless launch using only the installed CLI's documented print/output-format/streaming flags.
- Read-only mapping using documented `plan` or `ask` semantics as appropriate to the A1 sandbox contract. Do not claim `ask` and `plan` are equivalent; test the chosen mapping and document the evidence.
- Workspace-write behavior only if the installed CLI exposes a safe, non-auto-approved mapping compatible with A1. Do not use `--force`/`--yolo` to manufacture it. If no faithful mapping exists, expose an explicit unsupported capability or stop on a contract gap.
- Explicit sandbox enablement where documented; no trust bypass.
- Explicit-model forwarding only. Omission remains omission; no ranking, fallback, or recommendation.
- Structured event parsing only for Cursor's documented output format, including partial/multiple frames, malformed data, terminal result, non-zero exit, cancellation, and cleanup.
- Provider-native resume/continue behavior must remain unclaimed unless the exact contract and fixtures cover it. Do not equate a new headless process with durable conversational continuation.

Likely B3-owned files, subject to repository inspection, are a new Cursor-specific adapter module such as `src/providers/cursor.ts` or `src/providers/cursor/**`, Cursor-specific tests under `tests/providers/`, and B1 Cursor fixture extensions. Shared provider identifiers, schemas, contracts, broker registration, and CLI routing are A-owned; use the extension point already present. If adding Cursor requires editing those shared files, stop and report what the integration contract lacks.

## Explicit exclusions

- No Claude, Codex, or Antigravity behavior changes.
- No cockpit redesign or broad documentation pass.
- No workflows, provider ranking/routing, model recommendations, retries/fallback, role semantics, or worktree orchestration.
- No live Cursor session or paid inference.
- No Fable start/call.
- No A-owned shared contract/control-plane edit and no branch integration.

Do not describe undocumented dashboard APIs, IDE internals, or personal-use endpoints as supported Cursor APIs. This task is the installed Cursor Agent CLI adapter only.

## Verification

At minimum, run:

```bash
mise exec -- pnpm test -- <the focused Cursor adapter tests>
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
git diff --check
git status --short
```

Prove in tests that the real `agent` executable cannot be spawned and that forbidden flags (`--force`, `--yolo`, `--auto-review`, automatic MCP approval, or unrequested model flags) are absent.

Then create exactly one commit, suggested subject:

```text
feat: add cursor runtime adapter
```

Stage only B3-owned files. Do not amend, push, merge, or begin B4.

## Required report-back

Report:

- Starting baseline SHA, prerequisite commit/features, and the exact A2+B2 gate evidence accepted.
- Final commit SHA/subject and every changed path.
- Exact executable, interactive/headless argv/env/stdin/output mapping, sandbox mapping, and explicit unsupported modes.
- Evidence classification: CLI-metadata-observed, fixture-proven, or live-unverified.
- Focused and full verification commands with pass/fail counts.
- Confirmation that no real Cursor/Claude/Antigravity runtime, provider session, paid model, or Fable call occurred.
- Confirmation that no automatic model/fallback/Smart Auto/force behavior and no A-owned edits were added.
- Any contract or acceptance follow-up required by B5.
- Final clean `git status --short --branch`.

Stop after the one commit and report. Do not begin B4.
