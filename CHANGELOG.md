# Changelog

All notable changes to Cyberdeck are documented here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) while its public API
and persisted schemas remain under active alpha development.

## [Unreleased]

### Fixed

- Broker startup streams the worker coordination journal, avoiding Node's string
  limit after long-running budget observation history. Automatic lossless
  checkpoints archive the original journal and remove intermediate snapshots
  while preserving leases, handoffs, audits, mutation receipts, and transaction
  identities. Appends and checkpoints hold a crash-safe cross-process lock so
  a second broker cannot hide an acknowledged mutation during replacement.
  Budget polling coalesces overlapping checks, and startup failures
  include their stack trace.

## [0.1.0-alpha.3] - 2026-10-09

### Added

- Orchestrator notification feed. An orchestrator no longer has to sit inside
  `cyberdeck_workers_wait` to learn that a worker settled, blocked on a
  provider prompt, asked for a decision, or lost an instruction. The broker
  writes every such transition, from the same worker truth every other
  surface projects, into a durable per-controller inbox
  (`orchestration/orchestrator-notifications-v1.jsonl`, fsynced, replayed on
  restart, capped with counted drops). The orchestrator sees a one-line
  notice, never the payload: beside any `cyberdeck_*` tool result
  (`cyberdeckNotice`), after other tools through a provider hook (Claude
  `PostToolUse`/`PostToolUseFailure`/`Stop`, Cursor plugin
  `postToolUse`/`postToolUseFailure`; Codex is tier A only), or as a
  `[cyberdeck notice]` line at its prompt through the existing instruction
  queue when it is idle, coalesced, withdrawn if it starts a turn first, held
  behind a human controller, and capped per hour. It drains with
  `cyberdeck_notifications_read` (cursor-acknowledged, at-least-once) and
  tunes wakes with `cyberdeck_notifications_configure`. A settled record
  embeds the bounded result a wait would return, and the wait and the feed
  agree: a drained target makes the later wait answer `retrieval: "replay"`,
  and a wait that delivers a target consumes its record. New CLI:
  `cyberdeck notifications notice|read|configure`; the hook command is the
  lean `cli/notice-hook-entry.js`, which imports nothing from the CLI graph.
  Design and decisions: `docs/architecture/orchestrator-notifications.md`;
  provider hook evidence: `docs/architecture/provider-parity.md`.

- An orchestrator can start a peer orchestrator from its own tools, so
  orchestration can continue from the phone. `cyberdeck_orchestrator_create`
  reaches the broker's existing peer-creation path behind a new
  `orchestrator.create` capability, granted by default to every new binding and
  switched per scope with `cyberdeck orchestrator peer-create on|off`. The peer
  launches detached with the provider's Remote Control surface, receives its
  creator's full grant and may create peers under the same approval rule, and may
  not reach wider than its creator's scope. An optional brief is queued as the peer's first
  instruction, the binding records who asked for it, and the broker journal
  carries `orchestrator.create.requested` / `orchestrator.create.result`.
  Bindings written before this change lack the capability until the operator
  runs `peer-create on` once for that scope (MIK-256, first slice of MIK-254).

- Peer creation now requires the operator's express approval from the current
  conversation, quoted verbatim in a bounded `approval` argument on every create;
  absent or blank approval returns `APPROVAL_REQUIRED`. Standing approval repeats
  its quote on each covered create. There is no live-peer cap or lineage depth limit,
  and peers inherit their creator's capabilities unchanged, including
  `orchestrator.create`. Approval and depth are journaled, persisted on the binding
  and reported by create and inspect. Creator and peer prompts require asking first;
  the broker validates the model-asserted field and cannot verify chat consent.
  Legacy peers keep their durable grants. Per-creator serialization, scope narrowing,
  mutation replay and brief delivery remain intact. The scope's durable `peer-create off`
  kill-switch stops fresh creates by its primary, existing peers and descendants, including
  peers whose grants retain `orchestrator.create`; admission reads the primary binding on
  each create. Re-enabling the scope does not widen legacy narrowed peer grants. Optional
  approval timestamps accept RFC 3339 numeric offsets and remain verbatim (MIK-257).

### Fixed

- A peer orchestrator binding is a controller. Every binding — primary or
  `:peer:` — was granted the same capability list including `thread.enqueue`, but
  the lease substrate refused peer keys, so `cyberdeck_worker_ctl` and
  `cyberdeck_worker_events` answered `NO_STABLE_CONTROLLER_IDENTITY` for the very
  binding just allowed to instruct that worker, and the worker's own report could
  come back `OWNERSHIP_LOST`. A peer now proves a durable controller identity of
  its own — its own `controllerId`, so two peers of a scope cannot take each
  other's leases, inside its primary's `familyId`, so its workers belong to the
  scope's orchestrator family. Grant and lease are derived from one place:
  `ORCHESTRATOR_GRANT_CAPABILITIES` and a total `orchestratorController()`, which
  replaced four divergent copies of the same rule. Bindings written before the
  record carried a `kind` still load, reading primary or peer from the key's
  `:peer:` marker (MIK-98).

- A pinned thread stays at the top of its folder. Pins outrank last activity
  outright rather than breaking ties between equal timestamps, so a pinned thread
  no longer loses its place the moment a sibling reports newer work. Recency still
  orders the pinned and unpinned groups internally (MIK-63).

- Claude semantic capture follows the conversation across `/clear`. Sessions launch
  with a SessionStart hook that reports the native `transcript_path` against the
  Cyberdeck session id fixed on its command line, so a rebind is exact even when
  several workers share a worktree. An abandoned transcript is detected from the
  `/clear` frame Claude writes into it, and an unresolved successor fails closed
  with a reported status rather than guessing at the newest file in the directory
  (MIK-46).

### Added

- Fleet says which orchestrator owns a worker, in one monochrome glyph at the end
  of the row. Each bound orchestrator gets a deterministic sigil — derived from its
  durable controller identity, so it is the same across redraws, restarts, and
  `--no-color`, with nothing allocated or persisted — and every worker its lease
  currently holds wears the same shape. Ownership is read from the current lease
  controller, so an adopted worker follows its new owner; a dispatched worker with
  no holder gets `⊘` rather than the sigil of the orchestrator that created it; and
  a worker the operator started themselves gets no sigil at all. Selecting an
  orchestrator row also dims every worker it does not own until the selection moves
  away, which adds no keybinding and hides nothing (MIK-85).

### Changed

- The six broker-side lease custody hues are gone, along with the slot ledger, its
  store, and the `fleet.custodyColors` RPC. A hue could say "these rows go
  together" but never which orchestrator, since the only thing to match it against
  was the same hue again, and six palette slots spent on provenance broke the rule
  that color in the thread list carries state alone. Provenance is a shape now, and
  the broker answers `fleet.orchestratorOwnership` with the controller identity each
  bound session speaks for — derived from the binding, so there is nothing to
  reconcile after a crash (MIK-85).

- Thread rows no longer carry the `legacy`, `unowned`, or `adoptable` lease tags.
  They named a lease state an operator has no move to make about, sat on nearly
  every worker row, and took the width the model and state columns needed. A group
  that shares one custody still says so once on its section heading, the five-field
  breakdown is still behind `ctrl+l`, and a `conflict` or `anomaly` — the broker
  contradicting itself — still tags its row. Columns now yield in a fixed order as
  a pane narrows: worktree name, then pull-request number, then title and preview
  to their floors. Model and state are budgeted first and survive the narrowest
  layout (MIK-76).

- Worker model capabilities are read from the provider CLIs rather than kept in a
  hand-maintained list. The broker asks each provider what it currently offers,
  caches the answer briefly, and serves it on `worker.capabilities`; Fleet's
  `/model` composer, the `cyberdeck_provider_capabilities` MCP tool, and the
  launch boundary all read that one answer, so an offered model can no longer be
  a refused one. A provider that cannot be asked — Claude and Codex advertise no
  listing subcommand — keeps the stored catalog, served and rendered as a
  stand-in with the reason attached. The model step of `/model` now filters as
  you type, because a provider listing runs to hundreds of slugs.
- Fleet's model column shows the model a session is running now, read from the
  provider's own transcript, instead of the model it was launched with. A model
  changed inside the provider's CLI is picked up on the next completed turn. A
  leading `~` marks a value that is not a full observation: the provider keeps no
  transcript to read, it has not produced a turn yet, or it named a model without
  an effort.
- Fleet's pull-request indicator is attributed to the branch a thread's own work
  lands on rather than to the directory it runs in. Threads that share a
  repository's primary checkout no longer inherit each other's pull requests: a
  thread is credited with one only through the branch its `workspace` declared,
  or through the linked worktree it runs in. A thread in a shared checkout that
  declared no branch shows nothing.
- The indicator prints the pull request's number — `#123`, between the preview
  and the time — instead of a state glyph. The open/draft/merged/closed/failing
  colourway is unchanged, so state still reads at a glance in color; with color
  off a row now says which pull request it has rather than what state it is in.

### Removed

- The Cursor worker gate is gone: `/cursor-workers`, `cyberdeck orchestrator
  cursor-workers`, the `orchestrator.cursorWorkers` RPC, and the durable
  `worker.start.cursor` capability behind them. Cursor is a first-class provider
  whose full model list the capability catalog serves to every orchestrator, so a
  dispatch that followed what was advertised could still come back
  `CAPABILITY_DENIED` over a switch the catalog never mentioned. A fresh
  orchestrator now starts a Cursor worker with no prior operator toggle. A Cursor
  Fable slug is still gated on `worker.start.fable`, exactly like every other Fable
  model, and the catalog's own notes say so. The retired capability name parses out
  of an existing binding as nothing, so a binding written while the toggle existed
  stays readable (MIK-96). This also retires the remedy `/cursor-workers on` that
  the denial prescribed and Fleet refused to run (MIK-97).

## [0.1.0-alpha.2] - 2026-08-14

### Added

- Tier 1 Scout workers resolve to Cursor Composer with a verified read-only
  boundary, isolated MCP state, structured briefs, bounded execution, and
  broker-owned canonical reports outside the inspected worktree.
- `cyberdeck open` and Fleet's `Ctrl-N` open a worker's worktree in the nvim
  already running in the same tmux window: a `:tcd`-scoped tab with the worker's
  changed files and hunks in that tab's location list. Buffers under a running
  worker's worktree are held read-only, and one push on the worker's terminal
  transition both refreshes the list and releases the lock. The lock is tracked
  per worker, so a finished worker never unlocks files belonging to a second
  worker whose worktree nests inside its own, and a worker that finishes between
  the open and the bind is released rather than left locked. The nvim side ships
  as `contrib/nvim` and needs one `require("cyberdeck").listen()` line.
- A window with no nvim no longer stops the open: nvim is started in that same
  window, split off its rightmost pane so it lands beyond the orchestrator
  attachment rather than between it and Fleet, and the open waits for the new
  nvim to start serving before sending anything. A spawned nvim that never calls
  `listen()` is named as the reason, instead of the request being sent to an
  address nobody answers on.

- Cursor is a full orchestrator provider. Its Ctrl+O entry offers
  `claude-fable-5-thinking-high`, `gpt-5.6-sol-high`, `claude-opus-5-thinking-high`,
  and `kimi-k3-max`, and the Cyberdeck MCP server reaches `agent` — which has no
  MCP flag — through a session-scoped plugin directory and `CURSOR_CONFIG_DIR`
  written under Cyberdeck's private launch-files root and removed on exit. The
  operator's `~/.cursor` and the repository's `.cursor/mcp.json` are never touched
  and `HOME` is never redirected, so provider authentication is unaffected.
  Guidance, which `agent` cannot take as a flag, arrives as the session's first
  submitted message.
- Cursor interactive sessions resume. Launch and resume both name the Cyberdeck
  session id as the chat id, so a broker restart reopens the same conversation
  instead of forcing an orchestrator rebind. A thread launched before chat ids
  were bound refuses to resume rather than presenting a new empty chat under its
  name. Scouts stay one-shot.
- `/cursor-workers status|on|off` and `cyberdeck orchestrator cursor-workers`
  control a durable, default-off `worker.start.cursor` grant per orchestrator
  binding. It composes with the Fable grant rather than replacing it: a Cursor
  Fable slug needs both, and the provider-level refusal is reported first.
- Cursor worker models cover the installed catalog — Composer 2.5, the GPT-5.6
  Luna/Terra/Sol rungs, Sonnet 5, Opus 5, Fable 5, Kimi, GLM, and Grok — as exact
  slugs with the effort rung inside the slug.

### Fixed

- `workers_wait` no longer accepts a timeout it cannot honor. One logical wait is
  served in transport segments that always return before an MCP client abandons
  the call, carrying an explicit `wait.state` of `settled`, `timed-out`, or
  `incomplete` plus a `waitId` to resume.
- A completed `sessionId` and `completionTarget` is retrievable idempotently after
  a transport failure and is marked `retrieval: "replay"`, so an orchestrator can
  rule out a duplicate mutation without reading a raw transcript.
- MCP requests are dispatched concurrently, so `threads_list` stays answerable
  while a worker wait is in flight instead of queueing behind it.
- A control-plane failure is reported as its own structured class rather than as
  an ambiguous worker outcome.

### Changed

- `threads_list` takes `view`, `limit`, and `cursor`, defaults to a status-only
  projection, and returns a paged envelope. The full view drops `launchRecord` and
  bounds `latestPreview`.
- Batch worker starts now prepare independent standard and Scout workers
  concurrently while reserving capacity before provider launch.
- The `/model` picker scrolls, keeping the selected row on screen now that the
  Cursor catalog is longer than a terminal.
- The bare `composer` worker slug is retired in favor of `composer-2.5`, the
  identifier `agent models` actually advertises.

## [0.1.0-alpha.1] - 2026-07-23

### Added

- Provider-neutral local broker for durable Codex, Claude, Cursor, and
  Antigravity terminal sessions.
- Interactive Fleet and optional tmux cockpit views without transferring
  process ownership away from the broker.
- Explicit provider, model, effort, sandbox, orchestration, worker, workflow,
  budget, and concurrency controls.
- Durable session metadata, transcripts, preferences, job records, artifacts,
  recovery, and provider-native resume where supported.
- Session-scoped MCP tools for bounded worker orchestration and report-back.

### Security and privacy

- Real provider and model calls are never part of the deterministic test suite.
- Fable worker launches remain default-off and require an explicit operator
  grant.
- Transcript and state persistence is local to the current macOS user.

### Known limitations

- This developer preview supports macOS only.
- Users must install and authenticate each provider CLI independently.
- Cursor and Antigravity session resume remain unsupported; some launch paths
  are fixture-proven but not yet live-verified across all provider versions.
- Provider CLI behavior and supported model identifiers can change independently
  of Cyberdeck.

[Unreleased]: https://github.com/Brandon1138/cyberdeck/compare/v0.1.0-alpha.3...HEAD
[0.1.0-alpha.3]: https://github.com/Brandon1138/cyberdeck/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/Brandon1138/cyberdeck/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/Brandon1138/cyberdeck/releases/tag/v0.1.0-alpha.1
