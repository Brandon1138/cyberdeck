# Broker responsiveness repair — 2026-11-15

A completed MCP result could remain hidden behind optional notice retrieval. Fleet could retain a pending refresh indefinitely and keep displaying cached modal/activity state without a warning. Wait admission and binding lookup spent time outside the requested wait budget. These mechanisms are reproduced by deterministic fixtures; they are not proof of the historical provider-busy incident's exact cause.

## Candidate and ownership

Base: `35c5241a7fae7c749f9b8be50716523c34fd8d4c` (merged PR167).
Branch: `codex/broker-responsiveness-20261115`.
The managed worktree is separate from the dirty primary checkout and PR168's worktree.

The authorized retirement used supported `session.stopOne` after verifying peer `603fd827-4ba2-4302-ba7b-d9e332a8aa79`, name `strigoi-reliability`, kind orchestrator and repository cwd. A subsequent read confirmed cancelled/stopped, exit 143, generation 1. Its review child `50016feb-c290-494c-9970-e630c1b98b89` remained active with attention done; no child was stopped. The audit worker was untouched. Queued instructions `9b00871c-67f1-4416-9319-1e96ec9d61a6` and `4638eb40-b46a-4f8d-8175-6b2b4e72e4ef` remain recorded. Nothing was resent, flushed, deleted or marked completed.

## Behavior

- Ordinary MCP calls have a 15-second caller deadline. Wait calls allow the requested/maximum segment plus one second for transport. Errors say outcome unknown and require reconciliation of the original mutation/message identity. No automatic retry or cancellation of broker mutations is introduced. RPC pending entries expire and late responses cannot fulfill a later request.
- Optional MCP hints use a new read-only `agent.notifications.peek`, bounded to 200 ms. It never advances the durable notice cursor or records delivery. Local hints are debounced by inbox cursor for ten minutes; loss cannot suppress the durable hook/wake path. An older broker without peek simply contributes no optional hint. The existing consuming notice endpoint retains its behavior for existing clients.
- Worker wait budgets begin before admission. Admission/binding waits are bounded, collection receives only the remaining budget, and a 250 ms response allowance bounds projection/acknowledgment delays. Late collection cannot begin notification consumption after the caller timed out. Already-started mutations can still complete; timeout is never rollback.
- Fleet shows stale cached data after a refresh has remained pending for two seconds, ends the refresh after five seconds, and fences late replies by generation. Legacy RPCs share the same remaining budget; transports without expiry coalesce retained work instead of accumulating requests. Disposal releases observation timers.
- Missing coordination now says owner unknown. Positively observed controller ownership retains its existing label. Known orchestrators, including peers, are not offered worker-reporting tools. The backend reports `WORKER_ROLE_REQUIRED` before registering a report subject, with a role-specific remedy. Capabilities and controller identity derivation are unchanged.
- Optional coordination-store timing reports queue, lock, replay, fsync and checkpoint durations without payloads or credentials. Observer failures cannot change durability. No storage format, compaction policy or replay algorithm was changed.

## Measured evidence

Node 24.18.0, one synthetic 131,585-transaction journal, 242,929,580 bytes, dominated by retained no-change budget observation audits/receipts. It is not a copy of the live journal and does not reproduce its full subject distribution. Baseline source was exported from the exact base commit, not read from the dirty checkout.

| Observation | Base | Candidate |
| --- | ---: | ---: |
| Primary result with notice RPC never resolving | Still pending at 1,103 ms observation cutoff | Returned in 203 ms |
| Initialize synthetic history | 14,737 ms | 6,290 ms |
| 100 warm subject reads, total | 0.313 ms | 0.234 ms |
| One durable append | 10.214 ms | 10.438 ms |

These are single samples under differing host load, not evidence of a replay speedup. Candidate initialization split: replay 1,966 ms; checkpoint consideration 4,308 ms; lock 1.56 ms; queue 0.017 ms. Append split: queue 0.035 ms; lock 0.584 ms; write/fsync/close 9.57 ms. The store/service call chain loads at initialization, retains the projection in memory, and appends mutations. This fixture does not establish per-request full replay or a current write storm. No speculative optimization follows from it.

Reproduce from an isolated checkout with installed dependencies:

```sh
rtk proxy node --import tsx scripts/bench-broker-responsiveness.ts . 131585
```

The script creates and removes only its own synthetic temporary directory. A second argument may select an exported baseline source tree; it never accepts a live state directory.

Read-only live observations: broker health 3.31 ms, session list 238.71 ms, Strigoi inspection 5.45 ms, excluding CLI startup. PID 58867 was launched with Node 24.18.0 and primary `dist/src/broker/main.js` at 13:50:35 Europe/Bucharest. The process exposes no immutable loaded source revision; the checkout's current HEAD and on-disk build do not prove its loaded revision. No shared rebuild/restart was performed.

## Validation

Final combined focused run: **325 tests passed in 21 files**. TypeScript no-emit check, architecture/file-size rules and diff whitespace check passed. Coverage includes optional hint loss/replay and production private-socket composition, uncertain mutation responses, RPC expiry, wait admission and late acknowledgment fencing, Fleet modal/activity transitions, legacy refresh retries and action fencing, role/catalog policy, instruction delivery fencing, native observation/transient reads, coordination replay and checkpoint durability. The private-socket broker uses fake provider PTYs: it is not live provider acceptance.

One independent Sol/medium validator found and verified corrections to durable-notice loss, legacy pending-RPC accumulation, production peek wiring and stale-generation legacy reuse. Its final targeted rerun passed 20 tests with no remaining actionable finding in those corrections. No full-suite, live Codex dispatch, real modal interaction or combined Strigoi activation is claimed.

The acceptance budget is subsecond warm local control replies under healthy conditions; inference time is measured separately. Failures must be explicit within the bounds above. Real lease/modal/message stage timings and the original busy incident remain live acceptance gaps. Preserve `deliveryAttemptAt` and resident `submissionAttempt` fencing; a timeout or idle row cannot justify retyping input.

See [Strigoi rollout dossier](strigoi-broker-rollout-20261115.md) for approval boundaries and the required native gate.
