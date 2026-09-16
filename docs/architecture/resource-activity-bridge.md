# Resource activity bridge

`ResourceActivityBridge` turns validated aggregate `ResourceSummary` values into local
`resource.summary` and `resource.incident` activity events. The composition root supplies
`path`, canonical `installationId` and `brokerId` UUIDs, `assertOwner`, `readSummary`, and
an `AgentActivityPort` with durable `pin` support. `runId` is the installation UUID;
`workerId` and `sessionId` are the broker UUID. No worker paths, command arguments,
provider output, or arbitrary reason text enter these events. Unknown measurements
remain `null`.

The public lifecycle is `await ResourceActivityBridge.open(options)`, `tick()`,
`health()`, and `await close()`. The caller owns the tick timer. Concurrent ticks join
one operation; close refuses new ticks and waits for an existing one. Open loads state;
the first tick recovers existing work before reading the sampler.

A summary is due initially and at most once every 60 seconds after successful delivery.
Delayed replay starts a new 60-second window rather than emitting missed summaries.
`resourceIncident` decides incident transitions and recovery. Repeating the same reason
produces no extra alert or state write. Recovery emits reason `recovered` once. Aggregate
measurements and outcome vocabularies pass strict schemas before any persistence.

## Durable delivery and retention

The private state file is at most 16 KiB and has a checksum. One fixed `.pending` staging
file holds its next atomic replacement; there are no per-poll journal or temporary-file
accumulations. Both files use mode 0600, the parent directory mode 0700, and replacement
uses file fsync, rename, then directory fsync. A complete staged next revision is promoted
on restart. Corrupt, oversized, conflicting, or non-private state is preserved and
blocks the bridge with visible health.

Each transaction follows this order:

1. Persist at most one summary and one incident, their immutable event IDs, source keys,
   source hashes, and a retention-pin obligation.
2. Durably pin the installation run before appending to local activity.
3. Append the exact pending events. Recorder source deduplication makes retries safe.
4. Persist committed incident state and summary delivery time, keeping the pin obligation.
5. Unpin and persist that the obligation was cleared.

The pin protects appended-but-uncommitted events from retention. Recovery handles
crashes before append, after append, and after commit but before unpin. No pending event
is silently discarded. A pin is confirmed once per in-memory pending batch; repeated
failed capture polls do not rewrite the pin. Temporary pinning covers the installation
run, so an unavailable recorder may eventually reach its retention cap; this remains a
visible `capture-failed` condition with pending work retained.

`health()` exposes only bounded state: `degraded`, a closed-enum `failure`, pending count,
pin obligation, last successful summary delivery time, and closed status. Ownership,
corruption, and storage failures latch until reopening. Sampling and capture failures
can recover on later ticks. If durable pin support is unavailable, capture fails visibly
before appending. The bridge neither closes the shared recorder nor drives a remote sink.
Downstream transport failures are independent of local resource capture and admission.

All evidence for this module is source and local test evidence. It does not establish
live container, provider, remote telemetry, or resource-limit enforcement behavior.
