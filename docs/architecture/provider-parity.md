# Provider parity matrix

Cyberdeck was built and tuned against Codex. The other interactive adapters were added later and
their differences have so far only been discoverable by reading adapter source. This document
records them.

Every cell below is derived from committed source, cited as `file:line`, or from provider `--help`
metadata observed on the dates and versions recorded in
[Provider help evidence](#provider-help-evidence). Nothing here is inferred from a live model call.

Scope: **interactive (PTY) sessions** — the `ProviderAdapter` implementations registered in
`src/broker/main.ts:83-86`. Bounded/headless job dispatch is a separate execution dimension
documented per adapter in `docs/architecture/claude-adapter.md`, `docs/architecture/cursor-adapter.md`,
and `docs/architecture/antigravity-adapter.md`.

## Summary matrix

| Dimension | `codex` | `claude` | `cursor` | `antigravity` |
| --- | --- | --- | --- | --- |
| Adapter | `src/providers/codex.ts:24` | `src/providers/claude.ts:13` | `src/providers/cursor/session-adapter.ts:8` | `src/providers/antigravity/session-adapter.ts:9` |
| Executable | `codex` | `claude` | `agent` | `agy` |
| Permission/approval flags | `-s <sandbox> -a on-request` (`codex.ts:36-44`) | `--permission-mode plan\|manual` (`claude.ts:38-39`) | `--sandbox enabled` + `--mode plan` when read-only (`cursor/commands.ts:59-66`) | `--mode plan --sandbox` always (`antigravity/commands.ts:82-87`) |
| `workspace-write` supported | yes | yes (`manual`) | yes (no `--mode`) | **no** — throws `ANTIGRAVITY_WORKSPACE_WRITE_UNSUPPORTED` (`antigravity/commands.ts:83-85`) |
| Cyberdeck MCP server injected | yes, when `session.kind` is set (`codex.ts:97-110`) | yes, when `session.kind` is set (`claude.ts:95-106`) | **never** (`main.ts:85`) | **never** (`main.ts:86`) |
| `providerInstructions` forwarded | `-c developer_instructions=` (`codex.ts:92-95`) | `--append-system-prompt` (`claude.ts:90-93`) | **silently dropped** (`cursor/commands.ts:23-36`) | **silently dropped** (`antigravity/commands.ts:34-45`) |
| Effort values accepted | all six (`codex.ts:48-50`) | all except `ultra` (`claude.ts:46`) | **none** — any effort throws (`cursor/session-adapter.ts:12`) | `low\|medium\|high` only (`antigravity/commands.ts:93-99`) |
| Explicit model required | no | **yes** (`domain/policy.ts:47-56`) | no | no (but Fable is refused, `antigravity/commands.ts:107-109`) |
| `buildResumeSpec` | filesystem scan for the native rollout id (`codex.ts:65-90`) | `--resume <cyberdeck session id>` (`claude.ts:63-88`) | throws `SESSION_RESUME_UNAVAILABLE` (`cursor/session-adapter.ts:17-19`) | throws `SESSION_RESUME_UNAVAILABLE` (`antigravity/session-adapter.ts:34-36`) |
| `prepareLaunch` | none | none | none | writes the exact cwd to `agy`'s trust store (`antigravity/session-adapter.ts:30-32`) |
| `submitInput` | `CSI 13 u` (`codex.ts:29-33`) | `CSI 13 u` (`claude.ts:18-22`) | `\r` (`cursor/session-adapter.ts:21-23`) | `\r` (`antigravity/session-adapter.ts:38-40`) |
| Advertised worker models | 3 (`worker-capabilities.ts:20-26`) | 4 (`worker-capabilities.ts:27-36`) | 1 (`worker-capabilities.ts:37-43`) | 3 (`worker-capabilities.ts:44-53`) |

## Permission / approval mode, and how it is resolved

The Cyberdeck-level input is always `session.sandbox`, a two-value enum
(`src/domain/session.ts:8`). It is never inferred: the CLI defaults it to `read-only`
(`src/cli.ts:71`), orchestrator sessions hardcode `read-only`
(`src/orchestration/orchestrator-manager.ts:90`), and worker starts forward the requested value
verbatim (`src/orchestration/agent-control-service.ts:141`). No adapter widens it.

- **Codex** forwards the sandbox string unchanged as `-s` and always pins `-a on-request`
  (`src/providers/codex.ts:36-44`, `:65-76`). `read-only` and `workspace-write` happen to be
  Codex's own native sandbox-mode names, so no mapping table exists. `on-request` is the same on
  launch and resume; Cyberdeck never emits `--dangerously-bypass-approvals-and-sandbox`.
- **Claude** maps through one shared table so a sandbox cannot mean two things depending on
  execution dimension: `read-only → plan`, `workspace-write → manual`
  (`src/providers/claude/permissions.ts:12-19`), applied at `src/providers/claude.ts:38-39` and
  `:72-73`. `bypassPermissions` and `dontAsk` are deliberately never emitted.
- **Cursor** always sets `--sandbox enabled` and adds `--mode plan` only for `read-only`
  (`src/providers/cursor/commands.ts:59-66`). `agent` advertises only `plan` and `ask` as read-only
  modes, so `workspace-write` deliberately omits `--mode` and relies on the normal agent mode with
  the sandbox still explicit. `--force`, `--yolo`, `--auto-review`, `--trust`, and `--approve-mcps`
  are never emitted (proved by `tests/providers/cursor-adapter.test.ts:206-227`).
- **Antigravity** is the outlier: it emits `--mode plan --sandbox` for `read-only` and **refuses**
  `workspace-write` outright (`src/providers/antigravity/commands.ts:82-87`). `agy` advertises
  `accept-edits`, but the committed evidence does not establish that `accept-edits` preserves
  workspace-write semantics without automatic approval, so the adapter fails closed rather than
  silently granting more than asked (`src/providers/antigravity/capabilities.ts:26-31`).
  `--dangerously-skip-permissions` is never emitted. Antigravity additionally has a pre-spawn step:
  `prepareLaunch` appends the canonicalized cwd — and only that cwd, never a parent — to
  `~/.gemini/antigravity-cli/settings.json` (`src/providers/antigravity/workspace-trust.ts:22-56`).

This is **not** a closable parity gap. Antigravity's missing `workspace-write` is an evidence
boundary, not an oversight; closing it means emitting `--mode accept-edits`, which would claim a
guarantee the provider has not been shown to give.

## Cyberdeck MCP server injection

Both injecting adapters gate on the same condition — `session.kind === undefined || options.mcp ===
undefined` returns early (`src/providers/codex.ts:98`, `src/providers/claude.ts:96`). Two
consequences follow:

1. A plain human `cyberdeck start` thread has no `kind` (`src/cli.ts` builds no `kind` field), so it
   receives **no** MCP server on any provider. Only orchestrators
   (`src/orchestration/orchestrator-manager.ts:92`) and delegated workers
   (`src/orchestration/agent-control-service.ts:143`) do.
2. Cursor and Antigravity are constructed without an `mcp` option at all
   (`src/broker/main.ts:85-86`), so the second half of the guard can never be satisfied for them.

Injection shape:

- Codex: two `-c` overrides, `mcp_servers.cyberdeck.command` and `.args`
  (`src/providers/codex.ts:99-109`).
- Claude: one `--mcp-config` with an inline stdio server JSON (`src/providers/claude.ts:97-105`).

Both carry `mcp --actor-session <session id>`, which is what scopes the grant. Neither emits
`--strict-mcp-config`, so a Claude worker also loads the operator's own configured MCP servers; the
same is true of Codex config-file servers. That is existing behaviour, recorded here rather than
changed.

The tools exposed are orchestration-and-workflow shaped — `cyberdeck_threads_list`,
`cyberdeck_thread_read`, `cyberdeck_worker_start`, `cyberdeck_workers_wait`,
`cyberdeck_thread_message`, and the `cyberdeck_workflow_*` family (`src/mcp/server.ts:21-194`).
A session without them can still be a worker (completion is observed from the terminal, not
reported over MCP) but cannot orchestrate or join a workflow.

### Decision: Cursor and Antigravity do not receive the Cyberdeck MCP server

**Status: recorded as out of scope. Neither CLI accepts a per-invocation MCP server definition.**

Evidence, from the installed executables (see [Provider help evidence](#provider-help-evidence)):

- **`agy` (Antigravity 1.1.5) has no MCP surface at all.** `agy --help` lists every flag —
  `--add-dir`, `--agent`, `--continue`, `--conversation`, `--dangerously-skip-permissions`,
  `--effort`, `--log-file`, `--mode`, `--model`, `--new-project`, `--print`, `--print-timeout`,
  `--project`, `--prompt`, `--prompt-interactive`, `--sandbox` — and none configure an MCP server.
  Its subcommand list (`agent`, `agents`, `changelog`, `help`, `install`, `models`, `plugin`,
  `plugins`, `update`) contains no `mcp` command either. There is no mechanism to wire.

- **`agent` (Cursor 2026.07.20-8cc9c0b) has MCP, but only as persistent on-disk config.** The only
  MCP flag on the invocation is `--approve-mcps` ("Automatically approve all MCP servers"), which
  approves servers that are already configured; it does not define one. Server definition lives
  behind the `agent mcp` subcommand, whose help states servers are "configured in `.cursor/mcp.json`
  or `~/.cursor/mcp.json`" and whose verbs are `login`, `list`, `list-tools`, `enable`, `disable`.
  There is no `--mcp-config` equivalent.

Wiring Cursor would therefore mean writing a Cyberdeck server into the operator's
`~/.cursor/mcp.json` or the workspace's `.cursor/mcp.json`. That is not the same feature as Codex's
and Claude's injection, for three reasons:

1. It is **not session-scoped**. The `--actor-session <id>` argument is what binds the MCP server to
   one thread's capability grant; a shared config file has exactly one value for all Cursor sessions
   at once, so concurrent workers would share or race one actor identity.
2. It **mutates operator-owned state** outside `~/Library/Application Support/Cyberdeck/`, and
   outlives the session, which contradicts the existing boundary — the one file Cyberdeck already
   writes outside its own state directory (Antigravity's trust store) is deliberately narrow and
   documented.
3. It would still require `--approve-mcps` or an interactive approval to be usable, and
   `--approve-mcps` auto-approves *every* configured server, not just Cyberdeck's. That is a
   permission widening the adapters are explicitly written to avoid
   (`tests/providers/cursor-adapter.test.ts:206-227`).

So the practical answer for both providers is the same: **Cursor and Antigravity sessions cannot
call back into the fleet.** They are usable as workers and as human-attached threads. They are not
usable as orchestrators or as workflow participants. `src/broker/main.ts:85-86` is the intentional
encoding of that fact, and this section is the record it previously lacked.

Revisit this if Cursor ships a `--mcp-config`-style flag, or if Antigravity ships any MCP surface.

## Effort support

`ReasoningEffortSchema` accepts six values: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`
(`src/domain/session.ts:7`). Adapters diverge on which survive to argv.

| Provider | Accepted | Rejected | Mechanism |
| --- | --- | --- | --- |
| `codex` | all six | none | `-c model_reasoning_effort=<json>` (`src/providers/codex.ts:48-50`, `:78-80`) |
| `claude` | `low` `medium` `high` `xhigh` `max` | **`ultra`** | plain `Error("Claude does not support ultra effort")` (`src/providers/claude.ts:46`, `:77`) |
| `cursor` | none | all six | `UnsupportedProviderEffortError` / `PROVIDER_EFFORT_UNSUPPORTED` (`src/providers/cursor/session-adapter.ts:12`, `src/providers/session-adapter-errors.ts:10-17`) |
| `antigravity` | `low` `medium` `high` | `xhigh` `max` `ultra` | `AntigravityLaunchSafetyError` (`src/providers/antigravity/commands.ts:93-99`) |

Corroborated by help metadata: `claude --effort <level>` enumerates exactly `(low, medium, high,
xhigh, max)` — `ultra` is genuinely absent from the CLI, so the adapter's rejection is correct, not
conservative. `agy --effort` documents `(low|medium|high)`. `agent` has no effort flag; effort is
only expressible inside a parameterized model string such as
`'claude-opus-4-8[context=1m,effort=high,fast=false]'`, which Cyberdeck passes through opaquely as
`--model` and never synthesizes.

The autonomous-worker catalog agrees with all four rows (`src/orchestration/worker-capabilities.ts:19-54`),
and `validateWorkerSelection` rejects an unsupported effort with `EFFORT_NOT_SUPPORTED` before the
adapter is reached (`:109-116`). Antigravity additionally requires the effort to match its
effort-suffixed model id (`:118-129`).

Three different error types for the same class of refusal is a real inconsistency — see
[Known gaps](#known-gaps-deliberately-not-closed).

## Resume behaviour

`buildResumeSpec` re-opens the exact provider-native conversation behind a terminal Cyberdeck thread
(`src/providers/provider.ts:17`). The four implementations are not variations on one mechanism; they
are three different mechanisms and two refusals.

- **Codex** does not know its own conversation id, because `codex` mints the rollout id itself.
  `findNativeSessionId` scans `$CODEX_HOME/sessions` (default `~/.codex/sessions`) across the day
  before, of, and after the session's `createdAt` (`src/providers/codex.ts:112-118`, `:145-157`),
  reads the first `session_meta` line of each `.jsonl`, requires `originator === "codex-tui"` and an
  exact `cwd` match, and keeps candidates within a 30-second window of `createdAt`
  (`:8`, `:125-131`, `:159-185`). The nearest match wins; no match raises `CodexResumeError` /
  `SESSION_RESUME_UNAVAILABLE` (`:136-141`). Guidance and MCP config are re-emitted on the resume
  argv (`:81-82`), so both survive resume.
- **Claude** avoids the search entirely by assigning the id up front: launch passes
  `--session-id <cyberdeck session id>` (`src/providers/claude.ts:34-35`) and resume passes
  `--resume <same id>` (`:68-69`). The launch-safety gate, permission mode, effort rules, guidance,
  and MCP config are all re-applied identically on resume (`:64-81`).
- **Cursor** throws `SessionResumeUnavailableError` (`src/providers/cursor/session-adapter.ts:17-19`).
  `agent` does advertise `--resume [chatId]`, `--continue`, `create-chat`, `ls`, and a `resume`
  subcommand, so a mechanism plausibly exists — but the chat-id-to-Cyberdeck-thread binding is
  unverified, and resuming the wrong chat is worse than refusing.
- **Antigravity** throws the same error (`src/providers/antigravity/session-adapter.ts:34-36`).
  `agy` advertises `--continue` and `--conversation <id>`; the capability register grades
  conversation resume `live-unverified` because the identifiers and their durability require a live
  session (`src/providers/antigravity/capabilities.ts:57-61`).

Failing closed on both is the correct current state: a wrong-conversation resume silently
misattributes work. It should stay a refusal until the id binding is proven live.

## Provider instructions

Only Codex and Claude forward `session.providerInstructions`. Cursor and Antigravity's command
builders accept `cwd`, `sandbox`, `model`, and (Antigravity only) `effort`; the field is not part of
their request type and is discarded without error (`src/providers/cursor/commands.ts:5`, `:23-36`;
`src/providers/antigravity/commands.ts:7-9`, `:34-45`). Neither `agent --help` nor `agy --help`
documents a system-prompt append flag, so this is inherent, not an omission.

The consequence is only reachable through the orchestrator path, which is the one place that sets
`providerInstructions` (`src/orchestration/orchestrator-manager.ts:95`). See below.

## Known gaps, deliberately not closed

Recorded, not fixed, because closing them is out of scope for a documentation-first change:

1. **A Cursor or Antigravity orchestrator can be created and is silently inert.**
   `OrchestratorManager.ensure` accepts any registered provider (`src/orchestration/orchestrator-manager.ts:84-96`)
   and does not check for MCP capability. Such an orchestrator would start with neither its
   orchestrator prompt (dropped, above) nor any `cyberdeck_*` tool, and would have no way to
   discover it is meant to orchestrate. The guard belongs in `OrchestratorManager.ensure` as an
   explicit refusal — not in the adapters.
2. **Effort refusal uses three unrelated error shapes.** Claude throws a bare `Error`
   (`src/providers/claude.ts:46`, `:77`) with no `code`, while Cursor uses
   `PROVIDER_EFFORT_UNSUPPORTED` and Antigravity uses `ANTIGRAVITY_LAUNCH_UNSAFE`. Callers cannot
   handle "provider rejected this effort" uniformly. `src/providers/claude.ts` is owned by another
   change in flight; the recommendation is to reuse `UnsupportedProviderEffortError`.
3. **Cyberdeck MCP is not injected into human-started threads on any provider,** because the guard
   keys on `session.kind` rather than on MCP availability. This may be intended (a human thread has
   no capability grant), but like the Cursor/Antigravity case it was previously unstated.

## Provider help evidence

Metadata observations are date- and version-sensitive; these runtimes self-update. Re-check before
relying on a row.

| Executable | Version observed | Date | Command |
| --- | --- | --- | --- |
| `agent` (Cursor) | `2026.07.20-8cc9c0b` | 2026-07-25 | `agent --help`, `agent mcp --help` |
| `agy` (Antigravity) | `1.1.5` | 2026-07-25 | `agy --help` |
| `claude` | `2.1.220` | 2026-07-25 | `claude --help` |
| `codex` | `codex-cli 0.145.0` | 2026-07-25 | `codex --help` |

Grade: `help-advertised` / `metadata-observed`. No live model call was made to produce this
document, and no row claims `live-proven`.
