# Resource-managed operation

This candidate is **not activation-ready**. Source checks are separate from a working 8 GiB
fleet. Read the exact-candidate acceptance record before using it. The primary checkout and
live broker remain the running installation until an operator-approved safe window.

## Installation boundary

Use Node 24.18.0 and pnpm 11.5.0. Build from an isolated, clean, recorded source commit. The
worker and offline evaluator images must be built from that same commit in the serialized,
resource-accounted proof lane, then pinned by full image digest. Neither an old image tag nor
a passing host unit suite proves the candidate image. OrbStack owns the configured Unix
endpoint; guests receive no Engine socket. Foreign projects' containers, networks and volumes
must retain the same identities and state before and after tests.

The installation has one durable resource directory, UUID and owner-lock helper. Every broker
for that installation shares this policy and cannot acquire a competing writer lock. Unique
headless test installations use separate directories, sockets and identities. Explicit external
control-process roots include the implementation tools/Fleet and other Cyberdeck processes
while they are present. PID birth identity changes require reinspection, never a guessed PID.

The policy is exactly 8,589,934,592 bytes. Count ceilings must permit eight light workers;
they do not establish that eight authenticated processes fit or make progress. Native control,
worker/helper envelopes, evaluator, auxiliary profiles and attributable VM overhead spend the
same budget. Current whole-VM accounting remains conservative and uncalibrated: it can double
reserve guest memory. Do not remove its hold to obtain a passing workload.

## Prepare a private configuration merge

Prepare a private JSON patch containing only `resourceManagement`, `containerRuntime`,
`workerExecution`, and `maxConcurrentWorkers`. Supply measured profile envelopes, current
birth identities, verified image digests and broker-owned native recipes with immutable input
manifest hashes. Keep provider credentials in their existing per-machine private locations;
use subscription authentication, never API-key fields. Preserve existing Sentry settings.

`scripts/prepare-resource-config.ts` accepts the existing private configuration, private patch
and a **new** absolute staging directory. It validates the budget, required profiles, default
container routing, subscription mode and count ceilings. It writes mode-0600 original/proposed
files and a hash-only manifest. It never overwrites the live config or restarts anything. A
valid merge is a reviewable proposal, not live acceptance. Do not put these secret-bearing
configurations in a commit, public artifact or telemetry payload.

## Drain and safe activation

On an already resource-managed installation, `cyberdeck resource health` reads cached state;
`cyberdeck resource drain` stops resource and job-count admission while admitted work finishes.
It does not kill workers, consume queued instructions, park busy tools, or remove artifacts.
The hold is visible as `draining`. Drain is idempotent and lasts for that broker lifetime;
restart reconciles durable reservations before reopening admission. A pre-upgrade broker has
no resource drain method: arrange an actual idle operator window rather than issuing it there.

Before stopping, collect session/job/instruction, parking, profile, evaluation, resource and
telemetry health. Confirm no in-flight tools, reports, native cleanup debt or uncollected work.
Do not treat a `done` row, exited root PID, empty exporter queue or expired lease as this proof.
Archive private state using a filesystem-consistent copy only at a safe quiescent boundary.
Record source commit, packaged CLI hash, worker/evaluator/service digests, config hashes and
the original broker identity. Then recheck the live config still matches the reviewed original
hash. The operator approves the concrete replacement commands only after all independent gates
pass; no activation commands are claimed ready by this document.

After authorized replacement, use the actual default socket and omit executor selection in
Claude and first-party Codex canaries. Confirm container execution, current generation,
subscription authentication, real tool/report progress, resource accounting, automatic
evaluation disposition and a matched fresh workload Sentry receipt. Explicit-container canaries
against another broker do not prove defaults. Keep all raw evidence private and bounded.

## Recovery and rollback

Restart replays resource bindings, instruction terminal receipts, job snapshots, auxiliary
cleanup obligations and evaluation intents. An unreachable Engine or unknown native lifetime
retains capacity. Repair the specific owning runtime/credential condition; do not delete its
ledger, clear its lock file, reset a lease token, or prune Engine resources globally.

Do not downgrade new-format live journals into the original broker. Rollback requires both the
recorded original binary/config and its quiescent state snapshot. Preserve all newer journals,
workspaces and artifacts in a separate private archive for forward recovery; rolling back a
snapshot can otherwise lose queued work. If any new work exists, stop for a reviewed recovery
plan rather than restoring over it. Rollback is not currently proved for this candidate.

## Remaining operational gates

Native Xcode/simulator launch is explicitly weaker OS isolation. Current sampling cannot prove
all reparented/compiler/launchd descendants exited, so native reservations remain held. A
reliable lifetime/service ownership mechanism and actual unsigned-fixture plus representative
project proofs are still required. Subscription refresh likewise needs an admitted supported
host transport; a protocol helper alone is not operational refresh.

Require three real eight-worker W1 runs, two-family fairness, heavy/helper/transcript/parking/
evaluation tests, both auxiliary profiles and the full 24-hour soak. On the first evaluation
initialization, legacy terminal instructions with neither historical generation nor terminal
projection receive sealed snapshot dispositions marked unverified. They are not reconstructed
attempts or model-quality samples. The snapshot cannot grow after startup; changed/new missing
projections still hold admission. A prior evaluation checkpoint without the migration seal
requires reviewed migration rather than silently widening coverage. Interrupted-job supersession must
be resolved by canonical job ID before counting model-quality samples. No model comparisons
or completed deployment are inferred from missing evidence.

For a future mini, record Node/provider versions, OrbStack startup, private state ownership,
subscription login/Keychain, FileVault/login requirements and SSH/tmux recovery. Keep tests
headless until nvim alternate-checkout/version/namespace ownership is resolved. MacBook results
do not replace the later physical M4 mini gate or prove unattended startup past login authority.
