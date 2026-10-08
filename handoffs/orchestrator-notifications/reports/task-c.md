# Task C delivery report

Complete, uncommitted. Six implementation/test files added; existing files unchanged. No main.ts, MCP, CLI, protocol, provider, or architecture-baseline edits.

Worktree: `/Users/brandon/code/personal/cyberdeck-worktrees/onf-task-c`

```sh
cd /Users/brandon/code/personal/cyberdeck-worktrees/onf-task-c
```

## Files and line counts

- `src/orchestration/orchestrator-notice-file-port.ts`: 8
- `src/persistence/orchestrator-notice-files.ts`: 51
- `src/broker/orchestrator-notification-delivery.ts`: 272
- `src/broker/orchestrator-notification-wake-budget.ts`: 33
- `tests/broker/orchestrator-notification-delivery.test.ts`: 420
- `tests/persistence/orchestrator-notice-files.test.ts`: 66
- `handoffs/orchestrator-notifications/reports/task-c.md`: 79

## Gates

`pnpm install --prefer-offline`: passed.

`pnpm check`: exit 0. Verbatim output tail:

```text
[WARN] Unsupported engine: wanted: {"node":">=24.18.0 <25"} (current: {"node":"v26.7.0","pnpm":"11.5.0"})
Already up to date
Done in 163ms using pnpm v11.5.0
[WARN] Unsupported engine: wanted: {"node":">=24.18.0 <25"} (current: {"node":"v26.7.0","pnpm":"11.5.0"})
$ tsc -p tsconfig.json --noEmit
```

`pnpm exec vitest run --configLoader runner tests/broker/orchestrator-notification-delivery.test.ts tests/persistence/orchestrator-notice-files.test.ts tests/cli/notifications.test.ts tests/architecture`: exit 0. Verbatim output tail:

```text
[WARN] Unsupported engine: wanted: {"node":">=24.18.0 <25"} (current: {"node":"v26.7.0","pnpm":"11.5.0"})
Already up to date
Done in 163ms using pnpm v11.5.0

 RUN  v4.1.11 /Users/brandon/code/personal/cyberdeck-worktrees/onf-task-c


 Test Files  5 passed (5)
      Tests  53 passed (53)
   Start at  18:27:52
   Duration  4.69s (transform 273ms, setup 0ms, import 506ms, tests 5.75s, environment 0ms)

```

Gates passed on Node 26.7.0; package declares Node >=24.18.0 <25. Supported-Node proof not claimed. Architecture dependency/file-size gates passed; no baseline entries added. No runtime/test-broker/live-provider proof claimed.

## Decisions for producer, control plane, hooks and docs

- Producer: inbox `onChange` is sole notification trigger. Delivery serializes each controller's work; its own durable notice/delivery mutations also trigger projection refreshes. Producer appends remain independent, so text, cursor and record IDs are captured synchronously together.
- Producer: persisted `wakeEligible` flags govern wake selection; delivery additionally checks current `policy.wake !== "off"`. Changing policy does not recompute older record flags. Wake eligibility scans every pending page, including beyond first 50. Budget records always use `wakeEligible: false` and `dedupe: "once"`.
- Control plane: `noticeFor` reports total `pendingCount`; `byKind`, oldest age and inline summary describe first page of at most 50. Tool-result and wake bookkeeping mark that page's IDs delivered. Delivery never acknowledges records; drains/waits retain ownership of acknowledgement.
- Control plane: call `notice(controllerId)` for piggyback, rather than separate `shouldNotice`/`noticeFor` calls. Concurrent notice calls serialize. Unknown controller bindings return undefined. Resolve controller/session through `OrchestratorControllerDirectory`; no duplicate controller derivation.
- Hooks: file paths exactly match CLI: `<state>/orchestrators/<sessionId>/notice.json` and `notice-shown.json`. Broker reads sidecar cursor for debounce and also suppresses an idle wake when hook already showed current head. Broker delivery updates `noticedCursor`; hook owns sidecar.
- Hooks: quiet repetition uses broker `lastNoticedAt`; a sidecar alone supplies no broker timestamp. Existing hook remains cursor-based. Delivery preserves dropped-only notices while dropped count remains nonzero; file disappears when both pending and dropped counts reach zero.
- Hooks/adapter: notice replacement uses exclusive 0600 temporary file plus atomic rename; orchestrators/session directories created or repaired to 0700. Remove touches only notice.json, preserving sidecar. Missing, unreadable, malformed or schema-invalid sidecars return undefined. Adapter rejects invalid session paths and mismatched file ownership. Notice projection is reconstructible from durable inbox; no additional fsync contract added.
- Queue/control plane: `accepted` and all `queued` holds retain one pending wake snapshot per controller. Human-controller holds remain queued despite a piggyback; working transition or inbox drain withdraws them. Rendering after enqueue is reconciled through instruction list on session updates and before piggyback. A rendered-or-later withdrawal result counts as wake delivery, since bytes cannot be unwritten.
- Queue/docs: `rendered|submitted|acknowledged|completed` count as notice delivery bookkeeping, per task contract. `rendered` remains composer-rendering evidence, not provider submission proof. Late wake bookkeeping never rolls noticed cursor backwards. Deterministic ID is `stableUuid("notice:" + controllerId + ":" + head)`; message prefix is `[cyberdeck notice] `.
- Queue/faults: timer rereads inbox, sidecar and orchestrator truth; a drain/working change during sidecar read prevents enqueue. Working/drain racing asynchronous enqueue withdraws newly queued wake immediately. Enqueue exceptions and undelivered records leave inbox pending. Background errors are contained; later inbox changes or fresh startup retry projections/wakes. Startup sweep errors reject start and unsubscribe/clear timers.
- Budget/docs: rolling 60-minute budget lives in memory; new process/instance resets it. Successful enqueueBroker returns count, including accepted, queued and undelivered records; thrown calls have no returned enqueue proof and do not count. At exact hour boundary old timestamps expire. Ceiling appends one deduped budget warning per suppression window and schedules one retry at earliest admissible expiry, without restarting timer on more changes. Maximum 0 never wakes; its warning dedupe uses stable one-hour suppression windows, with no autonomous wake retry.
- Integration: load inbox before `start()`. Start subscribes then sweeps known inbox controllers, rebuilding files and scheduling eligible replayed notices. Stop unsubscribes and clears coalescing/budget timers; default timers are unref'ed. Existing accepted/queued instruction records are recovered through deterministic enqueue deduplication when replay schedules same head.
- Tests: fake clock/injected timers, real fsynced inbox/replay, mutable fake registry/queue and memory file port cover requested rows plus lifecycle statuses, queue holds, page-boundary eligibility, concurrent notices and drain/enqueue races. Test-only private queue barrier makes asynchronous no-enqueue assertions deterministic without consuming notices.

## ORCHESTRATOR: run these

No gate blocked. Wire delivery/adapter through composition root, expose notice RPC, then run separate test-broker/live acceptance. No broker restart performed here.

Progress event delivery blocked: MCP returned `MCP tool call requires approval, but approval policy is never`; CLI returned `connect EPERM /tmp/cyberdeck-501.sock`. Retry completion progress from host:

```sh
cd /Users/brandon/code/personal/cyberdeck-worktrees/onf-task-c
cyberdeck event submit --worker 77e81f74-d161-4ef1-a77e-856b3b63ed05 --kind PROGRESS --summary 'Task C complete: delivery, atomic notice-file adapter and tests added; pnpm check and 53 tests passed. Report: handoffs/orchestrator-notifications/reports/task-c.md. Uncommitted; integration wiring remains orchestrator-owned.' --event-id onf-task-c-complete-20261007
```
