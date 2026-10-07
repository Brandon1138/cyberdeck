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
- Instruction transitions: `registry.onInstructionState(update)` carries `undelivered` and the
  `queued` holds; the record (actor, target, `expectedTurn`, `brokerOwned`, `holdReason`) is read
  back through `InstructionQueue.list(targetSessionId)`.

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
`settled` record with `dedupeKey = settled:<sessionId>:terminal` is written, carrying the highest
unreached target when there is one. `cyberdeck_workers_wait` acknowledges the matching key when it
delivers a completed or terminal result (`deliveredVia: ["wait"]`), and a drained `settled` record
calls `waitForWorkerResults` for its single target so the completion ledger counts the delivery and
a later wait answers `retrieval: "replay"`.

### D11. Scout wave digests

Plan §5.2 lists "Scout wave digest complete" as a producer. The digest is a projection computed
inside `waitForWorkers` over the set of targets the caller named; there is no broker-side event for
"the wave is complete" because the wave is defined by the caller. v1 therefore emits one `settled`
record per Scout (summary notes the profile and the decision-card state) and leaves the digest to
`cyberdeck_workers_wait`. Revisit if waves become a broker-side object.

### D12. Codex orchestrator hooks

On the committed tree there is no managed Codex orchestrator `hooks.json` (the file the plan cites,
`src/providers/codex/orchestrator-home.ts`, is an uncommitted local edit in the operator's main
checkout). Task E scopes Codex hooks to what the branch can own; the spike's matrix decides whether
that is a managed `hooks.json` written next to the orchestrator's `CODEX_HOME` by the Codex adapter,
or tier A only until that file lands.

### D13. Unacknowledged-record cap

Settled by Task A in `NOTIFICATION_LIMITS.maxUnacknowledgedPerController`, with the reasoning in its
doc comment.

## Design

(Filled in as tasks land: domain and store, producer, delivery, control plane, hooks, prompt.)
