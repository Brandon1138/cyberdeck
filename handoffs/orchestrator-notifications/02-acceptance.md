# Orchestrator notification feed: acceptance

Report scripted runtime, test broker and live broker evidence separately. Do not promote one to the next.

## Behaviours that must hold

| # | Behaviour | Evidence |
| --- | --- | --- |
| 1 | Worker settles while the orchestrator is mid-turn calling Cyberdeck tools: the next `cyberdeck_*` result carries one `cyberdeckNotice`; no further notice until the inbox changes or `quietMinutes` pass | MCP integration test; live transcript |
| 2 | Worker settles while the orchestrator is mid-turn calling only non-Cyberdeck tools (Claude, Codex): the provider `PostToolUse` hook delivers the notice next to that tool result | live transcript per provider from Task S matrix |
| 3 | Worker settles while the orchestrator is idle: a `[cyberdeck notice]` line is submitted at the prompt within `coalesceMs` plus one boundary, and the orchestrator's next turn drains it | instruction record `rendered→submitted→completed` with `brokerOwned: true`; transcript |
| 4 | Orchestrator starts a turn before the wake is submitted: the wake is `cancelled`, and the notice arrives through channel 1 or 2 instead; never both | instruction records; transcript shows one notice |
| 5 | Human attached to the orchestrator thread: no wake (`queued/human-controller`), notice still shows on the next tool result | registry test with controller held |
| 6 | `DECISION_REQUEST` from a worker: wake-eligible, inlined summary ≤400 chars, drain returns the full bounded event | unit + live |
| 7 | Instruction to a worker becomes `undelivered`: `delivery` notification, wake-eligible | unit |
| 8 | Ten `PROGRESS` events from one worker: one `progress` record (latest), notice-only, never a wake | unit |
| 9 | `wake: off`: no instruction is ever enqueued; notices still piggyback | unit |
| 10 | `maxWakesPerHour` exceeded: one `budget` record, wakes suppressed until the window moves | unit with fake clock |
| 11 | Drain acknowledges by cursor; a lost response replays the same page; a second drain after acknowledgement never repeats | unit |
| 12 | `workers_wait` and the feed agree: wait after drain answers `retrieval: "replay"`; drain after wait shows the record acknowledged with `deliveredVia: ["wait"]` | integration |
| 13 | Broker restart with pending records: replay restores them; the notice file is rewritten; no duplicate `settled` for the same `(sessionId, completionTarget)` | restart test |
| 14 | Two orchestrators on one broker, each with its own workers: neither sees the other's records; a lease transfer moves future records only | integration with two bindings |
| 15 | Cap on unacknowledged records reached: oldest `progress` dropped first, `dropped` count reported on the next notice and drain | unit |
| 16 | Notice size ≤200 chars (≤400 with inline); every summary ≤512; drain page ≤50 | schema tests |
| 17 | A Cursor orchestrator (tier A only) receives channel 1 and channel 3 deliveries | live |
| 18 | Existing suites, dependency rule and file-size ratchets pass | CI |

## Fault cases

- Notice file unreadable or missing: hook prints nothing, exits 0, provider continues; no error reaches the model.
- Broker unreachable from the MCP server: tool failure envelope unchanged; no notice fabricated.
- Orchestrator session terminal: wake instruction `undelivered`, record stays pending for a future rebind or adoption.
- Hook command slow: timeout ≤2 s in the generated hook config; the file read path makes this moot in practice.

## Token evidence

On the live run, compare for the same fan-out (one Orc, three Codex workers of about five minutes each): orchestrator input tokens and wall-clock with the old `workers_wait` loop versus the feed. Report both numbers and the count of notices and wakes. A win is fewer orchestrator tokens and no missed settlement; the plan does not promise a specific ratio.

## Rollout gates

1. Scripted tests green in the worktree.
2. Test broker (separate state directory, socket and identity) runs behaviours 1, 3, 4, 5, 11, 13, 14.
3. One supervised live run with a Claude orchestrator, then one with a Codex orchestrator, while other fleets are idle; the operator approves the broker restart that installs the build.
4. Prompt text and docs merged in the same PR as the feature so no orchestrator launches with a prompt that describes tools it does not have.
