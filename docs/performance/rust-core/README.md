# Rust-core replay benchmarks

Decision: [ADR 0001](../../adr/0001-incremental-rust-core.md). Raw samples:
[`2026-11-05-macos-arm64.json`](2026-11-05-macos-arm64.json).

The first production-path measurement supports an opt-in native replay worker for
history-heavy mailboxes. It does **not** justify making this IPC boundary the default
for every workload. A Rust core remains the direction; boundary placement is an empirical
decision, and TypeScript remains a supported application and rollback path.

## 2026-11-05 baseline

Apple M4 Pro, macOS arm64, Node 24.18.0, Rust 1.97.1 release profile. Five fresh processes
per mode/workload, rotating mode order, five warm reads per process. Medians below.
The host remained in ordinary use; no test suite or build ran concurrently with this
recorded measurement. These are local observations with noise, not population estimates.
The JSON records ranges implicitly through every raw sample, fixture hashes, source/built
file hashes, base HEAD, dirty-state flag, binary hash and toolchain identity.

| Synthetic workload | Existing uncached TS | Cached TS | Streaming cached TS control | Integrated Rust + TS |
| --- | ---: | ---: | ---: | ---: |
| Small: 64 rows / 32 retained, 37,556 bytes | 3.17 ms | 3.55 ms | 3.60 ms | 7.18 ms |
| History: 50,000 rows / 576 retained, 55,088,889 bytes | 240.68 ms | 242.02 ms | 293.41 ms | 161.55 ms |
| Wide: 10,000 rows / 10,000 retained, 5,888,888 bytes | 73.08 ms | 86.57 ms | 75.64 ms | 114.33 ms |

These cold-operation timings include opening/validating the journal, worker startup and
pipe transport in Rust mode, host schema validation, projection publication and caller cloning
for cached modes. Module/process startup is recorded separately as `startupMs`; `processWallMs`
includes startup, the cold read, **all five warm reads**, and shutdown. OS page cache is warm;
these are cold application projections, not cold-disk tests. Legacy mode reproduces the old
uncached algorithm without an additional clone, while cached modes have matching clone semantics.

On history, Rust is 1.50× as fast as cached TypeScript and 1.82× as fast as the streaming
TypeScript control. The same boundary is 1.32× slower than cached TypeScript on wide retention
and adds about 3.6 ms on the small workload. The wide case returns and validates many more
objects across the JSON boundary; that is a plausible explanation, not a separately isolated
causal measurement. A different boundary may do better and must be measured before adoption.

| History memory / warm latency | Existing uncached TS | Cached TS | Streaming cached TS | Rust + TS |
| --- | ---: | ---: | ---: | ---: |
| Node peak RSS through cold read | 332.58 MiB | 347.16 MiB | 142.11 MiB | 99.75 MiB |
| Standalone Rust helper peak RSS | — | — | — | 3.66 MiB |
| Same-process warm read | 202.80 ms | 1.18 ms | 1.27 ms | 1.28 ms |

Node RSS comes from `process.resourceUsage().maxRSS`; the helper's RSS is a separate execution
on the same fixture measured using Python `os.wait4`. These are **separate process peaks**, not
an observed simultaneous process-tree peak. In particular, 99.75 MiB is not the total hybrid
memory. On wide retention, Node peaks are 128.50 MiB for cached TS, 106.48 MiB for streaming TS
and 115.39 MiB for Rust mode, with a separate 15.88 MiB helper peak. There is no demonstrated
memory advantage over streaming TypeScript for that shape. No whole-broker, provider-process
or deployed production memory reduction is claimed.

The large warm-read gain comes from validated caching, which both implementations share.
Rust does not receive credit for that algorithmic improvement. The native result is also much
more modest than the earlier standalone experiment: the Node application and JSON boundary
continue to exist in a hybrid application.

## Reproduce

Use supported Node/pnpm and the repository's pinned Rust toolchain, with Python 3 available:

```sh
pnpm build
pnpm build:native
pnpm test:native
pnpm bench:core /tmp/cyberdeck-core-benchmark.json
node scripts/check-native-package.mjs
```

`CYBERDECK_BENCH_ROUNDS=10 pnpm bench:core /tmp/core.json` changes the sample count.
Fixtures are generated in a private temporary directory and removed after the run. The
benchmark never reads the operator's Cyberdeck state or starts a broker/provider. All four
implementations must produce identical normalized projection digests and retained counts,
otherwise the run fails. Preserve the raw JSON with each decision; do not compare unmatched
fixtures, debug Rust builds, different host classes or concurrent test/build load as a language result.

The Rust-core CI workflow repeats correctness tests, packed-worker execution and benchmarks
on macOS arm64, Linux x64 and Linux arm64. Projection mismatch is a hard gate. Timing is an
artifact for review rather than a brittle shared-runner threshold. CI results are independent
of this local macOS baseline; a configured matrix is not proof that those jobs passed.

## What this establishes

The integrated boundary preserves outputs on these generated workloads and can reduce cold
replay cost for history-heavy instruction journals. Differential tests additionally cover
schema boundaries, historical corruption, ordering, caching and worker failure. Two Rust
compile-fail examples exercise private validated construction and consuming publication.
Those tests do not prove crash consistency, stale-fence rejection, provider readiness or
exactly-once delivery. The first slice owns no writes or authority; the ADR requires those
invariants and failure matrices to accompany subsequent migrations.
