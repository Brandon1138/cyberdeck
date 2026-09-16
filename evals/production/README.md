# Production evaluation

The broker records intents through `TaskEvaluationService` after canonical activity fsync.
Startup must replay retained canonical activity and recovered instruction terminal receipts;
the service consumes an async iterator one event at a time. Failed enqueue is backpressure,
not permission to prune canonical evidence. Historical generation must be known. Worker reports
never create evaluation intents or objective checks.

`TaskEvaluationStore` is a shared SQLite outbox with FULL commits, unique attempt/rubric keys,
five-minute maximum claim leases, stale-token fencing, result-before-ack recovery and inline
evidence pins. Read `unacknowledged()` and acknowledge already-written results after supervisor
restart. The total cap reserves half for rollback journals; full stores refuse new entries
without deleting old attempts. Operators must archive the database and advance the canonical
retention checkpoint explicitly; there is no silent result eviction. Unknown artifacts are
unverified. A new rubric version creates a new row.

Production execution uses `TaskEvaluationExecutor`: an admitted, pinned, network-disabled
container with 768 MiB default cgroup memory, read-only input and bounded tmpfs/report storage.
It requires reconciliation before launch, durable run intents, host-independent grading and fresh
daemon absence before releasing resources. Long admission waits leave expired claims pending.
See [setup and recovery](../../docs/setup/task-evaluation-executor.md) and
[`docker/evaluator/Dockerfile`](../../docker/evaluator/Dockerfile). `container-entrypoint.mjs`
runs a fixed echo provider with offline assertions; it invokes no model or judge.

`evaluateNext`, `PromptfooProcess` and `PromptfooAttemptRunner` remain legacy test/supervisor
adapters for deterministic report and process tests. They are not the production fallback.
The container adapter never invokes them. Process/report failure is infrastructure-error,
never model failure, and no adapter is proof of deployed evaluation until its live gate passes.

The rubric catalogue defines required independent checks. Without the matching objective
verifier, attempts receive unverified rather than trusting a successful exit or worker claim.
The deterministic tests cover source replay, claim/restart, report-before-ack, deduplication,
new rubric, cancellation, absent evidence, malicious checks, admission and disk exhaustion.
They do not establish real Promptfoo execution, authenticated model comparisons, live broker
recovery, resource containment, or W7/W8. Those gates remain pending. The restricted macOS runner
denied process-group signaling with EPERM even with escalation. The output-overflow test verifies
fail-closed behavior there, not successful process-group cleanup. The broader existing Sentry
outage test was blocked at broker socket listen by EPERM; it is not a passing runtime gate.
