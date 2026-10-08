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
| Permission/approval flags | `-s <sandbox> -a never\|on-request` | `--permission-mode auto\|plan\|manual` | `--sandbox enabled` + `--mode plan\|ask` when read-only | `--mode plan --sandbox` always |
| Resolved by | `src/domain/permission-resolution.ts` for all four — see [the resolution table](#the-resolution-table) | ← | ← | ← |
| `workspace-write` supported | yes | yes (`manual`) | yes (no `--mode`) | **no** — throws `ANTIGRAVITY_WORKSPACE_WRITE_UNSUPPORTED` (`antigravity/commands.ts:83-85`) |
| Writable roots outside cwd | `--add-dir` | `--add-dir` | `--add-dir` | `--add-dir` (unreachable: read-only only) |
| Cyberdeck MCP server injected | yes, when `session.kind` is set (`codex.ts:97-110`) | yes, when `session.kind` is set (`claude.ts:95-106`) | yes, when `session.kind` is set, through a session-scoped plugin directory (`cursor/mcp-hosting.ts`, `cursor/session-adapter.ts:117-131`) | **never** (`main.ts:137`) |
| `providerInstructions` forwarded | `-c developer_instructions=` (`codex.ts:92-95`) | `--append-system-prompt` (`claude.ts:90-93`) | no flag exists; submitted as the first message (`cursor/session-adapter.ts:143-165`) | **silently dropped** (`antigravity/commands.ts:34-45`) |
| Effort values accepted | all six (`codex.ts:48-50`) | all except `ultra` (`claude.ts:46`) | **none** — any effort throws; the rung is inside the model slug (`cursor/session-adapter.ts:55`) | `low\|medium\|high` only (`antigravity/commands.ts:93-99`) |
| Explicit model required | no | **yes** (`domain/policy.ts:47-56`) | no | no (but Fable is refused, `antigravity/commands.ts:107-109`) |
| `buildResumeSpec` | filesystem scan for the native rollout id (`codex.ts:65-90`) | `--resume <cyberdeck session id>` (`claude.ts:63-88`) | `--resume <cyberdeck session id>`, refused without launch-record evidence (`cursor/session-adapter.ts:83-94`) | throws `SESSION_RESUME_UNAVAILABLE` (`antigravity/session-adapter.ts:34-36`) |
| `prepareLaunch` | none | none | writes the session-scoped MCP plugin and permission config, or isolates a Scout (`cursor/session-adapter.ts:123-131`) | writes the exact cwd to `agy`'s trust store (`antigravity/session-adapter.ts:30-32`) |
| `submitInput` | `CSI 13 u` (`codex.ts:29-33`) | `CSI 13 u` (`claude.ts:18-22`) | paced `\r` through the terminal (`cursor/session-adapter.ts:167-177`) | `\r` (`antigravity/session-adapter.ts:38-40`) |
| Advertised worker models | 3 (`worker-capabilities.ts:21-28`) | 4 (`worker-capabilities.ts:29-39`) | 28, one per model-and-effort pair (`worker-capabilities.ts:40-84`) | 3 (`worker-capabilities.ts:85-95`) |

## Permission / approval mode, and how it is resolved

A stored permission request is two values: `session.sandbox`, a two-value enum
(`src/domain/session.ts`), and `session.approvalMode`, which is optional and absent means `prompt`.
Neither is inferred: the CLI defaults the sandbox to `read-only` (`src/cli.ts`), orchestrator
sessions hardcode `read-only` (`src/orchestration/orchestrator-manager.ts`), and worker starts
forward the requested value verbatim.

### The two dimensions, named once

The providers conflate the two in opposite directions, which is why Cyberdeck names them itself
before any provider sees them (`src/domain/permission-resolution.ts`):

| Dimension | Values | Question it answers |
| --- | --- | --- |
| `writes` | `denied` / `workspace` | May the session modify files at all? |
| `prompts` | `interactive` / `never` | Does the session stop for a human before acting? |

`resolveProviderPermissionPlan(provider, request)` is the **only** place either dimension becomes
provider-native argv. All four adapters call it, so the same stored request cannot mean different
things in different adapters. Before it existed, `read-only + auto` reached Codex as
`-s read-only -a never` and reached Claude as `--permission-mode auto` — a session that could write,
which the request had explicitly refused, with nothing recording that the two had diverged (MIK-70).

### The resolution table

Every cell is asserted in `tests/domain/permission-resolution.test.ts`.

| provider | sandbox | approvalMode | emitted flags | achieved | shortfall |
| --- | --- | --- | --- | --- | --- |
| `codex` | `read-only` | `prompt` | `-s read-only -a on-request` | denied / interactive | — |
| `codex` | `read-only` | `auto` | `-s read-only -a never` | denied / never | MCP¹ |
| `codex` | `workspace-write` | `prompt` | `-s workspace-write -a on-request` | workspace / interactive | — |
| `codex` | `workspace-write` | `auto` | `-s workspace-write -a never` | workspace / never | MCP¹ |
| `claude` | `read-only` | `prompt` | `--permission-mode plan` | denied / interactive | — |
| `claude` | `read-only` | `auto` | `--permission-mode plan` | denied / **interactive** | `APPROVAL_PROMPTS_REMAIN` |
| `claude` | `workspace-write` | `prompt` | `--permission-mode manual` | workspace / interactive | — |
| `claude` | `workspace-write` | `auto` | `--permission-mode auto` | workspace / never | — |
| `cursor` | `read-only` | `prompt` | `--sandbox enabled --mode plan` | denied / interactive | — |
| `cursor` | `read-only` | `auto` | `--sandbox enabled --mode plan` | denied / **interactive** | `APPROVAL_PROMPTS_REMAIN` |
| `cursor` | `workspace-write` | `prompt` | `--sandbox enabled` | workspace / interactive | — |
| `cursor` | `workspace-write` | `auto` | `--sandbox enabled` + post-launch `/run-everything` | workspace / never | — |
| `antigravity` | `read-only` | `prompt` | `--mode plan --sandbox` | denied / interactive | — |
| `antigravity` | `read-only` | `auto` | **refused** `PROVIDER_APPROVAL_MODE_UNSUPPORTED` | — | — |
| `antigravity` | `workspace-write` | any | **refused** `PROVIDER_SANDBOX_UNSUPPORTED` | — | — |

¹ Only when the Cyberdeck MCP server is injected — see [MCP approval](#mcp-approval-is-not-covered-by-codexs-approval-mode).

Two invariants hold across the whole table and are asserted as such:

- **`achieved.writes` always equals `requested.writes`.** A provider that cannot match the requested
  write boundary refuses; it never diverges. This is the anti-widening rule.
- **`achieved.prompts` may fall back to `interactive`, and only in that direction**, and never
  silently: every fallback carries a `PermissionShortfall`.

### Shortfalls: denial is loud

A `PermissionShortfall` is a declared record of a capability the provider cannot deliver. Resolution
returns them, `startWorker` and `OrchestratorManager.create` surface them as `warnings` on the start
result. There is no path where a request is quietly downgraded.

- `APPROVAL_PROMPTS_REMAIN` — automatic approval was asked for and cannot be granted without
  widening the write boundary. Claude's only write-denying mode is `plan`, which still asks before
  leaving it; Cursor's `/run-everything` is not bounded by `--mode plan`, so it is withheld rather
  than run inside a read-only session.
- `MCP_APPROVAL_PROMPTS_REMAIN` — see below.

**Operational consequence for orchestrators.** Orchestrator sessions hardcode `sandbox: "read-only"`,
so a Claude orchestrator configured `automatic` now launches `--permission-mode plan` and carries an
`APPROVAL_PROMPTS_REMAIN` warning, where it previously launched `auto` and could write. The remedy is
one of two operator decisions — configure Claude orchestrators to `permissioned`, or decide
orchestrators should request `workspace-write` — not a resolution-layer change.

### MCP approval is not covered by Codex's approval mode

`-a never` governs shell execution. Codex 0.147.0 advertises no per-server or per-tool MCP approval
setting, and on 2026-08-14 automatic Codex workers were observed stopping at an interactive approval
prompt for a Cyberdeck MCP tool call. `MCP_APPROVAL_AUTOMATIC.codex` is therefore `false`: unproven
is treated as unavailable, and an automatic Codex session with the MCP server injected starts with a
warning telling it to report through the `cyberdeck` CLI instead. Claude's `auto` covers MCP tools;
Cursor grants MCP at launch through its session-scoped `cli-config.json` allowlist; Antigravity has
no MCP surface.

### Writable roots

`--add-dir <path>` exists on all four CLIs and is the one mechanism that grants a session write
access outside its workspace root. It is the mechanism a worker needs to run `git worktree add`: that
command writes `refs/heads/<branch>` and `worktrees/<name>` under the git **common** directory of the
source repository, which is never inside the worktree being created. Requesting writable roots
alongside `sandbox: "read-only"` is refused (`WRITABLE_ROOTS_REQUIRE_WORKSPACE_WRITE`) rather than
resolved into flags that cannot take effect.

Roots reach resolution from the typed `workspace` field on a worker start; see
[Worker workspaces](#worker-workspaces). Codex, Claude, and Cursor each forward them from that field
into their own launch arguments — Cursor's sandbox is bounded by `--workspace` exactly as the other
two are bounded by their cwd, so it is not the exception it briefly was. Antigravity never reaches
the roots at all, because it refuses `workspace-write` first.

`workspaceWritableRoots` drops exactly one declared root: a **pre-provisioned** worker's own
worktree, which is where that worker already runs, so granting it again emits an argument that says
nothing. A **worker-provisioned** worker runs in the *source* repository instead, so its target is
outside cwd and does not exist yet; its `worktreePath` survives into `--add-dir` and is what makes
`git worktree add` able to create the directory the dispatch named.

### Provider-specific notes

- **Codex** is the one provider whose flags are a direct transcription: it names both dimensions
  natively and applies both literally. Cyberdeck never emits
  `--dangerously-bypass-approvals-and-sandbox`, so the sandbox stays in force even when approvals are
  automatic.
- **Claude** has one flag for both dimensions. `bypassPermissions` and `dontAsk` are deliberately
  never emitted, asserted in `tests/domain/permission-resolution.test.ts`.
- **Cursor** advertises only `plan` and `ask` as read-only modes, so `workspace-write` omits `--mode`
  and relies on the normal agent mode with the sandbox still explicit. `ask` is used for Scouts.
  `--force`, `--yolo`, `--auto-review`, `--trust`, and `--approve-mcps` are never emitted.
- **Antigravity** refuses `workspace-write` outright. `agy` advertises `accept-edits`, but the
  committed evidence does not establish that it preserves workspace-write semantics without
  automatic approval, so the adapter fails closed rather than silently granting more than asked.
  `--dangerously-skip-permissions` is never emitted. Antigravity additionally has a pre-spawn step:
  `prepareLaunch` appends the canonicalized cwd — and only that cwd, never a parent — to
  `~/.gemini/antigravity-cli/settings.json` (`src/providers/antigravity/workspace-trust.ts`).

Antigravity's missing `workspace-write` is **not** a closable parity gap. It is an evidence boundary,
not an oversight; closing it means emitting `--mode accept-edits`, which would claim a guarantee the
provider has not been shown to give.

## Worker workspaces

Worktree requirements used to exist only as prose in a worker's prompt, so the broker could not check
that the worktree was there, could not tell whether the worker was expected to create it, and could
not notice that the sandbox it was about to grant made creating it impossible.
`WorkerWorkspaceSchema` (`src/domain/worker-workspace.ts`) types the requirement instead:

| Field | Meaning |
| --- | --- |
| `worktreePath` | Absolute path of the worktree the work happens in |
| `branch` | The branch the worker's commits land on |
| `baseRef` | The ref the branch was cut from, and the baseline a review diffs against |
| `provisioning` | `pre-provisioned` (the broker made it) or `worker-provisioned` (the worker will) |
| `writableRoots` | Absolute directories that must be writable in addition to the workspace root |

`validateWorkerWorkspace` runs in `startWorker` before any process exists, using a `WorkspaceProbe`
(`GitWorkspaceProbe` in the broker, read-only git plumbing only). Its failures:

| Code | Cause |
| --- | --- |
| `WORKSPACE_CWD_OUTSIDE_WORKTREE` | A pre-provisioned worker's cwd is not in its worktree, or a worker-provisioned one's cwd is inside the worktree it has yet to create |
| `WORKSPACE_PROVISIONING_REQUIRES_WRITE` | `worker-provisioned` under a read-only sandbox, which cannot run `git worktree add` at all |
| `WORKSPACE_TARGET_NOT_WRITABLE` | The worktree to be created is outside cwd and outside every writable root |
| `WORKSPACE_GIT_DIR_NOT_WRITABLE` | The git common directory, where the ref is created, is not writable — the 2026-08-14 `cannot lock ref ... 'Operation not permitted'` denial, caught before launch and naming the directory to add |
| `WORKSPACE_WORKTREE_MISSING` | A declared pre-provisioned worktree is absent or is not its own root; or a worker-provisioned cwd is not a repository |
| `WORKSPACE_BRANCH_MISMATCH` | The declared branch is not what is checked out (detached HEAD is named as such) |
| `WORKSPACE_BASE_REF_UNRESOLVED` | The base ref does not resolve, so no review has a baseline |

The field is optional. A start without it behaves exactly as before, which keeps every existing
dispatch working; validation applies to dispatches that declare what they need.

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

- Codex workers: two `-c` overrides, `mcp_servers.cyberdeck.command` and `.args`.
  Remote orchestrators also use a terminal-owned launcher and a private Unix WebSocket bridge
  (`src/providers/codex/remote-mcp-launch.ts`, `remote-mcp-bridge.ts`). The native TUI drops
  `mcp_servers` from the config it forwards to its shared app-server, so the bridge adds exactly
  `mcp_servers.cyberdeck` to `thread/start`, `thread/resume`, and `thread/fork` requests. Each bridge
  fixes `--actor-session` to its own Cyberdeck session; other servers and native settings pass
  through. It writes no shared daemon configuration. Its lifetime follows the native terminal,
  including signal forwarding and cleanup, so a broker restart does not sever the connection.
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

## Orchestrator notice hooks (spike, 2026-10-07)

What each provider CLI actually does with a hook that prints a notice, measured live against
`claude` 2.1.280, `codex-cli` 0.160.1 and Cursor `agent` 2026.10.01-e373342. Every config, script
and log lived in a scratch root, `/private/tmp/cyberdeck-hook-spike/`. The copies that matter are in
`handoffs/orchestrator-notifications/spike/`. Evidence references below are run ids: they appear
in `spike/hooks.log.excerpt` (the `runId` field) and, where a summary was kept, in
`spike/evidence/<run>.sum`. No operator config was written. No run went through the broker or tmux.

Grades: **yes** / **no** = verified live in this spike; **untested** = not run, with the reason.

| # | Question | Claude 2.1.280 | Codex 0.160.1 | Cursor 2026.10.01 |
| --- | --- | --- | --- | --- |
| Q1 | PostToolUse on a native tool reaches the model | **yes**: matcher `.*` fires for `Bash`, `additionalContext` echoed by the model (c1, r2) | **untested**: hooks in an untrusted `hooks.json` are skipped silently (x0); `--dangerously-bypass-hook-trust` was refused to this session; scripted in `spike/codex/codex-tests.sh` | **yes**: `postToolUse` fires for `Shell`, `additional_context` echoed (u1, u2, u2-interactive) |
| Q2 | PostToolUse on an MCP tool; name seen | **yes**: `tool_name` is `mcp__echo__echo` and the payload adds `mcp_server`; `.*` covers it (c1) | **untested**, same reason. The `--json` stream names the call server `echo`, tool `echo` (x0b); the hook-side name is unknown | **yes**: `tool_name` is `MCP:echo` (`MCP:<tool>`, no server), for a plugin-hosted server too (u1, u2). `afterMCPExecution` also fires, with `tool_name` `echo` and `mcp_server_name` |
| Q3 | Stop: continue the session; loop guard | **yes**: Stop `hookSpecificOutput.additionalContext` continues the turn (c2); `decision:block` injects a user-role "Stop hook feedback:\n<reason>" and continues (c3). Re-fires with `stop_hook_active:true` (c2, c3) | **untested**. `hooks` is a *stable* feature, already `true` in `codex features list`; the file is `$CODEX_HOME/hooks.json` | **partial**: a project `stop` hook fires only **interactively**, not under `-p` (u3 vs u3-interactive). `followup_message` arrives as a new `<user_query>` turn; it re-fires with `loop_count:1`. A **plugin** `stop` hook never fired (u2-interactive, twice) |
| Q4 | Claude `asyncRewake` wakes an idle session | **yes**: Stop (r1b) and PostToolUse (r2b) async hooks that exit 2 after 8 s inject `<task-notification>…Stop hook blocking error from command "Stop": <stderr>` into an idle interactive session, which then answers | n/a | n/a |
| Q5 | Latency | sync hook ≈80 ms first-log→`tool_result` plus ≈0.2 s node cold start; model sees it on its next request (≈1.5 s later). asyncRewake: exit→injected ≈10 ms, →reply ≈1.8 s | **untested** | `postToolUse` ran *before* the tool's `completed` event (77 ms ahead, u1); interactive `stop`→next turn immediate (u3-interactive) |
| Q6 | Faults | exit 1: outcome `error`, **stdout still delivered**. Timeout: `cancelled` at 2 s, nothing delivered, tool intact. Exit 2 (sync): stderr delivered **with the full command line**. Silent exit 0: nothing (c4, c5) | **untested** (x4, x5 scripted) | exit 1: stdout **dropped**. Timeout 2 s: nothing delivered, tool intact. Exit 2 / silent: nothing reaches the model (u4, u5) |
| Q6b | Timeout field | `timeout`, seconds | `timeout`, seconds (accepted by the parser; not exercised) | `timeout`, seconds |
| Q7 | Hook on tool failure | **yes**: `PostToolUseFailure` fires for a failed MCP call (`isError`) and for a non-zero `Bash`; `PostToolUse` does **not**. A permission-denied call fires neither (c6, c7) | **untested** (x6 scripted) | **yes, split**: `postToolUseFailure` fires for `Shell` `false` (u6x); an MCP `isError:true` fires `postToolUse`, **not** the failure event (u6) |
| Q8 | Cursor per-launch hooks | n/a | n/a | **yes**: `--plugin-dir <p>` with `<p>/hooks/hooks.json` loads hooks for that launch only, `-p` (u2) and interactive (u2-interactive). Project `<ws>/.cursor/hooks.json` is honoured under `-p --trust` (u1). `CURSOR_CONFIG_DIR` does **not** move `hooks.json` |

### Exact hook JSON that worked

Claude, passed with `--settings <file>` (`spike/claude-settings.json`, which is c1 and c2 merged):

```json
{"hooks":{
  "PostToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"node …/hook.mjs claude PostToolUse c1","timeout":5}]}],
  "PostToolUseFailure":[{"matcher":".*","hooks":[{"type":"command","command":"node …/hook.mjs claude PostToolUseFailure c1","timeout":5}]}],
  "Stop":[{"hooks":[{"type":"command","command":"node …/hook.mjs claude Stop c2 --once","timeout":5}]}]
}}
```

The hook prints `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"<text>"}}`.
For Stop, `--once` makes it print nothing when `stop_hook_active` is true. asyncRewake
(`spike/claude-settings-asyncrewake-stop.json`) uses
`{"type":"command","command":"… --sleep-ms 8000 --stderr --exit 2 --print-nothing","asyncRewake":true,"timeout":30}`.

Cursor, as a plugin (`spike/cursor-plugin/cyberdeck/hooks/hooks.json`, beside `.cursor-plugin/plugin.json` and `.mcp.json`):

```json
{"version":1,"hooks":{
  "postToolUse":[{"command":"node …/hook.mjs cursor postToolUse u2","timeout":5}],
  "stop":[{"command":"node …/hook.mjs cursor stop u2 --shape followup --once","timeout":5}]
}}
```

The hook prints `{"additional_context":"<text>"}` (or `{"followup_message":"<text>"}` for stop).
There is no matcher: an event hook sees every tool.

Codex (`spike/codex/hooks.x1-posttooluse.json`; untested, schema accepted): the same shape as
Claude, `{"hooks":{"PostToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"…","timeout":5}]}]}}`,
with `[features] hooks = true` in `config.toml` (`spike/codex/config.toml.fragment`). Its MCP
server also needs `default_tools_approval_mode = "approve"` under `[mcp_servers.<name>]`, or
`exec` cancels the call under approval policy `never`.

### Exact command lines

```bash
# Claude, headless (spike/run-claude.sh)
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p --setting-sources local --settings "$settings" \
  --mcp-config mcp.json --strict-mcp-config --allowedTools "Bash(echo spike)" "Bash(ls /nonexistent-spike)" "Bash(false)" "mcp__echo__echo" \
  --max-turns 4 --model haiku --no-session-persistence --output-format stream-json --verbose --include-hook-events \
  "$prompt" < /dev/null
# Claude, interactive asyncRewake (spike/pty-claude.mjs, node-pty): the same flags minus -p/stream-json,
# with CLAUDE_CODE_CHILD_SESSION unset and CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1. An inherited
# CLAUDE_CODE_CHILD_SESSION silently disables transcript writes.

# Cursor, headless (spike/run-cursor.sh); interactive is spike/pty-cursor.mjs with the same env
CURSOR_CONFIG_DIR=$S/cursor-config CURSOR_DATA_DIR=$S/cursor-data agent -p --trust --approve-mcps \
  --workspace "$ws" --model composer-2.5 --output-format stream-json [--plugin-dir $S/cursor-plugin/cyberdeck] "$prompt" < /dev/null

# Codex (spike/codex/codex-tests.sh — scripted, not run in this spike)
CODEX_HOME=$S/codex-home-x1 codex exec --skip-git-repo-check --ephemeral -C $S/codex-work --json \
  --dangerously-bypass-hook-trust "$prompt" < /dev/null
```

### Observations that shape the design

- **Startup cost decides the hook entry point.** Bare `node` takes ≈0.2 s. `cyberdeck --version`
  through the pnpm wrapper took 3.5–5.2 s cold, and `node dist/src/cli.js --version` took ≈1.3 s.
  Every tool call runs PostToolUse, so a notice hook that boots the full CLI adds about a second
  per tool call and risks a 2 s timeout. Importing a single module costs ≈0.2 s.
- **Fault handling differs by provider.** On exit 1 with JSON on stdout, Claude delivers the JSON
  and Cursor drops it. Only exit 0 behaves the same everywhere. Claude's sync exit 2 shows the
  model the hook's entire command line, including `--state-directory` paths.
- **Stop is a re-entry loop on both providers that support it.** Claude re-fires with
  `stop_hook_active:true` and Cursor with `loop_count ≥ 1`. A hook that prints whenever a notice
  is pending gets exactly one extra turn per stop if it keys on those fields, and runs without
  bound if it does not.
- **Cursor also reads Claude's hooks.** Cursor's hook loader (from its bundle; not exercised here)
  merges enterprise `/Library/Application Support/Cursor/hooks.json`, user `~/.cursor/hooks.json`,
  project `.cursor/hooks.json`, Claude's user/project/local `settings.json` hooks, and plugin
  `hooks/hooks.json`. A notice hook placed in a project `.claude/settings.json` would fire in
  Cursor too, so put none there.
- **Codex trust is per hook and silent.** Trust is recorded in `config.toml` as
  `[hooks.state."<hooks.json path>:<event>:<group>:<handler>"] trusted_hash = …`. An untrusted
  hook is skipped with no warning (x0). `--dangerously-bypass-hook-trust` is described by Codex as
  "Intended only for automation that already vets hook sources". Strings in the 0.160.1 binary
  also show a `hooks` key in `config.toml` itself, plugin `hooks/hooks.json` with "materialized
  plugin hook trust", and project-local hook layers. Those are unverified leads for a per-launch
  route that avoids writing a shared `hooks.json`.
- **The planning pack's Codex premise does not hold on this branch.** `01-implementation-plan.md`
  says Task E extends the managed `hooks.json` written by
  `CodexOrchestratorHome.prepareFirstPartyConfiguration`. No such class exists in `src/` on this
  branch or in any reachable commit. Codex sessions run with the operator's `CODEX_HOME`
  (`src/providers/codex.ts:215`), and the only `hooks.json` Cyberdeck could write today is the
  operator's own `~/.codex/hooks.json`.

### Decision for Task E

Constraint for every provider: the hook only **reads** a notice file and prints, and it always
exits 0. It cannot record that it delivered anything. The broker must therefore keep the notice
file as a short, idempotent summary (for example `"N notices pending (newest: <kind> <subject>);
drain with cyberdeck_notifications_read"`), rewritten when notices arrive and **truncated or
removed when the orchestrator drains**. Until the drain, every tool call repeats the same line;
that repetition is the nag, and the drain is the only thing that stops it. If the file is missing,
empty, or unparseable, the hook prints nothing and exits 0. The entry point is a dedicated small
script, `node <dist>/notice-hook.js --actor-session <id> --state-directory <dir> --event <E>`,
shell-quoted the same way as `transcript-hook.ts`. It must import nothing from the CLI graph.

**Claude.** Generate three hooks next to the existing SessionStart hook in the launch settings:

```json
{"hooks":{
  "PostToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"<notice-hook> --event PostToolUse","timeout":2}]}],
  "PostToolUseFailure":[{"matcher":".*","hooks":[{"type":"command","command":"<notice-hook> --event PostToolUseFailure","timeout":2}]}],
  "Stop":[{"hooks":[{"type":"command","command":"<notice-hook> --event Stop","timeout":2}]}]
}}
```

Output is `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"<summary>"}}`.
For Stop, use additionalContext rather than `decision:block`, and print nothing when
`stop_hook_active` is true. That guard is read from stdin, so no write is needed. `PostToolUseFailure`
is required: without it, a failing tool call hides the notice. The 2 s timeout is safe because
the hook measured well under 0.5 s. **No asyncRewake in v1.** It works, but an idle wake needs a
hook that stays alive until a notice exists, then exits 2. That is a long-poll process per stop,
it breaks the read-and-print rule, and its wake re-enters Stop. The tier A instruction-queue wake
already covers idle sessions; revisit asyncRewake only if that wake proves unreliable.

**Codex.** Provisional: Claude's JSON verbatim (PostToolUse `.*`, Stop with the same guard,
`timeout: 2`). The event names and `matcher` shape match Claude's and its config accepted them,
but this spike never saw a Codex hook run.
**Do not build it yet.** Two things block it. First, a host run of `spike/codex/codex-tests.sh` must confirm
delivery, the hook-side MCP tool name, and the fault behaviour. Second, there is nowhere to put
the file: Cyberdeck must not write `~/.codex/hooks.json`, and the managed `CODEX_HOME` the plan
assumes does not exist. Trust also has to be settled: either Cyberdeck writes a `trusted_hash` it
computes, or it launches with `--dangerously-bypass-hook-trust`, which also stops vetting the
operator's own hooks. That choice belongs to the operator. Until both are resolved, Codex is
tier A only.

**Cursor.** Use **a hooks file, not tier A only**. This reverses the planning pack's default
(spec open question 3), because a per-launch mechanism exists and Cyberdeck already owns it: add
`hooks/hooks.json` to the session-scoped plugin directory that `src/providers/cursor/mcp-hosting.ts`
already passes with `--plugin-dir`. This needs no write to the workspace, `~/.cursor` or `~/.claude`.

```json
{"version":1,"hooks":{
  "postToolUse":[{"command":"<notice-hook> --event postToolUse","timeout":2}],
  "postToolUseFailure":[{"command":"<notice-hook> --event postToolUseFailure","timeout":2}]
}}
```

Output is `{"additional_context":"<summary>"}`, exit 0. Cursor drops stdout on any non-zero exit.
Both events are needed: `Shell` failures go to `postToolUseFailure`, while MCP `isError` results
go to `postToolUse`. **No stop hook.** It never fired from the plugin. A project `stop` hook fires
only interactively, and its `followup_message` is just a user turn, which is what the tier A
instruction-queue wake already sends.
