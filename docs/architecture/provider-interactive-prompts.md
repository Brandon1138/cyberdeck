# Provider interactive prompts: inventory and disposition

A worker parked on a provider's interactive prompt is invisible to autonomy: the truth engine says
`blocked-modal`, no turn runs, no instruction is delivered, and — before this work — the only
resolution was the operator walking to the pane. The MIK-141 incident is the canonical case: a
Cursor worker sat behind "Workspace Trust Required" until a human pressed `a`.

This document is the acceptance-item inventory: every known prompt surface per provider, what
triggers it, and its disposition. Three dispositions exist:

- **avoid** — Cyberdeck prevents the prompt from ever appearing, by registering the exact worktree
  in the provider's own trust store before the worker spawns. Gated on the operator's
  `cyberdeck modal-answers on --root <repo>` grant; without the grant nothing is written and the
  prompt surfaces exactly as before.
- **answer** — the prompt is recognized into a structured descriptor
  (`src/domain/modal-descriptor.ts`) carried on worker truth, and an orchestrator holding the lease
  may press one *enumerated* answer through `worker_ctl answer_modal`, policy- and
  fingerprint-checked, journaled per press. Free text never reaches the PTY.
- **operator-only** — surfaced to the operator exactly as today. Login prompts and anything
  unrecognized are permanently here; per-action permission approvals are here *by policy* (they are
  recognized and described, but `ANSWERABLE_MODAL_KINDS` excludes them — answering them wholesale
  would be `--dangerously-skip-permissions` with extra steps).

The mechanism's guarantees, independent of provider:

- Detection: `blockedPromptIndexInTail` (`src/domain/terminal-replay.ts`) decides *that* a modal
  blocks; `describeBlockedModal` decides *which*, over the same stripped tail, and always answers —
  an unmatched dialog is `kind: "unknown"` with an empty answer set, unanswerable by construction.
- The descriptor rides `WorkerTruth.modal` (only in `blocked-modal`), so `threads_list`,
  `worker_events`, and `workers_wait` all describe the same dialog identically.
- `fingerprint` is a hash of (provider, kind, normalized dialog text): stable across redraws,
  different for a different dialog. The broker re-derives it at press time; a stale answer returns
  `MODAL_MISMATCH` with the current descriptor instead of landing on the wrong question.
- Key bytes come only from the static table in `modal-descriptor.ts`, keyed
  (provider, kind, answer id). There is no path from an orchestrator string to the terminal.
- Every press is journaled as an `answer-modal` audit line in the fsynced worker-coordination log
  (controller, worker, provider, kind, fingerprint, answer id, reason), beyond the lease renew that
  authenticated the call.

## Claude

| Prompt | Trigger | On-screen shape | Disposition |
| --- | --- | --- | --- |
| Folder trust | First launch in a cwd `~/.claude.json` has no accepted entry for | "Do you trust the files in this folder?" · `1. Yes, proceed` / `2. No, exit` | **avoid** — `ClaudeWorkspaceTrust` writes `projects["<cwd>"].hasTrustDialogAccepted: true` pre-spawn (grant-gated). Answer path (`trust`/`exit`) as fallback. |
| Plan-mode gate | Worker in plan mode finishes its plan | "Would you like to proceed?" · auto-accept / manually approve / keep planning | **answer** — `plan-confirm`: `proceed-auto`, `proceed-manual`, `keep-planning`. The wording differs from the permission prompt ("Would you like" vs "Do you want"), which is the classifier. |
| Permission approval | Tool call outside allowed permissions in `prompt` approval mode | "Claude needs your permission…" / "Do you want to proceed?" | **operator-only by policy** — recognized as `permission-approval`, described to the orchestrator, refused with `MODAL_POLICY_DENIED`. |
| Login | Expired/absent credentials | "…needs authentication" | **operator-only always** — `login` has an empty answer set; a keypress cannot answer it safely. |

Note: turn counts may never canonicalize after a trust dialog is answered mid-session — the
provider transcript can begin at a different ordinal than the screen ledger expected. Treat a
post-answer worker's first turn as the screen reports it.

## Codex

| Prompt | Trigger | On-screen shape | Disposition |
| --- | --- | --- | --- |
| Project trust | First launch in a cwd `~/.codex/config.toml` has no `[projects."<cwd>"]` for | "Do you trust the contents of this project?" · allow / ask every time | **avoid** — `CodexWorkspaceTrust` appends `[projects."<cwd>"]\ntrust_level = "trusted"` (grant-gated; an existing entry at *any* level is never overridden). Answer path as fallback. |
| MCP tool approval | MCP tool call under a config that prompts (`MCP_APPROVAL_PROMPTS_REMAIN` shortfall already warns at dispatch) | "Codex needs your approval…" naming an MCP tool · default `Yes, proceed` | **answer** — reclassified `mcp-approval` when the approval text names MCP or a `cyberdeck_` tool: `approve` (Enter on the default) / `deny` (Esc). Granting covers Cyberdeck's own injected server — the self-inflicted park. |
| Command / patch approval | `Would you like to run the following command / apply the following changes?` | selection list, default `Yes, proceed` | **operator-only by policy** — recognized as `permission-approval`, refused. Prefer fixing the dispatch's approval mode. |
| Login | Expired/absent credentials | "…needs authentication" | **operator-only always**. |

## Cursor

| Prompt | Trigger | On-screen shape | Disposition |
| --- | --- | --- | --- |
| Workspace trust (MIK-141) | Launch in an untrusted workspace | "Workspace Trust Required" · `a` to accept | **answer** — `workspace-trust`: `trust` (`a`) / `dismiss` (Esc). **No avoidance:** bounded investigation (2026-09-07) found no durable CLI trust store — `~/.cursor/cli-config.json` carries only `sandbox.mode`, `~/.cursor/sandbox-policies/*` and `~/.cursor/projects/*` are ephemeral/per-feature state. If the CLI grows a stable store, add a writer beside the Claude/Codex ones. |
| MCP server approval | Session config introduces an unapproved MCP server | "MCP Server Approval Required" | **answer** — `mcp-approval`: `approve` (`a`) / `dismiss`. Cyberdeck's own injected server is normally pre-approved through the session-scoped `cli-config.json` permissions (`mcp-hosting.ts`); this covers the residue. |
| `/run-everything` withholding | Read-only dispatch deliberately withholds auto-run | not a modal — composer text | **avoid at dispatch** — permission resolution already handles it; listed for completeness because it looks like a park. |
| Login | Expired/absent credentials | "cursor-agent needs authentication" | **operator-only always**. |

## Antigravity

| Prompt | Trigger | On-screen shape | Disposition |
| --- | --- | --- | --- |
| Workspace trust | Launch in a cwd absent from `agy` settings `trustedWorkspaces` | trust dialog | **avoid (pre-existing, unconditional)** — `AntigravityWorkspaceTrust` has always written the cwd pre-spawn, before grants existed; left as-is deliberately. The answer-path rule is defensive. |
| Plan gate | `> Plan mode:` awaiting input | composer prompt, not a modal | not a modal — ordinary `awaiting-input`; instructions reach it. |
| Login | Expired/absent credentials | "…needs authentication" | **operator-only always**. |

## Key-byte confidence

The recognition regexes extend the ones `blockedPromptIndexInTail` has been matching in production.
The key bytes are best-known mappings, chosen for determinism (digit selection where digits select
directly, the documented single key for Cursor's `a`, Enter only where the provider's default is
the affirmative, Esc for every dismissal). Two safety properties do not depend on their
correctness: a wrong key cannot be worse than what the descriptor enumerated for that exact dialog,
and a dialog that reshapes across provider versions changes its fingerprint and (if the wording
moves) drops to `unknown` — failing closed to the operator, never pressing blind.
