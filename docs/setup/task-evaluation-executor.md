# Admitted offline task evaluation

`TaskEvaluationExecutor` is the production execution adapter for the SQLite evaluation outbox.
It runs Promptfoo 0.122.2 inside a pinned image, using a fixed local echo provider and JavaScript
assertion. It never starts a provider, judge, API client or host Promptfoo process. Independent
host checks determine the task grade; the host checks the returned evidence byte-for-byte and
recomputes that grade. A successful profile exit alone is unverified. `profile.settled` with an
unknown outcome is an infrastructure error.

## Composition interface

Construct with `{ client, store, admission, image, installationId, directory, resolveFamily,
requiredChecks, memoryBytes?, retentionBytes? }`. `client` is the existing OrbStack-only client;
`image` must be a full `sha256:` image ID already present in that engine. `resolveFamily(intent)`
must resolve the historical canonical family or an explicitly selected operator background
bucket, and must fail when neither is available. `requiredChecks(intent)` selects a versioned,
host-owned rubric. Never derive either from worker claims or the current controller implicitly.

Register `verifyTermination(reservation, evidenceId)` with resource admission for evaluation
reservations, then await `reconcile()` before calling `runNext(signal?)`. Serialize those calls;
the adapter also blocks concurrent calls. `health()` reports progress, the reconciliation gate,
memory and retention limits. A blocked cleanup retains its reservation and durable intent;
retry `reconcile()` after resolving the reported problem. Registration does not enable execution:
the broker composition must explicitly schedule `runNext` and supply the pinned image.

## Fixed execution boundary

The default reservation and cgroup limit are 768 MiB; configuration accepts 512 MiB through
8 GiB, subject to the shared budget. Memory and swap limits are equal (no additional swap).
The image and memory limit participate in the versioned profile hash. CPU is limited to half
a core, PIDs to 64, and Node heap to 60% of memory. The 128 MiB `/tmp` and 16 MiB
`/run/evaluation` tmpfs limits are **inside** cgroup memory, not additional reservations.

The root filesystem is read-only, UID/GID is 1000, all capabilities are dropped, and
no-new-privileges is required. Network mode is `none`; no socket, credentials, device, port,
host process namespace or writable host directory is passed. The only bind is the generated,
read-only input file. Docker restart is disabled, pulling is disabled, and local logs are
bounded to one 1 MiB file. The host inspects ownership and boundaries before starting execution.
Boundary failure cleans only the exactly owned container; foreign labels/IDs block mutation.

The guest reads at most 256 KiB of input. Its fixed Promptfoo child has a 45-second deadline,
64 KiB combined diagnostic-output cap, and 512 KiB report cap. It emits only a report envelope
to stdout, including a hash of the literal input bytes. The host allows 60 seconds and captures
at most 768 KiB of retained envelope. These are infrastructure bounds, not task grades.

## Durable recovery and retention

The host fsyncs a generated run intent before resource admission and container creation. That
intent contains the private claim token, historical family, exact demand, input hash and required
checks. The guest sees no claim token. Stable request IDs recover admission-before-save crashes.
Startup collects or terminates unfinished owned runs before opening the launch gate. An expired
claim, including a long capacity wait, leaves the task pending for a fresh claim; it never writes
an artificial infrastructure grade.

After the guest exits, the host requires stopped state and PID zero, preserves exit/OOM status
and the bounded report, removes the owned container, then freshly confirms its absence. Only
then may resource admission release the reservation. Its registered verifier performs another
fresh absence query; daemon failure or a resurrected container invalidates the receipt. Results
are committed before acknowledgement; restart acknowledges an existing result without regrading.

Private evidence storage defaults to 32 MiB with at most 128 generated run directories. Admission
preflights room for an input, state and bounded report. Retention may remove only fully settled,
released runs after another fresh absence query. Unknown paths and symlinks fail closed. It never
prunes Docker globally, removes foreign objects, or evicts pending SQLite evidence. The SQLite
outbox has its own durable cap and archival policy. Budget these separately from Docker's bounded
local logs and image layers. A `.pending` atomic-write remnant blocks startup for operator review.

## Packaging and live proof gate

Build context is the repository root and Dockerfile is `docker/evaluator/Dockerfile`. The build
uses the same pinned Node 24.18.0 base as the execution images, pnpm 11.5.0, the frozen evals
lockfile and its restricted build-script allowlist. Final runtime contains the dependencies and
two guest files; it contains no provider CLI, repository checkout, host credentials or Docker
socket. Configure the resulting immutable image ID, never a tag. Image building is an explicit
operation in the serialized live proof lane.

Mocked engine tests establish admission ordering, host grading, recovery and fail-closed behavior.
They do not establish that a built image runs successfully, that Promptfoo's real JSON report
matches the adapter, or that Docker enforces the configured cgroup, tmpfs, PID and network limits.
Those require an admitted live container proof, including timeout/OOM, daemon restart and fresh
termination checks, before claiming production activation. Do not substitute a host process when
the image or engine is unavailable.
