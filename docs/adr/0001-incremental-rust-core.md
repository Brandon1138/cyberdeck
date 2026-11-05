# ADR 0001: Move toward a Rust core through measured, reversible slices

Date: 2026-11-05

Status: Accepted direction; first slice proposed in this PR. Default activation remains a separate decision.

## Context

Cyberdeck is a durable local control plane. Session identity, recovery, instruction delivery,
authority, subprocess ownership, and resource use matter more than language uniformity.
Its maintainer wants to retain architectural ownership while delegating implementation to agents.
Reducing the personal cost of learning Rust makes a systems-language core practical; it does
not eliminate the need to understand the invariants, review boundary code, or evaluate evidence.

The 2026-11-05 local experiment compared existing TypeScript with streaming TypeScript and
Rust on Cyberdeck journals. On a sanitized instruction history (48,703 snapshots, 576 retained
instructions, approximately 52 MB), standalone Rust replay took a median 132.63 ms versus
504.79 ms for existing TypeScript and 454.55 ms for a streaming TypeScript control. Peak
process RSS was 5.55, 379.88, and 111.23 MiB respectively. These are **standalone experimental
processes**, not the memory or latency of the hybrid application shipped here.

Other results constrain the decision: 500 fsynced lease writes were essentially tied
(1,837.23 ms Rust versus 1,886.71 ms TypeScript). A Rust stale-fence mutant and a missing-fsync
mutant compiled. Compiler checks rejected ownership/type-state misuse, but did not establish
authority or durability correctness. The direct port preserved an existing torn-tail append
problem. An initially incorrect recovery gate also demonstrated that a port can introduce bugs.
These observations support a staged core migration, not treating compilation as operational proof.

The follow-up production-path benchmark is committed under
[`docs/performance/rust-core`](../performance/rust-core/README.md). It includes the actual
subprocess boundary, host decoding/validation, a streaming TypeScript control, cached reads,
raw samples, fixture hashes and toolchain versions. Public fixtures are generated synthetic
data; no user journal, credential, prompt, or real provider session is needed to reproduce them.

## Decision

Adopt **Rust core / TypeScript application** as the direction. Hybrid operation is supported
for as long as it is useful. Keep CLI, Fleet UI, provider integration and product iteration in
TypeScript until a specific boundary has a demonstrated reason to move. Avoid a flag-day rewrite.

The first production-capable slice is opt-in cold instruction-journal replay. It has a narrow
pure transformation contract and an existing schema oracle. `CYBERDECK_INSTRUCTION_REPLAY=rust`
selects a short-lived native worker. The default remains `typescript`; invalid selections fail
at construction. Cache metadata checks, ordering, cloning, filtering, fsync and all writes remain
owned by the TypeScript host. Caching is applied equally to both backends and is not credited
to Rust in comparisons. Each cold revalidation spawns one worker; warm reads spawn none.

The host opens the file once and streams that descriptor through stdin. It checks descriptor
metadata before and after replay, then the current pathname identity. Changes cause revalidation
(at most three attempts). Cache publication requires a complete versioned response, successful
schema validation of every retained record, the correct unique count, exhausted input, and exit
zero. No partial projection or automatic fallback is published after a native error. A missing
file projects empty state without needing a worker. No timeout cache is used as authority.
Failures report an allowlisted category and historical line number; stderr collection is capped
at 4 KiB and arbitrary worker text is not exposed. Native diagnostics never echo journal content.

The worker command is `cyberdeck-core instruction-replay-v1`. Its stdout consists of:

```jsonl
{"protocol":1,"schema":"instruction-v1"}
{"id":"...","actorSessionId":"...","targetSessionId":"...","messageId":"...","message":"...","status":"queued","createdAt":"...","updatedAt":"...","hop":0}
{"end":true,"records":1}
```

Every line ends in LF. Invalid complete historical records fail replay even if superseded.
An unterminated last record is ignored, matching the existing reader. Latest values preserve
first-insertion order. Legacy `delivered` maps to `rendered`. ECMAScript trim semantics, UUIDs,
safe integers, optional-field null rejection, timestamps and wake context are differential-tested.
Unknown fields are ignored, as in the current Zod schema. Domain schema changes must update the
native contract and the differential corpus in the same PR; incompatible changes require a
new command/schema version. There is no claim that the Rust compiler verifies Zod compatibility.

Native v1 deliberately fails closed on invalid UTF-8, lone JSON surrogates, non-finite JSON
numbers (including in ignored fields), excessively nested
JSON (serde_json recursion guard), input/output records over 16 MiB, output over 128 MiB, or a
worker exceeding 120 seconds. TypeScript can accept some of these inputs. These differences
are part of the opt-in contract, not silent equivalence claims; writers still use the existing
schema, so oversized records must be avoided or replay switched back to TypeScript. There is
no hard total-memory bound on the retained projection in this first slice. The worker has no
filesystem-writing code or authority operation; it is not an OS security sandbox.

## Compiler guarantees and runtime obligations

`unsafe` is forbidden in this crate. `ValidatedProjection` has a private constructor and
consuming publication method, with compile-fail tests for fabricated and reused projections.
All historical records pass through validation before that value exists. Rust's
[ownership rules](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)
enforce ownership inside this boundary. This is a useful agent feedback loop: invalid lifetime
and ownership choices must be corrected before an executable is produced.

Compiler acceptance is insufficient for journal semantics, schema fidelity, process cleanup,
crash recovery, fencing, fsync or exactly-once effects. The TypeScript adapter initially closed
its borrowed descriptor during stream cleanup; integration tests caught that error, and the
adapter now uses positional reads without owning the descriptor. Failure injection, differential
tests and explicit host checks remain release gates. Avoid spreading `clone`, shared mutable
state, panics or unchecked conversions merely to get an agent's implementation compiling.

## Build, activation, rollback and distribution

Use the repository's Node/pnpm versions and the pinned Rust toolchain:

```sh
pnpm build
pnpm build:native
pnpm test:native
pnpm bench:core /tmp/cyberdeck-core-benchmark.json
node scripts/check-native-package.mjs
```

`build:native` compiles a release binary and copies it to source and built runtime locations
under `native/bin/<platform>-<arch>` and `dist/native/bin/<platform>-<arch>`. Cargo.lock is
committed. The package includes binaries that were explicitly built; it does **not** promise
all architectures in every npm tarball. A normal TypeScript build remains Rust-independent.
The first supported native distribution is a source build or matching-host packed artifact.
CI validates macOS arm64, Linux x64 and Linux arm64. macOS x64 is buildable but has no CI claim.
Cross-platform release aggregation, checksums/signing and automatic binary installation require
a later distribution decision before native replay becomes the default for published packages.

To opt in, supply `CYBERDECK_INSTRUCTION_REPLAY=rust` to a newly started broker using the built
artifact. Changing a client environment does not reconfigure an already running broker. Start
with an isolated, synthetic journal; then observe startup/recovery failures, CPU/RSS and response
latency on an intentional deployment. This PR neither restarts nor reconfigures a live broker.
To roll back, start the same application with `CYBERDECK_INSTRUCTION_REPLAY=typescript`.
The journal format and TypeScript write path are unchanged, so no migration or reverse migration
is required. On native errors, surface failure and investigate; do not hide it with implicit fallback.

The existing append-after-torn-tail behavior is not repaired here. Journal repair/write ownership
needs its own crash-consistency design and tests before moving to Rust. Likewise this slice
does not establish live provider readiness, whole-broker memory reduction, or end-to-end session
delivery correctness.

## Subsequent decisions and benchmark policy

Every change to native behavior, its schema, or the host/native boundary must carry differential
and failure tests plus reproducible before/after benchmark evidence. CI records synthetic small,
history-heavy and wide-retention workloads on every PR, and fails on projection mismatch. Shared
runner timings are informational, not a flaky absolute timing gate. Significant regressions must
be explained before merge; compare matched hosts, build profiles and fixture hashes.

Each next slice gets a numbered ADR linking its invariants, compiler-enforced subset, runtime
failure matrix, resource ownership, deployment/rollback path and measured result. Report cold
and warm operation latency, process startup, throughput where meaningful, and memory of all
affected processes. Separate algorithm improvements from language improvements; retain an
optimized TypeScript control. Never label a child's RSS as whole-application RSS or sum unrelated
peaks as a measured simultaneous peak. Include raw samples and exact source/binary identity.

Prefer next: an explicit journal recovery/write transaction with crash injection, then bounded
resource and lease transactions with stale-generation/fence tests. Move provider supervision
only after cancellation, child reaping, signal and descriptor ownership have a complete test
matrix. Reassess JSON IPC versus a persistent worker or in-process boundary only if measured
boundary cost warrants the added lifecycle or FFI complexity.

Promotion to default requires passing supported-host CI/package tests, representative operational
shadow/canary evidence, acceptable small-journal overhead, no unexplained semantic divergence,
and a documented rollback exercise. Expansion is justified by an operational invariant becoming
harder to violate or a meaningful measured resource improvement. If neither improves, retain the
TypeScript boundary. Deep technical ownership means owning these decisions and evidence; it
does not require the maintainer to personally implement every layer.
