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

## Orchestrator control plane

Three MCP tools project the substrate to a bound orchestrator: `cyberdeck_lease`,
`cyberdeck_worker_ctl`, and `cyberdeck_worker_events`. They reach `WorkerControlService` through
broker methods `agent.lease.control`, `agent.worker.control`, and `agent.worker.events`. The
substrate itself gains no transport surface.

Authority is proved by the caller's durable orchestrator binding, never by a conversation. The
service derives the same `orchestrator:<binding key>` controller identity the migration uses, and
peer bindings are refused with `NO_STABLE_CONTROLLER_IDENTITY`. Lease tokens stay inside the broker
and are stripped from every response. A broker restart therefore loses tokens, leases age out, and
the workers become adoptable — the intended recovery path. A controller whose token is gone gets
`OWNERSHIP_LOST` and must re-acquire explicitly; nothing is ever reacquired silently.

Every `cyberdeck_worker_ctl` action first authenticates through one lease renew, which validates
token, identity, and lease version and writes the audit record carrying actor, time, controller, and
reason. Stop escalates graceful before forceful: force requires an already-requested graceful stop
plus a grace period, acts only on the broker-owned process, and writes lifecycle `stopped` so no
bookkeeping lingers active. Redirect and checkpoint prompts ride the instruction queue, so a busy
worker keeps its turn and answers at its next turn boundary.

Recovery is a survey then an atomic take. `{action: adopt, scope: all-eligible, preview: true}`
returns the eligible set with its recoverable state alongside blocked cases —
`LEASE_CONFLICT`, `WORKER_TERMINAL`, `ALREADY_CONTROLLED`, contested leases, and subjects the broker
no longer knows — and mutates nothing. Executing adopts each eligible subject under one plan; if any
planned subject fails, the already-adopted ones are released by compensating mutation and the result
reports `ADOPTION_ABORTED` with zero net ownership change. Ambiguous subjects are never touched, so
a recovery sweep cannot contest a live worker owned by someone else.
