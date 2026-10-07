# Orchestrator notification feed: acceptance

Report scripted runtime, test broker and live broker evidence separately. Do not promote one to the next.

## Behaviours that must hold

| # | Behaviour | Evidence | Scripted (vitest, 2026-10-07) | Test broker (real BrokerServer, temp state dir + socket, fake PTYs) | Live broker |
| --- | --- | --- | --- | --- | --- |
| 1 | Worker settles while the orchestrator is mid-turn calling Cyberdeck tools: the next `cyberdeck_*` result carries one `cyberdeckNotice`; no further notice until the inbox changes or `quietMinutes` pass | MCP integration test; live transcript | PASS: `tests/mcp/notification-tools.test.ts` (piggyback once, exempt tools, failure swallowed); `tests/broker/orchestrator-notification-delivery.test.ts` (debounce, quiet interval with fake clock) | PASS: `tests/broker/orchestrator-notification-feed.test.ts` "settles a worker … notices once" (`agent.notifications.notice` answers once, then `{}`) | not run (operator step) |
| 2 | Worker settles while the orchestrator is mid-turn calling only non-Cyberdeck tools (Claude, Codex): the provider `PostToolUse` hook delivers the notice next to that tool result | live transcript per provider from Task S matrix | PASS for the hook itself: `tests/cli/notice-hook-entry.test.ts`, `tests/cli/notifications.test.ts`; provider generation per Task E tests. Spike evidence (Claude yes, Cursor yes, Codex untested) in `docs/architecture/provider-parity.md` | n/a (needs a provider process) | not run; Codex is tier A only in v1 (D12) |
| 3 | Worker settles while the orchestrator is idle: a `[cyberdeck notice]` line is submitted at the prompt within `coalesceMs` plus one boundary, and the orchestrator's next turn drains it | instruction record `rendered→submitted→completed` with `brokerOwned: true`; transcript | PASS: delivery test rows 3 (one `enqueueBroker` after `coalesceMs`, deterministic messageId, `deliveredVia: ["wake"]`) | PASS: feed test "wakes an idle orchestrator" (one `brokerOwned` instruction, `[cyberdeck notice] …`, no duplicate on the same head). `submitted/completed` need a real provider | not run |
| 4 | Orchestrator starts a turn before the wake is submitted: the wake is `cancelled`, and the notice arrives through channel 1 or 2 instead; never both | instruction records; transcript shows one notice | PASS: delivery test row 4 (working before the timer → no enqueue; working while queued → `withdraw`, later `notice()` once); `tests/orchestration/instruction-queue.test.ts` (`withdraw` → `cancelled`) | covered by unit layer (fake PTYs cannot put the orchestrator mid-turn) | not run |
| 5 | Human attached to the orchestrator thread: no wake (`queued/human-controller`), notice still shows on the next tool result | registry test with controller held | PASS: delivery test row 5 | PASS: feed test "holds the wake while a human controls the orchestrator" (`session.attach` then wake `queued/human-controller`, notice still answered) | not run |
| 6 | `DECISION_REQUEST` from a worker: wake-eligible, inlined summary ≤400 chars, drain returns the full bounded event | unit + live | PASS: `tests/broker/orchestrator-notification-producer.test.ts` (intervention record, wake-eligible); `tests/domain/orchestrator-notification.test.ts` (inline ≤400) | not exercised (worker events need a lease credential) | not run |
| 7 | Instruction to a worker becomes `undelivered`: `delivery` notification, wake-eligible | unit | PASS: producer test (undelivered → delivery, wake-eligible; brokerOwned and orchestrator targets excluded) | — | — |
| 8 | Ten `PROGRESS` events from one worker: one `progress` record (latest), notice-only, never a wake | unit | PASS: producer test and `tests/persistence/orchestrator-notification-store.test.ts` (replace coalescing) | — | — |
| 9 | `wake: off`: no instruction is ever enqueued; notices still piggyback | unit | PASS: delivery test row 9 | PASS: feed test rows 1/13/14 run with `wake: off` through `agent.notifications.configure` and still notice | — |
| 10 | `maxWakesPerHour` exceeded: one `budget` record, wakes suppressed until the window moves | unit with fake clock | PASS: delivery test row 10, `orchestrator-notification-wake-budget.ts` | — | — |
| 11 | Drain acknowledges by cursor; a lost response replays the same page; a second drain after acknowledgement never repeats | unit | PASS: store test (row 11), `tests/orchestration/orchestrator-notification-control.test.ts` | PASS: feed test "… drains by cursor and replays until acknowledged" over `agent.notifications.read` | — |
| 12 | `workers_wait` and the feed agree: wait after drain answers `retrieval: "replay"`; drain after wait shows the record acknowledged with `deliveredVia: ["wait"]` | integration | PASS: control test (settled embeds result `retrieval: "notification"`, later wait `replay`); `tests/orchestration/agent-control-service.test.ts` (wait consumes settled keys via `acknowledgeByDedupeKey(…, "wait")`) | not exercised end-to-end (fake PTYs produce no completed turn) | not run |
| 13 | Broker restart with pending records: replay restores them; the notice file is rewritten; no duplicate `settled` for the same `(sessionId, completionTarget)` | restart test | PASS: store test (once-dedupe across reload), delivery test row 13 | PASS: feed test "replays pending records and rewrites the notice file after a broker restart" (second composition over the same state directory) | — |
| 14 | Two orchestrators on one broker, each with its own workers: neither sees the other's records; a lease transfer moves future records only | integration with two bindings | PASS: producer test (controller isolation, transfer semantics) | PASS: feed test "keeps each orchestrator's records to itself" (fleet + workspace bindings) | — |
| 15 | Cap on unacknowledged records reached: oldest `progress` dropped first, `dropped` count reported on the next notice and drain | unit | PASS: store test (drop order, `dropped` counter), control test reports `dropped` | — | — |
| 16 | Notice size ≤200 chars (≤400 with inline); every summary ≤512; drain page ≤50 | schema tests | PASS: `tests/domain/orchestrator-notification.test.ts`, control test (limit > 50 rejected), notice-file schema ≤400 | PASS: feed test asserts the live notice text ≤200 | — |
| 17 | A Cursor orchestrator (tier A only) receives channel 1 and channel 3 deliveries | live | n/a (Cursor now also gets plugin hooks, D14) | — | not run |
| 18 | Existing suites, dependency rule and file-size ratchets pass | CI | PASS: full `vitest run` green on every integration commit (see commit messages); `tests/architecture` green; no baseline entries added | — | — |

## Fault cases

- Notice file unreadable or missing: hook prints nothing, exits 0, provider continues; no error reaches the model.
- Broker unreachable from the MCP server: tool failure envelope unchanged; no notice fabricated.
- Orchestrator session terminal: wake instruction `undelivered`, record stays pending for a future rebind or adoption.
- Hook command slow: timeout ≤2 s in the generated hook config; the file read path makes this moot in practice.

## Token evidence

On the live run, compare for the same fan-out (one Orc, three Codex workers of about five minutes each): orchestrator input tokens and wall-clock with the old `workers_wait` loop versus the feed. Report both numbers and the count of notices and wakes. A win is fewer orchestrator tokens and no missed settlement; the plan does not promise a specific ratio.

## Status (2026-10-07)

Scripted and test-broker layers are filled in above. The live-broker layer was deliberately not
run: it needs the operator to restart the live broker with this build while other fleets are idle.
The exact commands are in the pull request description.

## Rollout gates

1. Scripted tests green in the worktree.
2. Test broker (separate state directory, socket and identity) runs behaviours 1, 3, 4, 5, 11, 13, 14.
3. One supervised live run with a Claude orchestrator, then one with a Codex orchestrator, while other fleets are idle; the operator approves the broker restart that installs the build.
4. Prompt text and docs merged in the same PR as the feature so no orchestrator launches with a prompt that describes tools it does not have.
