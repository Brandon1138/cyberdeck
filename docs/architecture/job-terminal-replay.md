# Bounded job terminal replay

`JobStateRepository.load()` is the source for `projectJobTerminalActivity`,
`repairTerminalJobProjections`, and `auditTerminalJobs`. Repair reconstructs only
`settled` and `interrupted` observations from validated durable snapshots. The
source key and deterministic event UUID contain the job ID, transition kind, and
historical `finishedAt` or `interruptedAt`. Mutable `updatedAt`, report-back
delivery state, retry errors, and current runtime state cannot change projection.

The job ID denotes one bounded scheduling attempt at generation 1. Every event
carries `jobId` and `runId = jobId`. Its activity subject uses the recorded
`sessionId`, then persisted `parentSessionId`, then the canonical job ID. That
last fallback is a **job-subject alias for `job.settled` only**, matching the
job scheduling subject in `resourceJobRecord`; it does not assert that a provider
session, worker process, controller, or execution identity existed. Model and
execution identity are omitted because the journal contains no observed model or
historical execution ID. Origin stays `unattributed`.

Job completion is a provider result, not independent correctness evidence. The
projection carries the broker's canonical outcome, but no prompts, source,
paths, artifacts, summaries, error text, usage estimates, or launch model.
Evaluations require independent evidence to produce verified pass/fail. Root
composition owns classification of interruption as infrastructure failure.

Interrupted jobs can later be cancelled or receive a late settlement report.
Those are distinct durable transitions of the **same attempt**, not additional
model-quality samples. Transition replay preserves each observation already
captured; the latest job snapshot alone cannot reconstruct an interruption that
was superseded before capture. A transition-history audit or durable job outbox
is required before claiming every historical transition survives that crash
window. Model-comparison consumers must resolve interruption supersession by
job ID before counting attempts; automatic model ranking remains gated.

The repair helper validates a bounded full snapshot before appending any events,
awaits activity persistence, and never advances an evaluation checkpoint itself.
The standard reconciliation service fsyncs the evaluation outbox before advancing
its checkpoint. Audit checks the outbox source index, so activity persistence
alone is not considered evaluation coverage. Missing or invalid historical IDs,
timestamps, reversed timestamps, duplicate snapshot IDs, and inventory overflow
fail closed. Legacy records with valid canonical job identity and lifecycle time
need no invented session identity or durable schema migration.

`JobStore.version()` is only a process-local polling invalidation token, incremented
after a successful canonical append. Startup must still load and audit history;
the token does not replace durable replay or claim a globally monotonic sequence.
