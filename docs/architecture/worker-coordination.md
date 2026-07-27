# Lease-owned workers and bounded event protocol

MIK-55 Wave 1 adds provider-neutral broker substrate only. It adds no MCP method, CLI command, or UI.

## Identity and ownership

`OwnershipSubject` can describe a worker or orchestrator. Immutable `origin` keeps creator-controller,
creator-session, task, wave, and thread provenance. Mutable `lease` keeps current authority.
`resources` points to existing process/session, worktree, payload, transcript, result, and event
stream state; ownership changes never rewrite those references.

Controller identity is a durable family plus fleet/worktree/session-family scope. Conversation UUIDs
are rejected as `controllerId`. Broker tokens are random, stored as SHA-256 hashes on leases, bound
to that stable identity, and fenced by monotonic lease version.

Lease state machine:

```text
released --acquire--> active
orphaned/expired --adopt--> active
active/contested --renew/authenticated call--> active
active/contested --same stable family reacquire--> active (new token/version)
active/contested --conflicting acquire/adopt--> contested
active/contested --release--> released
active/contested --TTL or observed-disconnect grace--> expired --> orphaned
active/contested --transfer--> active (new controller, token, version)
```

Stale tokens, controller identities, and lease versions return `OWNERSHIP_LOST`; they never restore
authority. Group mutations take one token per subject. Every lease mutation is serialized,
idempotency-receipted, fsynced, and audited with actor, time, prior/new controller, reason, and
outcome.

Worker lifecycle state machine:

```text
queued --launch--> launching --provider ready--> working
working --input/intervention--> waiting --resume--> working
queued/launching/working/waiting --success--> done
queued/launching/working/waiting --fault--> failed
queued/launching/working/waiting --operator stop--> stopped
```

`done`, `failed`, and `stopped` are terminal for ownership mutation eligibility.

## Event and checkpoint protocol

Worker events carry an idempotent event ID, per-worker sequence, task/wave identity, lease version,
kind, severity/intervention flag, bounded summary/facts/evidence/assumption deltas/recommendation,
continuation state, timestamp, and schema version. A broker ordinal provides cursor projection.

Payloads over 16 KiB and fields over schema caps are rejected with the violated limit. Per-worker
rate and active-queue limits prevent noisy workers from consuming unbounded memory. Progress events
coalesce by worker and kind while merging bounded material deltas. Exceptions, decision requests,
and intervention-required events remain pinned until explicitly resolved.

Checkpoint requests are durable and correlation-idempotent. Non-blocking is default and does not
change worker lifecycle. Decision gates set structured `decisionGate` state. A `CHECKPOINT` event
answers one pending correlation through the same bounded event schema.

## Persistence and migration

`orchestration/worker-coordination-v1.jsonl` is an append-only transaction log. One fsynced JSONL
record atomically carries all ownership, event, checkpoint, audit, liveness, and idempotency changes
from one mutation. Replay keeps latest state, ignores only an unterminated crash tail, and fails
closed on corrupt records, unsupported versions, or duplicate transaction IDs.

Migration `0001-worker-coordination` reads existing worker `SessionRecord.parentSessionId`
provenance. It resolves primary orchestrator bindings to stable scope keys. Missing or peer bindings
cannot prove stable family identity, so their workers migrate as orphaned and adoptable rather than
granting authority to a conversation UUID.
