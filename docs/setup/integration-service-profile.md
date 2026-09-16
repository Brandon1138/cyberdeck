# Broker-owned integration service profile

`postgres-fixture-v1` is a fixed application capability, requested with an existing execution
identity, attempt UUID and current lease version. The broker resolves the canonical family and
authorizes that identity on admission and again before launch and during readiness/test polling.
Callers cannot provide an image, command, environment, port, mount or network. The implementation
does not expose the engine socket, use Docker-in-Docker, attach ordinary workers to a service
network, or publish host ports.

Configure the required immutable PostgreSQL image ID (`sha256:` and 64 lowercase hex digits).
There is no default tag, pull or host fallback. The image must support the ordinary PostgreSQL
entrypoint, `postgres` user, `/var/lib/postgresql/data`, `pg_isready` and `psql`; a distribution
with additional image-declared writable volumes is refused by boundary inspection. Installing
another image is a separate operator action. Changing a recipe requires a versioned broker
implementation and fresh proof; workers cannot register recipes.

The broker creates a new internal bridge network, a labeled named tmpfs volume capped at
128 MiB, a PostgreSQL service (384 MiB, 0.5 CPU, 96 PIDs) and a fixed SQL test runner (128 MiB,
0.5 CPU, 32 PIDs). The aggregate reservation is 640 MiB, including a conservative additional
128 MiB envelope for shared tmpfs pages. Container memory and swap are equal; roots are
read-only, capabilities dropped, privileges disabled, temporary writes bounded, and logs rotated
at one 1 MiB file per container. Data and writable caches are never shared across attempts.

The service must become healthy in 60 seconds. The runner gets 30 seconds and performs a
transactional schema migration, insert/read assertion, rollback, and assertion that the schema
was rolled back. Exit zero and the fixed success marker are both necessary for verified-pass.
Engine command timeouts bound individual calls separately; these are polling deadlines, not
claims of instantaneous cancellation. The current recipe is a small capability fixture; it is
not evidence that a representative Start Parking service set fits this envelope.

`IntegrationServiceExecutor.run()` returns a durable capacity decision without provisioning when
queued/infeasible, or a terminal result with evaluation disposition, cleanup status and manifest
path. The private credentials file holds a unique password and scoped endpoint for that run.
It is never returned to the worker and is removed after confirmed teardown. Connect the terminal
result to the attempt's evaluation outbox at broker composition. Queued cancellation can use
startup-style `recover()` to cancel pending admission and reconcile absence.

Each engine object carries broker/execution/worker/generation/attempt/lease/recipe ownership.
Recovery manifests persist intent before resource admission. Startup `recover(request)` uses
that persisted binding and pinned recipe, stops only matching containers, fsyncs bounded logs and
exit/OOM evidence before deletion, and confirms both containers, volume and network absent before
releasing reservation. No prune operation is used. Label mismatch, engine unreachability, a
foreign attachment preventing deletion, or failed evidence writes retain the reservation and
report incomplete cleanup. Recovery does not require a lease that may already have expired.
Startup `reconcileAll()` validates up to 1,024 manifests before any recovery mutation, rejects
malformed or misbound entries and symlinks, and returns each exact request with its recovery result.
Admission must remain closed when reconciliation throws or any returned cleanup is incomplete.
Bind `executor.verifyTermination(reservation, evidenceId)` into the shared admission verifier;
it checks the durable manifest, exact resource request, reservation ID and canonical evidence hash.
Serialize these operations through the single installation budget owner.

`scripts/prove-integration-service.ts` exports `proveIntegrationService`. Supply the actual
shared-budget executor, verified OrbStack client, authorized request, exact SHA and evidence path.
The helper snapshots container IDs/state/ports, volumes and networks before and after the real
run, writes the result, and fails unless the SQL test passes, cleanup completes and the inventory
is unchanged. It intentionally creates no independent budget owner and performs no automatic
provider, native build or Docker proof on import. The orchestrator must serialize this live lane
and preserve all foreign Start Parking services. Mocked tests are source/lifecycle evidence only;
real service, cancellation/crash/OOM, concurrent-fleet and representative-project evidence remain
separate acceptance gates.
