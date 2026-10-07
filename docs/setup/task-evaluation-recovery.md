# Evaluation outbox replay and retention

`TaskEvaluationReconciliationService` reconciles one named consumer over the canonical local
activity stream. Wire it to the underlying `AgentActivityStore` or its `withActivitySink` wrapper,
the shared `TaskEvaluationStore`, and `TaskEvaluationService`. Initialize it before allowing new
production attempts. Continue `reconcile()` until `health().state` is `caught-up`; `pending`
means another bounded page batch is required. `gap` and `backpressure` must close production
admission and be visible in broker health. An unavailable recorder has no replay port and
therefore cannot silently become a healthy empty history.

The default batch reads at most four pages of 100 events. Configuration is bounded at 100 pages
of 1,000 events. Only the current page is in memory. Replay is serialized per reconciler and
must run under the installation's existing single broker owner. Consumer identifiers are
stable and rubric-specific; changing a consumer does not inherit another rubric's checkpoint.

For each page, the service:

1. Installs a durable activity retention fence at the existing outbox checkpoint.
2. Enqueues terminal events and inline evidence with SQLite `synchronous=FULL` commits.
3. Advances the outbox checkpoint by a compare-and-swap FULL commit.
4. Advances the separate fsynced activity retention fence.

A crash before enqueue leaves the canonical event protected. A crash after enqueue but before
checkpoint replays the event and reuses its original intent/evidence. A crash after checkpoint
but before fence advancement retains extra activity until restart; it never frees evidence
early. Outbox/disk failures leave the checkpoint unchanged. The activity byte cap fails with
backpressure when protected events cannot be retained, rather than deleting those events.
Any rejected append is also recorded as capture loss where health persistence remains available.
An operator must resolve actual capture gaps; successful later appends do not erase them.

The activity replay metadata contains a durable source UUID and per-consumer fences. Source
replacement, a missing prefix, internal sequence gaps, a checkpoint beyond the retained journal,
torn tails and recorder loss fail closed. Older health records did not distinguish ordinary
retention from recording failure; their loss counts are treated conservatively. New records
distinguish acknowledged retention (`dropped`) from lost/uncertain capture (`captureGaps`), so
safe pruning below a checkpoint does not prevent later replay. Do not delete a consumer fence
or reset its cursor to bypass a gap.

`TaskEvaluationService` requires the terminal event's recorded generation. It cannot infer it
from the current session. It verifies that captured evidence names the exact canonical event,
rejects worker-reported check sources, and skips worker-report terminal claims. After enqueue,
the existing immutable evidence wins on retry even if current metadata or artifacts changed.
The outbox retains a terminal source-key index after evidence/result acknowledgement.

## Canonical instruction projection gap

Instruction settlement is fsynced in `instructions.jsonl` before its activity projection.
A crash in between can lose that projection without creating a hole in activity sequence
numbers. Supply `auditCanonicalCoverage` to the reconciler; without it, caught-up activity
still reports `canonical-instruction-coverage-unavailable`. The exported
`auditTerminalInstructions(outbox, records, maxRecords)` checks canonical completed, cancelled
and undelivered instruction snapshots against the durable terminal source index. It accepts
a bounded iterable/async iterable and returns an explicit gap if its record limit is exceeded.
The broker can initially supply `InstructionStore.list()`; that existing method reads the whole
journal and is not itself a bounded-memory scanner. A pageable canonical journal adapter remains
necessary for large installations.

`InstructionRecord` has no immutable execution generation, and `list()` returns only the latest
snapshot per instruction. A missing terminal projection is therefore detected but cannot safely
be reconstructed from that inventory. The helper returns `canonical-instruction-projection-missing`
and does not fabricate an attempt ID or generation. Older acknowledged evaluations whose inline
evidence was removed before the source index existed also remain a gap; still-pinned legacy
manifests populate the index during store migration.

This is recovery for recorded canonical activity plus an audit of latest terminal instruction
snapshots. It is not proof that every historical provider turn, direct-input attempt, or every
intermediate terminal instruction snapshot was recorded. Native provider transcript reconciliation
and immutable generation attribution in the instruction journal remain separate work. Broker
composition must disclose that coverage limit rather than promoting `caught-up` to an all-attempts
guarantee. Neither source loss nor missing verification is a verified-pass disposition.
