# Worker follow-up delivery review

Review checkout: `/Users/brandon/.codex/worktrees/worker-followup-delivery/cyberdeck`

Branch: `codex/worker-followup-delivery`

Agreed integration base: `54c9234a41bad511f19e6370b3ed83f22a585e4b`. The operator confirmed that current work was finished before implementation. This report is committed with the patch; the handoff response supplies its exact commit. The open Strigoi branch is separate and has not been modified or merged.

## Historical evidence and certainty

The retained records corroborate the reported incident for `d4c51479-26d3-4667-a5b3-83639677146f`:

| UTC on 2026-11-14 | Retained evidence |
| --- | --- |
| 12:36:03.099 | Instruction `14b69850-5d6f-4257-9212-d2ef994a1d70` accepted, then queued with `provider-busy`. |
| 12:49:00.263 | Same instruction retried and held again. |
| 12:50:03.711 | Native turn 1 finished; canonical ledger recorded one completion. |
| 12:54:00.514 | Instruction `b3f17965-55f7-4733-abaf-16e80c1944ef` accepted. |
| 12:54:01.206 | First instruction still refused with `provider-busy`; second queued behind it. Neither had an expected turn assigned. |
| 12:55:03.169 | Worker exited on signal 15. Both instructions subsequently became `undelivered` / `worker-terminal`. |

Sources are under `~/Library/Application Support/Cyberdeck/`: `orchestration/instructions.jsonl:49029–49108`, `threads/semantic-transcript.jsonl:2417–2497`, `threads/turn-ledgers/<session-id>.json:1`, and `events.jsonl:422948–423461`. `incident-evidence.json` contains bounded metadata extracted without prompt bodies. The historical worker is cancelled, not a currently active remediation target.

**The exact historical gate is not identifiable from these records.** The old format records only `provider-busy`, without the underlying gate or observation history. In particular, no retained read-error event establishes that the independently reproduced read-outage defect caused this incident. Two queued records also do not mean two independent provider admission attempts: FIFO propagates the head's hold to its followers.

## Reproduced causes and changes

1. **A transient native read outage permanently lost an idle boundary.** At the base revision, `worker-turn-native-state.ts:128` deleted `view` when the source became unavailable while retaining `seenEvidence`. At base lines 132 and 142, the next successful read of the same completion ID was not new evidence, so it could never rebuild `view`. Periodic reconciliation therefore continued to return unknown activity. Admission's native-unknown gate refused input, and `notifyDeliveryBoundary` never observed a clear gate. The new `worker-turn-native-state.ts:121–164` masks the retained view during refusal and recovers it after a successful read. Actual input, newer work, admission revisions and generation reset still fence it. It does not erase evidence IDs or manufacture fresh completions.

   Deterministic failing-before test: `worker-turn-native-state.test.ts`, “recovers the same idle evidence after a transient native read failure without terminal bytes”: expected `awaiting-input`, received `unknown`. Added negative cases for newer input, newer work, and a different generation.

2. **Queued work could miss its recovery subscription, and restored completions could lose instruction attribution.** Base startup called only `recoverLaunchInstructions`; ordinary queued records have no launch flag. Engine restoration loaded targets into retirement bookkeeping but did not rebuild pending rendered identities or replay their exact completed receipts. `instruction-recovery.ts` now replays exact target/receipt matches and retries ordinary queued work after budget recovery (`broker/main.ts`). `worker-input-retirement.ts:34–49` and `worker-turn-engine.ts:1419` restore pending identities without submit keys or message text, so recovery observes consumption and never retypes rendered input. Counts alone cannot complete an instruction. A mismatched ordinal is rejected by the queue.

3. **A failed screen completion commit did not notify an already-held queue.** The new assertion in “poisons an indeterminate asynchronous commit failure without reusing its ordinal” fails before the fix: no delivery-boundary notification follows rejection of the pending commit. `worker-turn-engine.ts:1276–1281` now signals the explicit failure only for the current capture. Retirement settlement also signals failures. This deliberately does not publish an early ready boundary while another screen capture is draining. New, unwritten instructions receive `undelivered` with `completion-commit-failed` or `input-retirement-failed`; the uncertain existing receipt remains reserved.

4. **A crash or exception between input and the durable queue result could otherwise invite a repeat.** `instruction-queue.ts` now persists `deliveryAttemptAt` before invoking delivery. A known refusal clears it. An unknown outcome retains it with `delivery-outcome-unknown` and actionable detail. Recovery can clear it using an exact persisted instruction target and receipt; otherwise it refuses automatic retry and withdrawal. The marker does not claim that bytes were rendered or consumed. Existing legacy records have no retrospective attempt fence.

## Hold recovery contract

The queue preserves `holdReason` and `holdDetail`, including the head's hold for followers. Transcript and event diagnostics carry the precise reason. `worker-delivery-hold.ts` centralizes the engine's decision; it does not use Fleet's Idle label as permission.

| Gate | Recovery or explicit failure |
| --- | --- |
| `provider-busy` | Native completion reconciliation or a proven screen completion. |
| `launch-pending` | Native launch receipt; existing periodic reconciliation. |
| `input-consumption-pending` | Existing bounded submit verification and native consumption/completion evidence; never repeat text. |
| `completion-commit-pending` | Commit settlement. Poisoned ownership becomes an explicit `completion-commit-failed` outcome for new input. |
| `input-retirement-pending` | Retirement settlement. Failed retirement becomes `input-retirement-failed`. |
| `completion-evidence-pending` | Exact deferred capture settlement/native reconciliation. Missing evidence remains reserved and diagnosable. |
| `native-evidence-unavailable` | Existing periodic source reads; successful read restores a still-valid boundary. Persistent binding/read problems require inspection of the named transcript. |
| `completion-restore-pending`, `completion-reconcile-pending` | Existing native reconciliation retries without terminal output. Unreadable startup recovery ledgers fail startup explicitly rather than pretending recovery succeeded. |
| `admission-in-progress` | Serialized admission release announces a boundary when safe. |
| `observation-changed` | Current-generation observation/reconciliation; old observations cannot authorize a write. |
| Human controller, modal, occupied composer | Controller release or positive observation that the surface cleared; all final admission checks remain in force. |
| `worker-interrupted` | Retain the instruction until explicitly authorized resume of the same session. Resume announces a retry boundary. No automatic process replacement. |
| `delivery-outcome-unknown` | Exact durable target/receipt reconciliation, or operator investigation. No automatic resend, receipt deletion, or withdrawal. |

## Acceptance and validation

`tests/integration/worker-followup-delivery.test.ts` uses production InstructionQueue, InstructionStore, ThreadTranscriptStore, SessionUpdateBus and WorkerTurnEngine with isolated native transcript fixtures. One scenario submits four follow-ups to the same session ID: while working, at completion, after an hour of simulated idle with a transient read exception, and through queue/engine reconstruction. It asserts stable instruction/message IDs, FIFO writes, distinct matching receipts, and no old-answer completion. All progress waits are bounded and print retained records on failure. There is no manual queue flush in those waits and no terminal output is required.

Additional scenarios cover delayed native writes, human control at final admission, modal/composer holds, ambiguous transport outcome, queue receipt persistence failure after input, forbidden withdrawal of uncertain input, real isolated broker startup with a queued instruction, and replay of an exact completion emitted before queue subscription. Existing native-ordering tests retain input/generation fencing coverage.

Validation is recorded in `validation.md` and the adjacent text logs. Node version: 24.18.0. Test concurrency was capped after one host resource stall prevented Vitest worker startup. Dependencies were reused without reinstalling or changing the lockfile. A pnpm offline-script invocation tried to reinstall the linked dependency directory and aborted before removal; invoking the existing Promptfoo entrypoint directly completed the offline gate.

## Limits

- This is source and fixture verification. **Live provider reliability is not qualified.** No live broker restart, worker input, stop, replacement, or provider inference was performed.
- A broker restart in this architecture loses host PTY processes. The patch retains queued follow-ups through that interruption, but continuing the same session requires the existing authorized resume flow. It does not automatically launch a process.
- If a transport write has an unknown outcome and no exact durable target/receipt can establish what happened, automatic delivery cannot be made safe. The explicit diagnostic requires operator-led investigation; no generic “clear busy” or journal-edit recovery command is introduced.
- Legacy records predate the attempt fence. Neither the historical incident's exact gate nor arbitrary pre-upgrade crash windows can be reconstructed from generic holds alone.
- Missing/ambiguous completion evidence remains a hold. An Idle label, elapsed time, or aggregate completion count never releases it. The patch adds no blanket polling loop and no widened input-ready window.
- Packed CLI acceptance explicitly requires a disposable GitHub-hosted runner; it is not run on this operator machine. Linux architecture/distro matrices and the CI history secret-scan action remain CI checks.
- Strigoi T2 Unavailable-status work is deferred. The separate Strigoi PR may overlap these queue/engine files and must be reconciled at integration time.

## Activation, only after operator approval

1. Review this commit and select the final integration state, accounting for the open Strigoi PR. Integrate in an approved clean checkout; do not overwrite or stash the primary checkout's unrelated dirty work. Rerun checks after resolving any overlap.
2. Obtain approval for isolated live-provider validation. Use fresh state, socket, transcript and workspace resources; launch no nvim/Fleet surface and verify no live resources are shared. Exercise several follow-ups to one disposable worker, recording instruction IDs and matching native replies. This gate has not been run.
3. Obtain explicit approval for the activation window and handling of existing sessions. Inventory them before any restart. The installed executable and operator nvim Lua module must use the agreed integration checkout; do not activate this review worktree directly.
4. Build that approved checkout with Node 24.18.0 (`rtk pnpm build`). Confirm the executable resolves to it. After approval, use `rtk cyberdeck broker restart`, then `rtk cyberdeck broker status`. Restarting interrupts existing broker-owned processes; resume only the sessions the operator authorizes.
5. Submit one follow-up at a time to the same authorized validation worker and observe durable `rendered` → consumption/completion receipts with distinct expected turns. Inspect specific holds instead of resending. If activation must be rolled back, preserve journals and obtain approval for the replacement build/restart; do not erase uncertain attempt markers or replay their text.
