# Native resource profile

`NativeToolExecutor` runs a broker-installed, hash-pinned Xcode recipe under the
same `ResourceAdmissionPort` as other managed work. This is an implemented native
execution adapter, **not a completed W9 acceptance claim**. No live simulator or
Xcode workload was run while implementing this adapter.

A worker request contains only `requestId`, `attemptId`, `executionId`,
`generation`, and `recipeId`. Broker composition supplies an `authorize` callback
that validates the current canonical controller, attempt, execution generation,
capability, and write policy, and returns the verified source root/manifest and
canonical family. The callback runs again after admission. Read-only grants are
refused before reservation. Caller-controlled commands, paths, flags, developer
directories and simulator identifiers are not accepted.

Recipes specify a reviewed project/scheme, input-manifest hash, installed Xcode
developer directory, iOS simulator runtime/device type, unsigned build or test,
timeout, input/artifact disk envelopes and a resource demand. Project files,
Swift package plugins and build scripts are executable code: **review and pin the
entire input manifest**, not just an Xcode project filename. A new source version
needs a newly authorized recipe hash. Do not install a recipe that reads secrets,
downloads arbitrary dependencies, signs, installs on a device or deploys.

The executor creates an exclusive per-request directory beneath a private broker
root, copies only hash-verified regular files into `input/`, and launches with a
fresh `HOME` and `TMPDIR`, a fixed system PATH and the pinned developer directory.
Source files are read-only; outputs go into `artifacts/DerivedData`,
`artifacts/Result.xcresult`, and `artifacts/xcodebuild.log`. No caller credentials
or environment variables are inherited. Filesystem permissions here are hygiene:
native execution still runs as the operator and **does not have container-level
filesystem or network isolation**. Only trusted recipes may cross this boundary.

After admission, `simctl create` creates a fresh simulator; its returned UUID is
fsynced into `simulator.json`. Xcode receives only an iOS Simulator destination
with that UUID and uses one build job, no parallel simulator testing, no signing,
and no automatic package resolution. Finally, shutdown and delete address only
that UUID. Existing simulators are never selected by name, `booted`, or `all`.
Logs, source snapshots, result bundles and cleanup results survive cancellation.
`result.json` links the terminal result to the originating request. The broker's
`settled` callback must persist the evaluation/outbox intent before capacity is
released. An outbox failure retains the binding for reconciliation.

`MacosNativeProcessSupervisor` starts an inert Node IPC gate, records its exact
libproc PID/birth identity durably, then permits the command. It retains observed
descendants across reparenting, monitors their physical footprint/PIDs and the
run-directory disk usage, and rechecks each birth identity immediately before
individual termination signals. It never kills by process name, PID group, or
global simulator shutdown. Polling is an operational limit with possible
overshoot, not instantaneous kernel containment. Cancellation may retain an
unknown process rather than risk signalling an unverified identity.

## Admission release and recovery

The native binding is persisted before launch. A prelaunch failure can release
with `native-<requestId>-not-launched`; composition must verify the terminated
binding has no launched identity. A launched run releases only when the broker's
`proveTermination(request, identities, directory)` attests **complete lifetime
process and simulator-service ownership plus termination**. Its evidence ID is
`native-<requestId>-terminated`. Register these IDs with the shared admission
verifier; don't turn an arbitrary evidence string into release authority.

Without that stronger verifier the actual build/test result is returned, but
`cleanup: unproven` retains the reservation. A current PID-table scan, successful
`xcodebuild` exit, successful simulator deletion or an empty current descendant
list does not prove the entire lifetime inventory. Launchd can spawn/reparent
compiler and simulator helpers outside the sampled ancestry. On the inspected
Xcode 27 SDK, `sys/event.h` says `NOTE_TRACK`, `NOTE_TRACKERR`, and `NOTE_CHILD`
have been unsupported since macOS 10.5; `NOTE_FORK` does not deliver the child
PID. Those kqueue flags cannot close this gap. A process-event authority and
simulator-service ownership reconciliation remain required for automatic release.

Recovery inspects the durable request, binding identities, simulator UUID, tool
logs, and cleanup results. It must preserve the reservation when creation ended
before its UUID could be recorded, identity capture failed, the broker crashed,
or service ownership remains uncertain. Never clear reservations merely to make
the next proof fit. Retain workspace/artifact directories under the installation's
bounded evidence-retention policy; this adapter never deletes uncollected work.

## Capability fixture and remaining acceptance

`tests/fixtures/native-resource/NativeResource.xcodeproj` is a small unsigned iOS
app and hosted XCTest target. The shared `NativeResource` scheme checks a pure
normalization function inside the simulator. It has no packages, run scripts,
signing identities, device deployment or production accounts. Build a manifest
with `workspaceManifest(fixtureRoot)` and pin `nativeManifestHash(manifest)`;
configure an installed iOS runtime/device type and an explicit measured envelope.
Use `action: "test"` to build and execute the hosted test in the owned simulator.

Root orchestration serializes live proof: first this fixture, then a pinned
representative Ammo worktree. Record exact SHA, manifest/profile hashes, host
and CLI versions, reservation/physical observations, simulator/compiler/service
ownership uncertainty, output bundle, exit status, cancellation, artifact
preservation and cleanup. W9 stays open until actual success, coding-fleet
coexistence, responsive control and complete ownership/reconciliation evidence
are demonstrated within the unchanged 8 GiB installation budget.
