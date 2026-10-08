# Task B report

Producer complete. TypeScript gate passes; Vitest gate passes: 50 tests, four files. Evidence: unit tests against real fsynced/replayed inbox plus architecture tests. Live broker, delivery, control-plane integration unverified. No existing files edited; no commit.

Worktree: `/Users/brandon/code/personal/cyberdeck-worktrees/onf-task-b`.

```sh
cd /Users/brandon/code/personal/cyberdeck-worktrees/onf-task-b
```

## New files and line counts

- `src/broker/orchestrator-notification-producer.ts`: 290 lines.
- `src/orchestration/observed-instruction-repository.ts`: 16 lines.
- `tests/broker/orchestrator-notification-producer.test.ts`: 419 lines.
- `tests/orchestration/observed-instruction-repository.test.ts`: 59 lines.
- `handoffs/orchestrator-notifications/reports/task-b.md`: 73 lines.

No split module needed; all new TypeScript files below 500 lines. Dependency rule passes; no baseline entries added.

## Integration decisions

- Composition must construct `ObservedWorkerCoordinationService`, loaded inbox, controller directory, producer; pass instruction repository as optional `instructions` history source. Wrap queue repository with `observeInstructionRepository(store, record => producer.observeInstruction(record))`. Start producer before queue starts writing. No wiring added here.
- D3 doc correction: queue's own holds/undelivered transitions persist through repository `put`; registry `onInstructionState` alone misses those writes. Observer runs after successful persistence; synchronous and asynchronous listener failures isolated. `list` passes through.
- D10 doc correction: terminal record carries **lowest** unreached outstanding target, per task instruction; current architecture text says highest. Initial target 1 plus expectedTurn from rendered/submitted/acknowledged/completed records. Broker-owned instructions contribute completion targets but never delivery notifications.
- History scan seeds instruction status/hold edges and targets; catch-up emits reached targets and terminal settlement only. Old delivery/attention/event records not replayed by producer. Truth seeded to suppress restart attention. Inbox replays pending payloads independently.
- ExpectedTurn persisted after truth completion triggers target settlement immediately; avoids needing another session update. Terminal settlement has separate terminal key and warning severity for failed/errored/provider-limit.
- Once-dedupe and replacement delegated exclusively to inbox. Existing once-dedupe scoped per controller; producer adds no global historical-key ledger. Routing resolves lease holder, origin creator, then parent binding at write time; missing route skips. Written records never migrate.
- Only worker sessions, including legacy undefined kind, produce records. Unknown sessions skipped. Event subjects may resolve resources.sessionId; directed handoffs use durable result manifest and recipient controller directly, skip members without resources.sessionId.
- Progress and non-gate CHECKPOINT share per-worker replacement key; forced info severity. EXCEPTION without interventionRequired ignored. Intervention/risk keep event severity and event/checkpoint refs, worker/task/wave identifiers, recommendation.
- Modal attention fires on entering blocked-modal, uses fingerprint or unknown, once-dedupes; refs carry fingerprint. Stalled attention fires on entry and increasing 300-second buckets, replaces pending attention, notice-only under default policy.
- Instruction edge cache bounded to latest 4,096 IDs; includes holdReason so queued/provider-busy changing to queued/human-controller produces delivery. Persistent once-dedupe prevents duplicates after cache eviction. Soft budget records once per allocation revision across soft-pending/soft-notified.
- Summaries start with worker name or session ID, strip CR/LF/U+2028/U+2029, truncate to 512 characters. Scout settlements include `profile:scout` ref and available reportState; no synthetic wave digest. Policy read at write time; wakeEligible uses domain helper. Optional now supplies createdAt.
- Input callbacks serialize async writes; session-update truth captured synchronously to preserve short-lived edges. Repeated start awaits accepted work without resubscribing. Stop unsubscribes every hook, ignores new instruction observations, lets accepted writes finish.
- Startup failures reject and unsubscribe. Background failures emit `ORCHESTRATOR_NOTIFICATION_WRITE_FAILED` warning; no automatic event retry or inbox reload. Composition owns inbox-health recovery; successful upstream mutations remain successful. Delivery observes inbox.onChange after fsync.
- Control plane still owns result hydration/wait acknowledgement and access checks. These tests prove producer records, not MCP inline summaries, provider wakes, or live acceptance.

## Gates

Setup `pnpm install --prefer-offline` succeeded. Environment Node v26.7.0, pnpm 11.5.0; package expects Node >=24.18.0 <25. Both gates exited 0 despite engine warning.

`pnpm check` verbatim output tail:

```text
[WARN] Unsupported engine: wanted: {"node":">=24.18.0 <25"} (current: {"node":"v26.7.0","pnpm":"11.5.0"})
Already up to date
Done in 155ms using pnpm v11.5.0
[WARN] Unsupported engine: wanted: {"node":">=24.18.0 <25"} (current: {"node":"v26.7.0","pnpm":"11.5.0"})
$ tsc -p tsconfig.json --noEmit
```

`pnpm exec vitest run --configLoader runner tests/broker/orchestrator-notification-producer.test.ts tests/orchestration/observed-instruction-repository.test.ts tests/architecture` verbatim output tail:

```text
 RUN  v4.1.11 /Users/brandon/code/personal/cyberdeck-worktrees/onf-task-b


 Test Files  4 passed (4)
      Tests  50 passed (50)
   Start at  18:26:22
   Duration  2.02s (transform 194ms, setup 0ms, import 298ms, tests 2.25s, environment 0ms)

```

Coverage includes eight triggers, default wake policy, completion/terminal restart dedupe, acknowledgement, progress coalescing, instruction edges/cache eviction, routing/fallbacks, controller isolation/transfer, recipient handoff, lifecycle subscriptions, startup races and failure isolation.

## ORCHESTRATOR: run these

No gate blocked; no sandbox gate rerun required. Worker progress reporting blocked: MCP required approval with policy never; CLI returned `connect EPERM /tmp/cyberdeck-501.sock`. Host may submit final progress:

```sh
cyberdeck event submit --worker c9a6dff8-5888-4176-bb5a-bd53de4c9348 --kind PROGRESS --summary 'Task B complete: producer, observed instruction repository, 50 tests and TypeScript/architecture gates pass; report in handoffs/orchestrator-notifications/reports/task-b.md. No existing files edited, no commit.' --event-id onf-task-b-complete-20261007
```
