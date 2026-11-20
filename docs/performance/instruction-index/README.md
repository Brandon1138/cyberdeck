# Indexed instruction reads

The broker can keep a Rust instruction index in a disposable child process. It answers lookups by instruction ID, original or effective target, and unsettled status. Recovery requests unsettled instructions. Ordinary delivery requests its target mailbox. Resident delivery still sees all instructions when routing requires it. TypeScript remains the default reader and owns writes, fsync, authority, and dispatch in both modes.

## Broker measurements

Median of three fresh processes per cell, with mode order rotated. Time runs from importing broker modules through the first successful target-specific RPC over an isolated Unix socket. Each journal contains completed instructions and there are zero live providers. Memory is the largest observed simultaneous sum of RSS for the benchmark process and its immediate children. It can double-count shared pages and miss peaks between samples.

| Workload | Main time / MiB | Indexed TS time / MiB | Rust time / MiB |
| --- | ---: | ---: | ---: |
| Small, 64 snapshots / 32 instructions | 820 ms / 137 | 787 ms / 138 | 867 ms / 140 |
| History, 50,000 / 576 | 1,401 ms / 356 | 1,482 ms / 356 | 990 ms / 146 |
| Wide, 10,000 / 10,000 | 1,301 ms / 322 | 1,086 ms / 214 | 1,184 ms / 196 |

## Store measurements

A second set of fresh processes queries a cold target mailbox, performs 48 warm target queries, then overlaps 48 queries with four normal authority-guarded, fsynced writes. It finishes with a full listing, checks cardinality, updated statuses and a projection digest across modes. RSS covers this entire sequence. Loaded p99 is the slowest of the 48 reads in each trial. The raw samples also include median warm latency, write time, and maximum event-loop delay.

| Workload | Implementation | Cold lookup | Loaded p99 | Sampled peak RSS |
| --- | --- | ---: | ---: | ---: |
| Small | Main | 18.9 ms | 8.1 ms | 75 MiB |
| Small | Indexed TS | 16.2 ms | 10.8 ms | 73 MiB |
| Small | Rust | 34.0 ms | 27.0 ms | 75 MiB |
| History | Main | 534.8 ms | 125.8 ms | 321 MiB |
| History | Indexed TS | 480.0 ms | 135.7 ms | 303 MiB |
| History | Rust | 134.4 ms | 54.5 ms | 84 MiB |
| Wide | Main | 137.2 ms | 91.5 ms | 776 MiB |
| Wide | Indexed TS | 108.4 ms | 32.0 ms | 177 MiB |
| Wide | Rust | 58.4 ms | 18.7 ms | 146 MiB |

History-heavy recovery is the clearest case for native reads. Indexed TypeScript accounted for much of the improvement on wide retention and delivered the fastest whole-broker startup there. The small-journal measurements favor keeping native mode optional. Three runs on one ordinarily loaded Mac give a local comparison. Terminal rendering, long-session memory growth, and provider activity require a separate workload.

## Validation and fallback

Every request opens the current path and checks the descriptor and path identity. On change, the helper hashes the committed prefix before applying new complete lines. Replacement, truncation and same-inode edits are supported. A validation error discards the entire helper. Node accepts only complete replies and validates returned records against the application schema. On a timeout, helper crash, unsupported record shape or missing binary, the same request goes through the TypeScript reader. Its normal validation errors propagate. The next request after 30 seconds can rebuild the native index. A successful native read releases the temporary TypeScript fallback cache.

The helper exits on broker pipe closure. Broker shutdown also disposes it explicitly. Use `ps -axo pid,ppid,command` to inspect `cyberdeck-broker`, `cyberdeck-fleet`, and `cyberdeck-index`. On the test Mac, the Node roles appeared correctly in `ps` command and comm columns. The kernel ucomm field still showed `node`.

## Reproduce

Measurements used Apple M4 Pro, macOS arm64, Node 24.18.0 and Rust 1.97.1 in release mode. Build a clean baseline checkout of commit `5d8c011586989447c49f154ffd8ad50070c2db3b` with the same Node and dependencies. On the candidate, run the commands below. The benchmark creates synthetic journals in temporary directories. Its optional broker workload uses a unique socket for each sample.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:native
node --test tests/scripts/native-instruction-index.test.mjs
pnpm bench:index /path/to/built-baseline /tmp/instruction-store.json
pnpm bench:index /path/to/built-baseline /tmp/instruction-broker.json broker
```

Set `CYBERDECK_INSTRUCTION_INDEX=rust` in the broker launch environment to opt in after building the helper on that platform. The ordinary TypeScript build needs no Rust toolchain. A local package built with the helper includes the binary for that platform. A package built without it uses TypeScript.

The raw [store results](macos-arm64.json) and [broker results](broker-macos-arm64.json) cover 54 fresh processes in total.
