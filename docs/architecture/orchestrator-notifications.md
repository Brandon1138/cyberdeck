# Orchestrator notification feed

> **Status: IN PROGRESS.** Implementation of the plan under
> [`handoffs/orchestrator-notifications/`](../../handoffs/orchestrator-notifications/README.md).
> This document records every decision the plan left **PENDING**, in the order they were settled,
> and then describes the shipped design. The plan is the requirement; this is the record of how it
> was met and where it was deliberately reduced.

## Decision log

Each entry names the PENDING item, the decision, and why. Dates are 2026-10-07 unless stated.

### D1. Task branch naming

Plan: `feat/orchestrator-notification-feed/<task>`. Git refuses that name: `feat/orchestrator-notification-feed`
already exists as a ref, and a ref cannot be both a file and a directory in the ref namespace
(`cannot lock ref ... exists; cannot create`). Task branches are therefore
`feat/orchestrator-notification-feed--<task>` (double dash), cut from the integration branch.

### D2. Baseline commit

Plan was written against main `60c2905`. At execution time local main was `b112758` and
`origin/main` was `f1619a5` (MIK-256 peer orchestrators, which touches the MCP dispatcher). The
integration branch is cut from `origin/main` `f1619a5` so the pull request diffs against the branch
it will merge into. The operator's main checkout and its unrelated uncommitted edits were not touched.

### D3. Registry bus surface for the producer

Plan: identify the registry surface the enforcer and reconciler already use; extend
`session-ports.ts` only if nothing fits. Nothing needs extending:

- Worker truth transitions: `SessionRegistry.onSessionUpdate(sessionId)` fires on every runtime
  change (turn completion, exit, fault, attention change, modal open or close) and
  `registry.workerTruth(sessionId)` projects the one truth. The producer keeps the last truth it saw
  per session and emits on edges, exactly as `WorkerBudgetEnforcer` does.
- Instruction transitions: `registry.onInstructionState(update)` only announces transitions the
  provider was observed to take (rendered, submitted, acknowledged, completed). The holds and the
  `undelivered` verdict are written by `InstructionQueue` itself through its `InstructionRepository`,
  so the producer watches the repository instead: `observeInstructionRepository(store, onPut)` in
  `src/orchestration/observed-instruction-repository.ts` wraps the repository main.ts hands the
  queue and reports every persisted record after the write. One write path, one observer, every
  state.

### D4. Observing worker events and handoffs without forking the event path

`WorkerCoordinationService` has no event listener and its file sits at its file-size ratchet ceiling
(2807 lines), so it cannot grow. The producer observes events through a subclass composed in
`main.ts` (`ObservedWorkerCoordinationService`) that overrides `submitEvent` and `handoffBatch`,
calls `super`, and notifies listeners only after the fsynced result returns with an accepted or
superseded acknowledgement. One event path, one fsync, one extra virtual dispatch.

### D5. Instruction withdrawal for wake cancellation

`docs/architecture/worker-truth.md` lists `accepted|queued --withdrawn--> cancelled`, but
`InstructionQueue` had no API that takes that transition. Added
`InstructionQueue.withdraw(targetSessionId, messageId)`: inside the per-target serialization it moves
an `accepted` or `queued` record to `cancelled` and returns it; any other state returns the record
unchanged (a rendered payload cannot be unwritten). Delivery uses it to withdraw a wake when the
orchestrator became busy first.

### D6. Inbox-change signal between producer and delivery

The store exposes `onChange(listener(controllerId))`, fired after every fsynced mutation. Delivery
subscribes to the store, not to the producer, so the two services share no interface beyond the
store and can be built and tested independently.

### D7. Tool-result piggyback mechanics

The MCP server process is a broker client, not a broker, so it cannot read the inbox. After every
`tools/call` except `cyberdeck_notifications_read`, `cyberdeck_notifications_configure` and
`cyberdeck_diagnose`, the server issues one extra local RPC `agent.notifications.notice
{actorSessionId}`; the broker answers with the rendered notice when `shouldNotice` holds and marks it
noticed in the same call. A failed notice RPC is swallowed: the tool result is unchanged and no
notice is fabricated. Cost: one Unix-socket round trip per tool call, no model tokens unless there
is something to say.

### D8. Hook notice file and shared debounce

The hook path must not open a socket (plan §5.4 B). Delivery rewrites
`<state>/orchestrators/<orchestratorSessionId>/notice.json` atomically on every inbox change for
that controller and deletes it when nothing is pending. The hook CLI prints the notice only when
`notice.json.cursor` is greater than the cursor in its own sidecar
`<same dir>/notice-shown.json`, which it then writes. The broker's `shouldNotice` reads that sidecar
too, so a notice shown by a hook is not repeated on the next tool result, and vice versa (the broker
rewrites `notice.json` with `noticedCursor` when it piggybacks). Both files are small JSON; a missing,
stale or unreadable file means the hook prints nothing and exits 0.

### D9. Routing when a worker has no live controller

Records are addressed to the controller holding the worker's lease at write time. A worker whose
lease is orphaned is routed to `subject.origin.creatorControllerId`: that is the family that will
normally adopt it after a `/clear`, and it keeps the record inside the orchestrator family that
started the work. Already-written records never move on transfer or adoption (plan §5.2).

### D10. What `settled` is keyed on

The producer tracks outstanding completion targets per worker: `1` at start, plus the
`expectedTurn` of every instruction rendered for that worker by its controller. When
`truth.completedTurns` reaches an outstanding target, one `settled` record is written with
`dedupeKey = settled:<sessionId>:<target>` (write-once). When truth reaches a terminal state, one
`settled` record with `dedupeKey = settled:<sessionId>:terminal` is written, carrying the lowest
unreached target when there is one (the one a waiting orchestrator is most likely blocked on). `cyberdeck_workers_wait` acknowledges the matching key when it
delivers a completed or terminal result (`deliveredVia: ["wait"]`), and a drained `settled` record
calls `waitForWorkerResults` for its single target so the completion ledger counts the delivery and
a later wait answers `retrieval: "replay"`.

### D11. Scout wave digests

Plan §5.2 lists "Scout wave digest complete" as a producer. The digest is a projection computed
inside `waitForWorkers` over the set of targets the caller named; there is no broker-side event for
"the wave is complete" because the wave is defined by the caller. v1 therefore emits one `settled`
record per Scout (summary notes the profile and the decision-card state) and leaves the digest to
`cyberdeck_workers_wait`. Revisit if waves become a broker-side object.

### D12. Codex orchestrator hooks: tier A only in v1

On the committed tree there is no managed Codex orchestrator `hooks.json` (the file the plan cites,
`src/providers/codex/orchestrator-home.ts`, is an uncommitted local edit in the operator's main
checkout; Codex sessions run with the operator's own `CODEX_HOME`). The spike could not exercise a
Codex hook either: an untrusted `hooks.json` is skipped silently and `--dangerously-bypass-hook-trust`
was refused to the spike session. Codex orchestrators therefore get the universal channels only
(tool-result piggyback and instruction-queue wake). The provisional Codex hook JSON and the scripted
host tests are recorded in `docs/architecture/provider-parity.md`; building it needs a managed
`CODEX_HOME` and an operator decision on hook trust.

### D13. Unacknowledged-record cap

Settled by Task A: `NOTIFICATION_LIMITS.maxUnacknowledgedPerController = 200`, below the
worker-event active queue's default of 256 and four drain pages deep; progress and other
notice-only kinds are dropped first, and every drop is counted and reported.

### D14. Cursor orchestrators get hooks through the session plugin

The plan's default (spec open question 3) was tier A only for Cursor. The spike found a per-launch
mechanism Cyberdeck already owns: `--plugin-dir` on the session-scoped plugin that
`src/providers/cursor/mcp-hosting.ts` builds to host the MCP server. A `hooks/hooks.json` in that
plugin loads for that launch only, headless and interactive, with no write to the workspace,
`~/.cursor` or `~/.claude`. v1 generates `postToolUse` and `postToolUseFailure` there (Shell
failures fire the failure event, MCP `isError` results fire `postToolUse`), no `stop` hook (it never
fired from a plugin, and its `followup_message` is only a user turn, which the tier A wake already
sends).

### D15. The hook entry point imports nothing from the CLI graph

Measured on this host: bare `node` ≈0.2 s, `node dist/src/cli.js --version` ≈1.3 s, the pnpm
wrapper 3.5 to 5.2 s cold. PostToolUse runs on every tool call with a 2 s budget, so the hook
command is a dedicated entry, `src/cli/notice-hook-entry.ts`, that imports only the notice-file
reader and the domain module; `cyberdeck notifications notice` stays as the operator-facing form of
the same code.

### D16. What the hook repeats

The spike's reading was that a read-only hook must repeat the notice on every tool call until the
drain empties the file. The shipped hook writes one sidecar (`notice-shown.json`) and so repeats a
notice only when the inbox head moved past the cursor it last showed, or when the quiet interval
the broker wrote into `notice.json` has elapsed since it showed it. The broker's tool-result path
reads the same sidecar, so the two channels never show one change twice. Claude's `Stop` hook is
guarded by `stop_hook_active` so a pending notice buys exactly one extra turn, never a loop.

### D17. No asyncRewake in v1

It works (an idle interactive Claude session woke about 10 ms after the hook exited 2), but a wake
from it needs a hook process that stays alive until a notice exists, which breaks the read-and-print
rule and re-enters Stop. The instruction-queue wake covers idle sessions for every provider;
asyncRewake is the fallback if that wake proves unreliable in practice.

## Design

```text
registry truth edges ─┐
worker events ────────┤  OrchestratorNotificationProducer      OrchestratorNotificationDelivery
handoffs ─────────────┼──► (src/broker) ──append──► inbox ──onChange──► (src/broker)
budget soft limit ────┤                              │                    ├─ notice.json (hook reads)
instruction holds ────┘                              │                    ├─ agent.notifications.notice (tool result)
                                                     │                    └─ enqueueBroker wake (idle) / withdraw
                         cyberdeck_notifications_read ┘◄── OrchestratorNotificationControlPlane (src/orchestration)
```

### Domain (`src/domain/orchestrator-notification.ts`)

Kinds, the record schema (`cursor` per controller, `dedupeKey`, `wakeEligible`, `deliveredVia`),
the policy, `buildNotice` and `renderNotice` (≤200 chars, ≤400 with one inlined intervention or
critical summary, always naming the drain tool), `wakeEligible`, and the two key makers
`settledDedupeKey` and `coalescedDedupeKey`. `src/domain/orchestrator-notice-file.ts` is the hook
side: the `notice.json` and `notice-shown.json` shapes and the provider envelope renderer.

### Inbox (`src/persistence/orchestrator-notification-store.ts`)

Append-only JSONL, one fsynced record per mutation (`append`, `replace`, `acknowledge`, `deliver`,
`drop`, `notice`, `policy`), replayed by `load()` and failing closed on corruption like the
coordination log. `dedupe: "once"` makes `settled` idempotent across restarts; `dedupe: "replace"`
coalesces `progress` and stalled `attention` to the latest per worker. Over the 200-record cap the
oldest notice-only records are dropped first and every drop is counted and reported on the next
notice and drain. `onChange` fires after the fsync; application code sees the store only through
`NotificationInboxPort`.

### Producer (`src/broker/orchestrator-notification-producer.ts`)

Subscribes to `registry.onSessionUpdate` (truth edges per worker: targets reached, terminal, modal,
stalled), to the observed coordination substrate (`onEventSubmitted`, `onHandoffCommitted`,
`onBudgetUpdate`), and to the observed instruction repository (holds and `undelivered`). Routes to
the lease holder, then the origin creator, then the parent binding. Worker sessions only. A
start-time sweep re-emits reached and terminal settlements (idempotent) and seeds the rest.

### Delivery (`src/broker/orchestrator-notification-delivery.ts`)

On every inbox change: rewrite or remove the controller's `notice.json`; if a wake-eligible record
is newer than the last notice and the policy allows, start one coalescing timer per controller.
When it fires: no wake if the orchestrator is `working` (the tool-result path carries it) or the
hook sidecar already showed the head; otherwise `enqueueBroker` a `[cyberdeck notice]` line with
`messageId = stableUuid("notice:<controller>:<head>")`. A `rendered` or later record counts as
delivered (`deliveredVia: ["wake"]`); a `queued` one is remembered and withdrawn through
`InstructionQueue.withdraw` if the orchestrator starts a turn or drains first. The busy path,
`notice(controllerId)`, applies the debounce (head moved past the last notice from either channel,
or the quiet interval elapsed), marks the page delivered via `tool-result`, and returns the rendered
notice. Wakes are counted per rolling hour; the ceiling writes one `budget` record and suppresses
wakes until the window moves.

### Control plane (`src/orchestration/orchestrator-notification-control.ts`)

`agent.notifications.read` (cursor, limit ≤50, `acknowledgeThrough`, kind and severity filters,
`thread.read` grant filtering per worker, settled records embed the single-target wait result with
`retrieval: "notification"`), `agent.notifications.configure` (explicit partial patch merged over the
stored policy), `agent.notifications.notice` (the busy path). The MCP server exposes the first two
as `cyberdeck_notifications_read` and `cyberdeck_notifications_configure` and calls the third after
every other tool call, appending `{cyberdeckNotice}` when there is one and swallowing failures.
`AgentControlService.waitForWorkers` consumes the settled record of every target it delivers.

### Hooks

`cli/notice-hook-entry.js --actor-session <id> --state-directory <dir> --format <provider> --event <E>`
reads `notice.json` and the sidecar, prints the provider envelope at most once per inbox head (or
again after the quiet interval), guards Claude's `Stop` re-entry, and always exits 0. Provider
generation is in `src/providers/claude/launch-settings.ts` (orchestrators only) and the Cursor
session plugin written by `src/providers/cursor/mcp-hosting.ts`.

### Composition

`composeOrchestratorNotificationFeed` in `src/broker/orchestrator-notification-feed.ts` builds the
three services from ports; `src/broker/main.ts` constructs the inbox store, the notice-file
adapter, the observed coordination service and the observed instruction repository, starts the
feed after the instruction queue, hands the inbox to `AgentControlService` and the control plane to
the broker server, and stops the feed on shutdown.
