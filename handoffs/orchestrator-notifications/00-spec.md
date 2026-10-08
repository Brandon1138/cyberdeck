# Specification: orchestrator notification feed

## 1. Operator requirement

The orchestrator should not have to block in `cyberdeck_workers_wait` to find out that a worker finished, got stuck, or raised something steerable. It should keep working and be told, cheaply, when there is something to act on. It must work whatever the orchestrator's provider is (Claude Code, Codex, Cursor, and any future OpenRouter-backed CLI) and whatever the workers' providers are, because Cyberdeck is provider-native on both sides. It must not disturb other orchestrators sharing the broker.

## 2. What Claude Code does natively (the feature the operator saw)

Verified against the current docs on 2026-10-07 (Claude Code 2.1.280 installed).

| Mechanism | Behaviour | Source |
| --- | --- | --- |
| Background subagents | "Background subagents run concurrently while the parent conversation continues working." "A background subagent's results reach Claude as a completion notification in a later turn." | [sub-agents docs](https://code.claude.com/docs/en/sub-agents) |
| Background commands and `Monitor` | Each stdout line of a monitor script becomes an event; "notifications arrive in the chat"; lines within 200 ms are batched into one notification. A background Bash command sends one completion notification when it exits. | Monitor tool contract |
| Cross-session `SendMessage` | "messages enqueue and drain at the receiver's next tool round"; `notify_when_idle` yields exactly one idle notice. | SendMessage tool contract |
| `ReadNotifications` | Payload stays in a queue; the model only sees "a system notice says notifications are pending" and drains with one call, oldest first, with a remaining count. | ReadNotifications tool contract |
| Artifact comment watches | A comment "sent to Claude" on a watched artifact "wakes this session". | ArtifactComments contract |
| Hooks | `PostToolUse`, `PostToolBatch`, `Stop`, `UserPromptSubmit` return `hookSpecificOutput.additionalContext` (system reminder on the next model request, 10,000 chars). `Stop` may return `decision: "block"` with a reason to continue the turn. Hook option `asyncRewake` runs a command in the background and wakes Claude with the hook's stderr when it exits 2. MCP tools match hooks as `mcp__<server>__<tool>`. | [hooks reference](https://code.claude.com/docs/en/hooks) |

Shape of the delivered item: an automated event, not a user message, injected at the parent's next model request if the parent is mid-turn, or starting a new turn if the parent is idle. Claude Code's own implementation has recorded weaknesses that a Cyberdeck design must not copy: notifications dropped when the child finishes while the parent is mid-turn processing another child ([#86365](https://github.com/anthropics/claude-code/issues/86365)), notifications withheld until the parent is revived by other means ([#87689](https://github.com/anthropics/claude-code/issues/87689)), and duplicate deliveries per completion ([#95601](https://github.com/anthropics/claude-code/issues/95601)). These are all consequences of in-memory, fire-and-forget delivery. Cyberdeck already solves the same problem for directed handoffs with durable, cursor-acknowledged, at-least-once delivery; the feed reuses that discipline.

Why it cannot simply be used: the watcher is internal to the Claude Code process and only observes its own Agent, Bash and Monitor tasks. A Cyberdeck worker is a separate provider process, and a Cyberdeck orchestrator may not be Claude Code at all.

## 3. What each provider CLI exposes (verified 2026-10-07)

| Provider | In-turn context injection | Idle continuation | Where Cyberdeck already controls the config |
| --- | --- | --- | --- |
| Claude Code 2.1.280 | `PostToolUse` / `PostToolBatch` `additionalContext` | `Stop` hook (`additionalContext`, or `decision: block`), `asyncRewake` hooks | `src/providers/claude/launch-settings.ts` builds the one `--settings` file an orchestrator launches with; it already carries a `SessionStart` hook (`transcript-hook.ts`). |
| Codex CLI 0.160.1 | `PostToolUse`, `UserPromptSubmit`, `PreToolUse` `additionalContext` | `Stop` / `SubagentStop` can inject a continuation prompt | `src/providers/codex/orchestrator-home.ts` materialises a managed `hooks.json` in the orchestrator's `CODEX_HOME`. Hooks apply to TUI and app-server. ([docs](https://learn.chatgpt.com/docs/hooks)) |
| Cursor agent 2026.10.01 | `postToolUse` / `postToolUseFailure` `additional_context` | `stop` hook `followup_message` auto-submits the next user message | Not managed today. Hooks live in `~/.cursor/hooks.json` (shared with the operator) or `<project>/.cursor/hooks.json`. ([docs](https://cursor.com/docs/agent/hooks)) **PENDING** spike. |
| Antigravity / OpenRouter-backed CLIs | unknown | unknown | none |

Conclusion: every supported orchestrator provider can take a notice next to a tool result through hooks, and all three have an idle-continuation hook. None of this is required for correctness, because the universal path below does not depend on hooks at all.

## 4. What Cyberdeck already has (seams, all read on main `60c2905`)

- **One truth projection.** `src/domain/worker-truth.ts` and `docs/architecture/worker-truth.md`: worker states (`working`, `blocked-modal`, `blocked-composer`, `idle`, `stalled`, terminal `provider-limit|errored|stopped|exited|failed`), instruction lifecycle (`accepted → queued → rendered → submitted → acknowledged → completed`, or `undelivered`), `completedTurns` / `canonicalTurns`. Every surface renders this; the feed must too.
- **Worker events.** `src/broker/worker-event-channel.ts` and `worker-coordination.ts`: idempotent, sequenced, bounded `PROGRESS|EXCEPTION|RISK|DECISION_REQUEST|CHECKPOINT` events with coalescing and pinned intervention events; `projectEvents` filters; `projectWaitInterventions` in `src/orchestration/worker-intervention-wait.ts` already produces the bounded summary a wait returns.
- **Durable at-least-once delivery pattern.** Directed handoffs: `worker_events` returns at most one oldest pending handoff, acknowledged by id on a later poll, fsynced before the next page (`docs/architecture/worker-coordination.md`). Same discipline wanted here.
- **Controller identity.** `orchestratorController` in `src/domain/orchestrator.ts`; leases bind workers to a durable controller, not a conversation UUID. The feed routes by controller.
- **Instruction queue.** `src/orchestration/instruction-queue.ts` + `SessionRegistry.submitInstruction` (`session-io-surface.ts:142`): writes provider input at a safe boundary only, holds with `provider-busy`, `composer-occupied`, `provider-modal`, `human-controller`; `enqueueBroker` exists for broker-owned policy instructions with deterministic `messageId` (used by the budget enforcer's wrap-up nudge). Workflow `wake: true` already uses this path to prompt *any* participant, orchestrators included (`workflow-service.ts:126`). This is the universal idle-wake channel.
- **Tool-result envelope.** `src/mcp/server.ts:609-617`: every `tools/call` result is one JSON text block, and a second block `{cyberdeckWarning: drift}` is appended when the conversation drifted. This is the universal in-turn notice channel.
- **Wait loop.** `agent-control-service.ts:938` `waitForWorkers`: 90-second segments, optional `settleOnIntervention` polling `projectWaitInterventions` every `interventionPollMs`. The feed does not replace it; it makes it optional.
- **Broker push to clients.** `src/broker/server.ts:175` already keeps per-connection subscriptions (local worker telemetry). The MCP server process is a broker client, so a subscription from MCP server to broker is possible, but it is not needed for v1 (see 5.4).
- **Registry bus.** `session-ports.ts:163-165`: `onControllerReleased`, `onDeliveryBoundary`, `onInstructionState`. Lifecycle/truth transition hooks exist on the registry side (the enforcer and reconciler consume them); the exact subscription surface to extend is **PENDING** inspection by Task B's worker.
- **Orchestrator prompt.** `src/orchestration/orchestrator-manager.ts:444-445` is the text that tells orchestrators to call `cyberdeck_workers_wait` once and not poll. It has to describe the feed.

## 5. Design

### 5.1 Vocabulary

- **Notification**: one bounded, durable record addressed to a controller: `{id, cursor, controllerId, kind, severity, sessionId, workerId?, taskId?, waveId?, summary (≤512 chars), refs[], createdAt, wakeEligible, noticedAt?, deliveredVia[], acknowledgedAt?}`.
- **Notice**: the ≤200-character line the orchestrator sees unasked: `cyberdeck: 3 notifications pending (1 decision-request, 2 settled, oldest 40s) → cyberdeck_notifications_read`. Severity `critical` and `DECISION_REQUEST` may inline one summary (≤400 chars total). The payload never travels unasked.
- **Drain**: `cyberdeck_notifications_read` returning records from a cursor, acknowledging the previous page.
- **Wake**: delivering a notice to an idle orchestrator so it starts a turn.

### 5.2 Producers (what becomes a notification)

Derived only from state the broker already holds; no new scraping.

| Trigger (existing source) | Kind | Default severity | Wake-eligible |
| --- | --- | --- | --- |
| Worker truth reaches terminal, or `completedTurns` reaches a completion target an orchestrator has outstanding | `settled` | info | yes |
| `DECISION_REQUEST`, `EXCEPTION` with `interventionRequired`, decision-gate `CHECKPOINT` | `intervention` | error/critical as submitted | yes |
| Worker truth enters `blocked-modal` or `stalled` | `attention` | warning | yes (modal), notice-only (stalled, coalesced) |
| Instruction becomes `undelivered`, or `queued` with hold `human-controller` for the orchestrator's own instruction | `delivery` | warning | yes |
| `RISK` event | `risk` | as submitted | critical only |
| `PROGRESS` event, `CHECKPOINT` answer (non-gate) | `progress` | info | no (notice-only, coalesced per worker to the latest) |
| Budget soft limit reached for a worker (`worker-budget-enforcer.ts`) | `budget` | warning | no |
| Pending directed handoff | `handoff` | info | yes |
| Scout wave digest complete (`scout-wave-digest.ts`) | `settled` | info | yes |

Routing: the controller holding the worker's lease at the time of the event. A transfer moves future notifications; already-recorded ones stay with the controller that owned the lease when they were written (they are audit, not a mailbox the new owner needs). Peers see only workers inside their grant, enforced with the same `thread.read` check `waitForWorkers` uses.

### 5.3 Inbox (durability)

One append-only JSONL per controller family under the existing orchestration state directory, written with the same fsync/replay discipline as `worker-coordination-v1.jsonl`. Monotonic per-controller cursor. Rate and size bounds: per-worker coalescing of `progress`/`stalled`, a hard cap on unacknowledged records per controller (oldest `progress` records are dropped first and the drop is itself counted in the notice), payload limits identical to worker events. A broker restart replays the inbox; nothing pending is lost.

### 5.4 Delivery (the token-economy part)

Two conditions, two channels each. Tier A is universal and mandatory; tier B is a per-provider enhancement that must degrade to tier A silently.

**Orchestrator is mid-turn (busy).**
- A. **Tool-result piggyback.** `server.ts` `tools/call` appends a `{cyberdeckNotice: ...}` text block to every `cyberdeck_*` result when the controller has pending notifications whose notice has not been shown since the inbox last changed. Debounce by `(lastNoticedCursor, lastNoticedAt)`: repeat only when the pending set changed or after a quiet interval (default 10 minutes). Cost: one short line, roughly 40 to 60 tokens, only when something changed.
- B. **Provider `PostToolUse` hook** on every tool (not just Cyberdeck's): the hook command `cyberdeck notifications notice --actor-session <id>` prints the notice JSON for the provider's `additionalContext`. To keep the per-tool-call cost near zero, the broker maintains a tiny notice file per orchestrator (`<state>/orchestrators/<session>/notice.json`) and the hook reads that file without a socket round-trip; a missing or stale file prints nothing. Same debounce state as tier A so the two channels do not double-notice.

**Orchestrator is idle (at its prompt).**
- A. **Instruction-queue wake.** The feed enqueues a broker-owned instruction (`enqueueBroker`, deterministic `messageId = notice:<controller>:<cursor>`) whose text is the notice. `submitInstruction` guarantees the properties that make this safe: `provider-busy` means it never lands inside a running turn, `human-controller` means an attached human keeps priority, `composer-occupied` and `provider-modal` hold it, and a terminal orchestrator yields `undelivered` rather than a silent drop. Coalescing window before enqueueing (default 3 seconds, cf. Claude's 200 ms batching; longer here because provider turns are seconds, not milliseconds). If the orchestrator becomes busy before delivery, the queued wake is withdrawn (`cancelled`) and tier A busy-path delivery takes over, so a wake never arrives after the orchestrator already drained.
- B. **Provider idle hooks** (Claude `Stop` with `additionalContext`/`block`, Cursor `stop` `followup_message`, Codex `Stop` continuation): same notice, consumed only when the inbox has wake-eligible records; `asyncRewake` on Claude is the one mechanism that can wake a truly idle session from inside the harness without the composer, and is the preferred Claude path if the spike confirms it. **PENDING** spike results decide which of these ship in v1.

**Wake budget.** Wakes spend orchestrator tokens, so they are governed: per-orchestrator policy `wake: all | steering-only | off` (default `steering-only`, meaning `settled`, `intervention`, `attention(modal)`, `delivery`, `handoff`, `critical`), a wake rate ceiling (default 12 per hour, with the ceiling itself producing one `budget` notice when hit), and a per-notice `wakeEligible` flag computed at record time. Set through `cyberdeck_notifications_configure` and the CLI; persisted on the orchestrator binding so it survives restarts.

### 5.5 Consumption

- `cyberdeck_notifications_read {cursor?, limit≤50, acknowledgeThrough?, kinds?, severities?}` → `{notifications[], nextCursor, pending, dropped}`. Settled records carry the same bounded result shape `workers_wait` returns for that worker (`truth`, `completedTurns`, `canonicalTurns`, bounded result text with `retrieval: "notification"`), so a drain can replace a wait. Acknowledgement is by cursor on the next call, like handoffs: a lost response replays.
- `cyberdeck_notifications_configure {wake?, quietMinutes?, maxWakesPerHour?}`.
- Reading, acknowledging or configuring never changes worker lifecycle or leases.
- `cyberdeck_workers_wait` stays. A result delivered by wait (`settled` or `replay`) marks the matching `settled` notification acknowledged, and a notification drained first makes a later wait on the same target answer with `retrieval: "replay"`. One truth, two readers.

### 5.6 Prompt contract (orchestrator-facing)

Replace the "call `cyberdeck_workers_wait` once; do not poll" sentence pair with: start workers, continue with other work, and treat a `cyberdeckNotice` next to any tool result or a wake at the prompt as the signal to call `cyberdeck_notifications_read`; wait is for a deliberate synchronous join; never poll `notifications_read` on a timer. The Claude harness's own notices for `ReadNotifications` are the model for the wording.

### 5.7 Non-goals and invariants kept

- No tmux typing, no pane scraping, no raw transcript in any notice.
- Human control keeps priority on every channel; an attached human means no wake, only the busy-path notice when the orchestrator next calls a tool.
- Other orchestrators on the same broker are unaffected: inboxes are per controller, wakes target only the owning orchestrator session, and nothing changes how workers behave.
- No new transport: MCP tool results, hooks and the instruction queue are the only delivery surfaces.
- Worker-side reporting (`cyberdeck_report_progress` etc.) is unchanged; workers never learn anything about the orchestrator's inbox.
- The existing `settleOnIntervention` wait mode stays until the feed has shipped and been used for a while; retiring it is a later decision.

## 6. Open questions (defaults stated, not blocking)

1. Default wake policy: `steering-only` as in 5.4. Alternative `all` wakes on progress too, which is what the operator may expect from the Claude Code behaviour, at a token cost.
2. Whether a composer-delivered wake should be visually distinct in the orchestrator transcript (prefix `[cyberdeck notice]`). Default yes; the instruction record is already `brokerOwned` and `source: "broker"`.
3. Cursor orchestrators: managed project-level `.cursor/hooks.json` pollutes the repo; user-level file is the operator's own. Default: tier A only for Cursor orchestrators in v1 unless the spike finds a per-launch hooks flag.
4. Whether `notifications_read` should also be the single place `worker_events` handoffs surface. Default: no change to `worker_events` in v1; handoffs additionally produce a `handoff` notification.
