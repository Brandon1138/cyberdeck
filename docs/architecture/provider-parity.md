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
| Adapter | `src/providers/codex.ts:24` | `src/providers/claude.ts:13` | `src/providers/cursor/session-adapter.ts:49` | `src/providers/antigravity/session-adapter.ts:9` |
| Executable | `codex` | `claude` | `agent` | `agy` |
| Permission/approval flags | `-s <sandbox> -a never\|on-request` (`codex.ts:36-45`) | `--permission-mode auto\|plan\|manual` (`claude.ts:38-39`) | `--sandbox enabled` + `--mode plan` when read-only (`cursor/commands.ts:59-66`) | `--mode plan --sandbox` always (`antigravity/commands.ts:82-87`) |
| `workspace-write` supported | yes | yes (`manual`) | yes (no `--mode`) | **no** — throws `ANTIGRAVITY_WORKSPACE_WRITE_UNSUPPORTED` (`antigravity/commands.ts:83-85`) |
| Cyberdeck MCP server injected | yes, when `session.kind` is set (`codex.ts:97-110`) | yes, when `session.kind` is set (`claude.ts:95-106`) | yes, when `session.kind` is set, through a session-scoped plugin directory (`cursor/mcp-hosting.ts`, `cursor/session-adapter.ts:117-131`) | **never** (`main.ts:137`) |
| `providerInstructions` forwarded | `-c developer_instructions=` (`codex.ts:92-95`) | `--append-system-prompt` (`claude.ts:90-93`) | no flag exists; submitted as the first message (`cursor/session-adapter.ts:143-165`) | **silently dropped** (`antigravity/commands.ts:34-45`) |
| Effort values accepted | all six (`codex.ts:48-50`) | all except `ultra` (`claude.ts:46`) | **none** — any effort throws; the rung is inside the model slug (`cursor/session-adapter.ts:55`) | `low\|medium\|high` only (`antigravity/commands.ts:93-99`) |
| Explicit model required | no | **yes** (`domain/policy.ts:47-56`) | no | no (but Fable is refused, `antigravity/commands.ts:107-109`) |
| `buildResumeSpec` | filesystem scan for the native rollout id (`codex.ts:65-90`) | `--resume <cyberdeck session id>` (`claude.ts:63-88`) | `--resume <cyberdeck session id>`, refused without launch-record evidence (`cursor/session-adapter.ts:83-94`) | throws `SESSION_RESUME_UNAVAILABLE` (`antigravity/session-adapter.ts:34-36`) |
| `prepareLaunch` | none | none | writes the session-scoped MCP plugin and permission config, or isolates a Scout (`cursor/session-adapter.ts:123-131`) | writes the exact cwd to `agy`'s trust store (`antigravity/session-adapter.ts:30-32`) |
| `submitInput` | `CSI 13 u` (`codex.ts:29-33`) | `CSI 13 u` (`claude.ts:18-22`) | paced `\r` through the terminal (`cursor/session-adapter.ts:167-177`) | `\r` (`antigravity/session-adapter.ts:38-40`) |
| Advertised worker models | 3 (`worker-capabilities.ts:21-28`) | 4 (`worker-capabilities.ts:29-39`) | 28, one per model-and-effort pair (`worker-capabilities.ts:40-84`) | 3 (`worker-capabilities.ts:85-95`) |

## Permission / approval mode, and how it is resolved

The Cyberdeck-level input is always `session.sandbox`, a two-value enum
(`src/domain/session.ts:8`). It is never inferred: the CLI defaults it to `read-only`
(`src/cli.ts:71`), orchestrator sessions hardcode `read-only`
(`src/orchestration/orchestrator-manager.ts:90`), and worker starts forward the requested value
verbatim (`src/orchestration/agent-control-service.ts:141`). No adapter widens it.

- **Codex** forwards the sandbox string unchanged as `-s` and resolves `-a` from the
  provider-neutral `approvalMode`: `auto → never`, everything else `→ on-request`
  (`src/providers/codex.ts:36-45`, `:71-82`). `read-only` and `workspace-write` happen to be
  Codex's own native sandbox-mode names, so no mapping table exists. The same resolution runs on
  launch and resume; Cyberdeck never emits `--dangerously-bypass-approvals-and-sandbox`, so the
  sandbox stays in force even when approvals are automatic.
- **Claude** maps through one shared table so a sandbox cannot mean two things depending on
  execution dimension: `read-only → plan`, `workspace-write → manual`, with `approvalMode: "auto"`
  overriding both to `auto`
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

All three injecting adapters gate on the same condition — `session.kind === undefined ||
options.mcp === undefined` returns early (`src/providers/codex.ts:98`, `src/providers/claude.ts:96`,
`src/providers/cursor/session-adapter.ts:117-121`). Two consequences follow:

1. A plain human `cyberdeck start` thread has no `kind` (`src/cli.ts` builds no `kind` field), so it
   receives **no** MCP server on any provider. Only orchestrators
   (`src/orchestration/orchestrator-manager.ts:139`) and delegated workers
   (`src/orchestration/agent-control-service.ts:677`) do.
2. Antigravity is constructed without an `mcp` option at all (`src/broker/main.ts:137`), so the second
   half of the guard can never be satisfied for it.

Injection shape:

- Codex: two `-c` overrides, `mcp_servers.cyberdeck.command` and `.args`
  (`src/providers/codex.ts:99-109`).
- Claude: one `--mcp-config` with an inline stdio server JSON (`src/providers/claude.ts:97-105`).
- Cursor: no flag exists, so `prepareLaunch` writes a session-scoped plugin whose `.mcp.json` names
  the server, `--plugin-dir` loads it, and a session-scoped `CURSOR_CONFIG_DIR` pre-approves exactly
  that server's tools (`src/providers/cursor/mcp-hosting.ts`). Both directories live under
  Cyberdeck's private launch-files root and are removed by `cleanupLaunch`.

Both carry `mcp --actor-session <session id>`, which is what scopes the grant. Claude now emits
`--strict-mcp-config` alongside the config for orchestrators *and* workers, so a Claude session
loads exactly the injected `cyberdeck` server plus whatever the operator named in that kind's
allowlist (`~/Library/Application Support/Cyberdeck/{orchestrator,worker}-mcp.json`). Inheriting the
operator's servers took the fleet down once: one server stuck in `needs authentication` failed every
worker API call with `Tool reference 'WaitForMcpServers' not found` (400). Codex has no equivalent
flag, so a Codex session still loads the operator's config-file servers.

The tools exposed are orchestration-and-workflow shaped — `cyberdeck_threads_list`,
`cyberdeck_thread_read`, `cyberdeck_worker_start`, `cyberdeck_workers_wait`,
`cyberdeck_thread_message`, and the `cyberdeck_workflow_*` family (`src/mcp/server.ts:21-194`).
A session without them can still be a worker (completion is observed from the terminal, not
reported over MCP) but cannot orchestrate or join a workflow.

### Decision: Cursor hosts the server from a session-scoped plugin; Antigravity cannot

**Status: Cursor resolved. Antigravity remains out of scope — `agy` has no MCP surface to wire.**

Evidence, from the installed executables (see [Provider help evidence](#provider-help-evidence)):

- **`agy` (Antigravity 1.1.5) has no MCP surface at all.** `agy --help` lists every flag —
  `--add-dir`, `--agent`, `--continue`, `--conversation`, `--dangerously-skip-permissions`,
  `--effort`, `--log-file`, `--mode`, `--model`, `--new-project`, `--print`, `--print-timeout`,
  `--project`, `--prompt`, `--prompt-interactive`, `--sandbox` — and none configure an MCP server.
  Its subcommand list (`agent`, `agents`, `changelog`, `help`, `install`, `models`, `plugin`,
  `plugins`, `update`) contains no `mcp` command either. There is no mechanism to wire.

- **`agent` (Cursor 2026.07.23-e383d2b) still has no per-invocation MCP flag,** and that has not
  changed: the only MCP flag is `--approve-mcps` ("Automatically approve all MCP servers"), which
  approves already-configured servers rather than defining one, and definition lives behind the
  `agent mcp` subcommand over `.cursor/mcp.json` or `~/.cursor/mcp.json`. Measured against the
  installed binary, there is a third source those two documented paths do not mention: **the
  `.mcp.json` of every loaded plugin**, and plugins are nameable per invocation with `--plugin-dir`.

That third path is what Cyberdeck uses, and it satisfies the constraints the first two could not:

1. It is **session-scoped**. The plugin directory is created per session under Cyberdeck's private
   launch-files root, and the `.mcp.json` inside it carries that session's own
   `--actor-session <id>`, so two concurrent Cursor sessions cannot share or race one actor identity
   (`src/providers/cursor/mcp-hosting.ts`).
2. It **mutates no operator-owned state**. `~/.cursor` is not read or written, the workspace's
   `.cursor/mcp.json` is not created, and `HOME` is not redirected — which matters beyond tidiness,
   because overriding `HOME` loses the operator's Cursor credentials.
3. It needs **no blanket approval**. Loading a server is not permission to call it, so the session
   also gets a `CURSOR_CONFIG_DIR` of its own holding a `cli-config.json` that allows exactly
   `Mcp(plugin-cyberdeck-cyberdeck:*)`. `--approve-mcps`, which would auto-approve every configured
   server, is still never emitted; neither is `--force`, whose launch-time effect is to disable MCP
   servers outright.

So the two providers now differ: **a Cursor session can call back into the fleet and can be an
orchestrator or workflow participant** (`src/broker/main.ts:136`), while an Antigravity session
cannot (`:137`). `assertMcpCapableProvider` derives that from `ORCHESTRATOR_CATALOG` membership, so
the refusal and the capability cannot drift apart
(`src/orchestration/orchestrator-manager.ts:370-384`).

Revisit the Antigravity half if `agy` ships any MCP surface.

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
- **Cursor** now takes Claude's approach: `agent --resume <chatId>` reopens a known chat and adopts
  an unknown id as a new one, so launch and resume both name the Cyberdeck session id and the binding
  needs nothing persisted (`src/providers/cursor/commands.ts:49-70`,
  `src/providers/cursor/session-adapter.ts:83-115`). The refusal that remains is narrower and exact:
  a thread whose launch record does not contain that id was launched before chat ids were bound, so
  resuming it would open an empty chat presenting as the operator's original thread. That raises
  `CursorResumeError` / `SESSION_RESUME_UNAVAILABLE`, which the orchestrator manager treats as
  recoverable and answers with a rebind prompt. Scouts remain one-shot with no resume.
- **Antigravity** throws the same error (`src/providers/antigravity/session-adapter.ts:34-36`).
  `agy` advertises `--continue` and `--conversation <id>`; the capability register grades
  conversation resume `live-unverified` because the identifiers and their durability require a live
  session (`src/providers/antigravity/capabilities.ts:57-61`).

Failing closed is still the correct state for Antigravity, and for any Cursor thread whose
conversation identity was never bound: a wrong-conversation resume silently misattributes work.

## Provider instructions

Codex and Claude forward `session.providerInstructions` through a native flag. Neither
`agent --help` nor `agy --help` documents a system-prompt append flag, so for the other two providers
there is nothing to forward it *to*; that much is inherent.

Cursor no longer discards it. Because the guidance must arrive before any operator prompt, the
adapter defers the initial prompt whenever instructions are present — not only in `auto` mode — and
submits them as the session's first message after post-launch setup
(`src/providers/cursor/session-adapter.ts:143-165`). It costs one visible turn in the transcript,
which is accepted; it is not written into a rules file or `AGENTS.md` in the workspace. Resume does
not resubmit, because the conversation being reopened already contains them.

Antigravity still discards the field (`src/providers/antigravity/commands.ts:7-9`, `:34-45`). The
consequence is only reachable through the orchestrator path, which is the one place that sets
`providerInstructions` (`src/orchestration/orchestrator-manager.ts:142`) — and an Antigravity
orchestrator is refused outright, so an inert one can no longer be created.

## Known gaps, deliberately not closed

Recorded, not fixed, because closing them is out of scope for a documentation-first change:

1. **Effort refusal uses three unrelated error shapes.** Claude throws a bare `Error`
   (`src/providers/claude.ts:46`, `:77`) with no `code`, while Cursor uses
   `PROVIDER_EFFORT_UNSUPPORTED` and Antigravity uses `ANTIGRAVITY_LAUNCH_UNSAFE`. Callers cannot
   handle "provider rejected this effort" uniformly. `src/providers/claude.ts` is owned by another
   change in flight; the recommendation is to reuse `UnsupportedProviderEffortError`.
2. **Cyberdeck MCP is not injected into human-started threads on any provider,** because the guard
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
