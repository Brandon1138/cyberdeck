# Resource launch accounting foundation

`ResourceExecutionGate` wraps `SessionRuntimeAssembly.spawnPreparedLaunch`, including provider preparation and the existing worker/Orc launch distinction. Codex Orc launches continue through the existing first-party adapter and direct runtime factory. The optional `resourceExecution` registry collaborator is the composition seam; absence preserves legacy behavior and is not evidence that accounting is enabled.

Composition supplies canonical family resolution, a versioned demand envelope, precise runtime identity capture, and authoritative whole-runtime inspection. Family identity must come from the existing controller/lease bindings. `demand(sessionId, generation)` exposes only an admitted generation's envelope for container limit validation. Queue health comes from the shared admission service; cancellation reaches both this gate and the existing executor queue.

A durable binding is written before reservation. Its `launching` transition is fsynced before provider preparation can spawn anything. A crash between spawn and identity capture therefore leaves held capacity, not an assumption that nothing launched. Native identities contain PID and libproc birth time including microseconds; container identities use the immutable full container ID. A delayed exit callback names the original request and cannot release a resumed generation.

The gate's `verifyTermination` callback belongs in `ResourceAdmissionService`. Release requires a matching reservation and either a proven never-launched state or authoritative termination with a complete lifetime inventory. PTY exit, missing root PID, transport failure, an empty instantaneous process sample, and unknown ownership are insufficient. Stored identities cannot regress or silently disappear. `ResourceRuntimeRecovery` is a read-only verifier with injected probes; its completeness callback must include reparented and previously observed descendants. Sampling alone does not prove completeness.

Startup calls `gate.reconcile()` before admitting work. An unbound launch that cannot be authoritatively discovered keeps admission closed. The broker must also reconcile preexisting managed resources outside this ledger and close admission when attribution is incomplete. Periodic cleanup may retry `gate.release(requestId)` after confirmed cleanup; failed release keeps the reservation visible. Shutdown must close the gate and drain its starts before releasing the installation owner.

## Installation ownership

Build `infra/resources/resource-owner-lock.c` as a separately configured absolute executable. Pass `acquireResourceOwnerLock(executable, lockPath, onLost)` through `ResourceReservationStore.open(..., { acquireOwner })`. The helper holds `flock(LOCK_EX | LOCK_NB)` on a private persistent inode until stdin closes or the helper exits. No stale inode is unlinked. The `onLost` callback must drain/close admissions. Every ledger/binding operation checks owner lifetime.

The persisted `resource-owner-mode` prevents participants using legacy `wx` and kernel locking from sharing one directory with different exclusion protocols. Legacy mode remains available for backwards-compatible source tests and fails closed after a crash. Switching a persisted mode requires an explicitly drained migration; neither implementation silently removes the marker or a legacy lock. All test brokers in one installation must use the same owner directory rather than independent budgets.

## Evidence and remaining scope

Deterministic tests cover reserve-before-prepare, queue cancellation, cancelled admitted work without spawn, durable reserve/spawn crash gaps, generation fencing, helper identity retention, PID reuse, Engine outage, kernel owner exclusion/reacquisition, and original provider routing. Kernel tests compile only a temporary helper and touch isolated fixture files. No provider launch, live broker mutation, or container mutation is part of these tests.

Broker composition now wires installation accounting, auxiliary owners, evaluation and parking. Calibrated profiles, complete native lifetime tracking, authenticated operational wake evidence and real eight-worker feasibility remain separate acceptance gates. It must not be described as MacBook acceptance or enabled production containment. Unknown native attribution remains held until an authoritative tracker or recovery procedure proves termination.


## Installation recovery barrier

The broker leaves admission closed while executor owners are composed. Session recovery
only inspects worker/orchestrator reservations; native/service and evaluator profiles
register their own read-only readiness checks. The global barrier opens only after all
held reservations have owner evidence and all required session releases are durable.
Missing owner registrations, failed releases and unknown lifetime inventories keep the
barrier closed. Owner checks must not call admission from its serialized reconciliation
callback. New queued session starts may wait during recovery without blocking that barrier.

A cancelled queued request was never admitted and can be retried at the same prospective
session generation. An admitted cancellation before provider preparation instead records
`terminationKind: "never-launched"` in the released ledger entry, derived solely from the
session owner's durable prelaunch binding. Both allow retry after restart without advancing
the canonical session generation. A released runtime that actually launched remains fenced;
ordinary termination evidence alone does not authorize another runtime at that generation.
Older binaries reject ledgers containing the new strict-schema proof field: drain and retain
the current reader during rollback rather than deleting or rewriting the ledger.


Holding a reservation and permission to begin execution are separate. `request()` returns
waiting-capacity whenever installation recovery, pressure, capture or drain holds apply,
including requests already reserved before a crash. Owner cleanup may use the exact-request
read-only `lookupReservation()` to recover the original reservation ID under a hold; it
must not use this lookup to launch a runtime. This avoids both recovery deadlock and a
preserved prelaunch reservation bypassing an unrelated owner's unresolved recovery.
Canonical typed lease-authentication failures are translated at the auxiliary authorizer
boundary to explicit revocation; transport/read failures remain temporary unavailable.


## Durable interactive launch receipts

Resource-managed fresh starts persist a private `SessionLaunchIntent` before activation.
The `preparing` phase cannot replay: only successful existing grant/budget activation permits
`ready`. The intent holds the original initial input (including deferred Cursor input),
provisioned workspace and provider selection, stable session/generation and resource request ID.
It never serializes callbacks, launch environment or generated arguments. A fsynced catalog
row and asynchronous starting receipt expose `waiting-capacity` or `waiting-authority` to
Fleet, worker truth and Orc status/start results. Pending workers occupy the existing count
limit once; an Orc receipt also preserves its activated binding before it returns.

Recovery arms ready intents without waiting for capacity, reuses the exact durable resource
request and FIFO sequence, and preserves admitted prelaunch reservations through the global
recovery barrier. Accounting ownership does not grant permission: launch still requires an
active parent (when present), the existing canonical family and all installation holds to clear.
An interrupted parent or missing/rebound authority remains an explicit authority wait.
A durable `waiting-authority` eligibility hold excludes that exact request from scheduling
without changing its FIFO sequence. A previously admitted prelaunch claim returns to the
same queue position only after the owning gate proves `never-launched`; launching/bound or
unknown proof retains capacity. This lets a parent reacquire capacity to resume before its
children become runnable. Eligibility and authority are rechecked before preparation. No
controller or callback is reconstructed from the private payload.

A compare-and-set intent fence and resource `launching` fence precede provider preparation.
Any crash at or beyond either fence becomes interrupted/unverified and never resubmits the
initial prompt. Automatic recovery is restricted to provably prelaunch work. An interrupted
launch cannot use ordinary conversation resume; its preserved work and runtime accounting
need inspection before the operator requests fresh work. Cancellation persists a terminal
intent before acknowledgement, aborts waits, and remains cancelled after catalog-write gaps
or deletion. Cancellation never claims a live or uncertain process has terminated.

The owner-scoped 0600 snapshot caps original input at 1 MiB each, 256 nonterminal intents,
384 total intents and 16 MiB total. Terminal input is retained with immutable terminal time and source phase until evaluation capture; a full store applies backpressure rather than dropping it. `ackTerminal` removes only the exact terminal request/time after its evaluator owner confirms capture; mismatched or nonterminal acknowledgements fail. Ready authority waits retry every 250 ms and
expire after seven days; no automatic provider launch retry occurs. Persistence or schema
failure fails closed. These deterministic contracts do not establish calibrated envelopes,
native whole-lifetime termination proof, authenticated provider success, or W1 acceptance.
