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

`evaluateNext` runs only in a separate supervisor. Its fixed host-owned Promptfoo command must
use offline assertions and a bounded workspace. Admission happens before process creation.
Timeout/output overflow kills the group; unconfirmed descendants retain the reservation for
reconciliation. Never run this supervisor in a broker thread or substitute API credentials.
Process/report failure is infrastructure-error, never model failure. `PromptfooAttemptRunner`
writes a versioned offline config, checks exact returned evidence, parses one complete result row
and retains fsynced report bytes plus a hash manifest before acknowledgment. Its provider only
echoes host evidence; it never invokes a model or judge. It preflights total retention and bounds
report reads; hard child filesystem limits must come from the admitted execution profile.
The current adapter is not proof of deployed evaluation.

The rubric catalogue defines required independent checks. Without the matching objective
verifier, attempts receive unverified rather than trusting a successful exit or worker claim.
The deterministic tests cover source replay, claim/restart, report-before-ack, deduplication,
new rubric, cancellation, absent evidence, malicious checks, admission and disk exhaustion.
They do not establish real Promptfoo execution, authenticated model comparisons, live broker
recovery, resource containment, or W7/W8. Those gates remain pending. The restricted macOS runner
denied process-group signaling with EPERM even with escalation. The output-overflow test verifies
fail-closed behavior there, not successful process-group cleanup. The broader existing Sentry
outage test was blocked at broker socket listen by EPERM; it is not a passing runtime gate.
