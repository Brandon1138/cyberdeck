# Fleet and MCP performance handoff

Destination: `/Users/brandon/code/personal/cyberdeck-worktrees/fleet-performance`

```sh
cd /Users/brandon/code/personal/cyberdeck-worktrees/fleet-performance
```

Branch: `perf/fleet-worker-mcp`. Base: `b1127580872cbe7cd77224a3788464f66e3e389f`.
Implementation and regression-test commit: `f941f275e8395239248b1fe62c6d8297e90c884f`.
The following documentation commit adds this handoff, the benchmark script and raw results;
its final SHA is reported in the handoff message and available with `rtk proxy git rev-parse HEAD`.

## Base and prerequisite provenance

The original checkout was still on `main`, but had advanced from the audit's
`60c29052ac8cb253200f4ce4423994cd46855c4a` to the base above, through the mascot change
in PR #130. The original untracked `AGENTS.md`, `BUGS.md`, global instructions and RTK
instructions were read before worktree creation. No unrelated dirty changes were copied.

Only the original checkout's activity-index prepared-insert and bulk-replay transaction
changes were selectively ported, from `src/persistence/activity-disk-index.ts` and
`src/persistence/agent-activity-store.ts`. The read-only extracted patch has SHA-256
`655485aeac995e73add97eb132d8ce4b6ab0ce6c88d536f2374172c16e703c66` and remains at
`/private/tmp/cyberdeck-fleet-performance-evidence/activity-prerequisite.patch`.
The activity replay benchmark therefore includes a preserved local prerequisite, in addition
to this branch's pruning and page-read changes. It is not a comparison with the dirty audit build.

The benchmark baseline was built from the exact committed base in the new worktree before
editing. Its compiled artifacts were preserved under
`/private/tmp/cyberdeck-fleet-performance-evidence/baseline/dist`. The original checkout's
`dist` was never rebuilt. Final read-only checks found its status unchanged, all 1,802 protected
dirty/untracked and `dist` file hashes unchanged, and its HEAD still at the base SHA.

## Changes

1. **Fleet refreshes independently of visual frames.** A compact `fleet.snapshot` projection
   keeps every historical session, removes launch/instruction/image payloads from the display
   projection and joins only matching coordination and ownership rows. Existing full
   `session.list`, `thread.list` and `session.launchRecord` remain available for details.
   A process epoch plus content version supports unchanged replies and one-generation row
   deltas, including removals and explicit order. Version gaps and reconnects receive a full
   snapshot. Each connection retains one generation; a delta larger than a full reply becomes
   a full reply.

   All-session registry updates and relevant successful mutation RPCs coalesce into small
   invalidations at 100 ms. Slow sockets skip invalidations above 64 KiB of queued writes.
   The client permits one refresh in flight and one pending refresh, renders keys, resize and
   animation from its cached data, and performs a 2-second fallback validation for external
   journal edits, lease changes and missed events. Actions fence older replies and force a
   version resync. A disconnect keeps the display with a visible notice; CLI reconnect updates
   the action transport too. Failed writes are not replayed. Older brokers retain 100 ms legacy
   polling, independently of visual wakeups.

2. **Validated journal projections avoid repeated parsing.** Orchestrator bindings and Fleet
   preferences cache their validated projection. Every read checks the opened descriptor and
   current path, using device/inode, size and nanosecond modification/change timestamps.
   External changes, replacement, truncation and deletion invalidate the projection. Any
   external append triggers complete revalidation because it cannot prove prefix integrity.
   Reads and own fsynced appends serialize through a queue; parsing failures never publish a
   partial projection. Binding results are cloned, and authorization still consults fresh
   filesystem state on every decision. First reads and reads after a durable append still parse
   the journal; the optimization targets unchanged repeated reads.

3. **Transcript reads seek retained offsets and native cursors.** Disposable segment/session
   indexes skip events before `afterCursor` and read selected frames through one descriptor.
   Store reads serialize with rotation and appends. Native preview/turn readers track complete
   JSONL byte offsets; partial lines stay unread until completed. Preview windows and native
   projection caches are bounded. Rebinds, replacement, truncation, clear markers, durable
   claimant checks, turn ordinals and receipt deduplication remain covered. Existing model and
   provider-budget incremental readers remain intact. Container capture and its provenance/
   tamper checks are unchanged.

4. **The executable lazily chooses its command graph.** Provider launch paths and arguments
   still invoke `dist/src/cli.js`. The direct `mcp` command loads identity, RPC and MCP modules;
   other commands load the existing full CLI composition. Diagnostics, authorization,
   broker-unavailable recovery and stdout protocol handling remain in the MCP server. There
   is no actor pooling or routing change. The architecture exception moved with the existing
   CLI composition; its violation baseline was not widened.

5. **Thread tool pages bound bytes without silently discarding content.** The default budget
   for the new MCP implementation is 16 KiB of serialized thread-result JSON, configurable
   from 1 to 64 KiB. Broker fragmentation is opt-in through an explicit `maxBytes`; older
   requests receive complete events with the pre-existing storage limits. New MCP callers
   also accept complete events from older brokers that ignore the budget. Oversized events
   return UTF-8-safe fragments of the event's complete JSON and a digest-bound continuation.
   The cursor stays before the event until its final fragment. The internal cursor awaits the
   caller's acknowledgement, so a lost final response can be retried. A changed or rotated-out
   event fails with `STALE_THREAD_DETAIL`; fresh authorization applies to every fragment.
   This response budget does not change pre-existing storage limits.

   `tools/list` retains a universal, stable catalog for bound and unbound Orcs, unknown actors,
   and unavailable/older brokers. Only known unbound workers narrow to an explicit allowlist:
   diagnostics, provider capabilities, five reporting tools, and workflow status/changes/send.
   Those workflow operations authorize participants; creation requires a bound Orc and
   cancellation requires the owner. Grant changes do not strand cached Orc catalogs. Tool
   calls retain server-side authorization even when a tool was hidden. Existing compact worker
   wait/status behavior is unchanged.

   Thread readers carry both cursor and continuation, accept an unchanged cursor including zero,
   concatenate fragments before interpreting events, and acknowledge completion with a following
   cursor request. `STALE_THREAD_DETAIL` discards partial reconstruction and restarts at the
   cursor before that event without continuation.

6. **Activity retention skips ineligible scans and reads pages through one handle.** A cheap
   oldest-row/space check avoids materializing 1,000 locations when pruning cannot apply.
   One serialized descriptor serves each bounded page, validating every row. Existing fsync,
   retention caps, pins, source deduplication, corruption recovery and health reporting remain.

7. **Renderer preparation shares one frame context.** Viewport normalization, rendered body,
   geometry and composer cursor share canonical preparation. Sorting/list preparation reuse
   frame-local memoization, and short Unicode width/row-clamp measurements use bounded
   caches. Existing mascot caching, visible-row painting, unchanged row/cursor write skips,
   caret conventions, shrink/resize clearing, ANSI and grapheme behavior remain intact.

## Validation and comparative measurements

All commands used supported Node **24.18.0**, with its bin directory placed first in PATH,
and the same dependency lockfile. Shell commands used RTK. Worktree/evaluation dependencies
installed from the local cache with frozen lockfiles. Test mutations used disposable state and
synthetic workers.

Passed: `pnpm check`, `pnpm build`, the full `pnpm test --maxWorkers=4` suite (**199 files,
2,258 tests**), evaluation TypeScript compilation, **8/8 offline scripted Promptfoo scenarios**,
package-content inspection, and packaged `--version` / `mcp --help` smoke checks. These ran
both against an extracted package and after a fresh offline pnpm installation of the tarball
into a disposable directory, with its nine production dependencies pinned to the validated
installed versions and lifecycle scripts disabled. This proves packaged entrypoints resolve;
it does not exercise npm's latest semver resolution or real native worker launches. An
unpinned offline attempt selected uncached Zod 4.6.5 and could not finish. No install used the
network. Evidence is under `/private/tmp/cyberdeck-fleet-performance-evidence/clean-package-smoke`.
Gitleaks scanning reachable feature history passed (284 commits before the docs commit).
An initial all-local-ref scan reported three pre-existing matches in other branch histories;
those commits are outside this branch's ancestry and were left untouched. No matched values
are included in the handoff.

Focused coverage includes wire coalescing for historical Orcs, retained full details, client
refresh bursts/one-in-flight behavior, reconnect and version gaps, action/refresh races,
lossless multibyte and escaped JSON continuation, final-fragment retry and revoked grants,
external journal replacement/truncation/corruption and caller mutation, transcript incomplete
tails/rotation/rebind/attribution/ordinals/receipts, activity pins/dedup/pruning/failed fsync,
and existing cursor/resize/ANSI/Unicode/mascot behavior.

The benchmark script is `scripts/bench-fleet-performance.mjs`. Raw round 1 and round 2
results are the four adjacent `fleet-performance.{before,after}-{1,2}.json` files. These measurements
precede the PR #133 review fixes: grant-based catalog narrowing was removed, the unbound-worker
allowlist now includes participant workflow operations, and broker fragmentation is opt-in. Results
below show **round 2 means**, followed by the range of means across both runs where useful.
These are synthetic local measurements, not live acceptance or projected provider savings.

| Workload / metric | Committed base | Candidate |
| --- | ---: | ---: |
| 71 sessions, 601 coordination subjects, 176 bindings: full Fleet JSON | 657,457 B | 62,653 B |
| Unchanged Fleet reply | 657,457 B / 4 legacy RPCs | 134 B / 1 RPC |
| One-row Fleet delta | full legacy projection | 1,254 B |
| 86×24 frame preparation, 250 changing-draft frames | 3.467 ms (3.467–7.570) | 0.310 ms (0.235–0.310) |
| 10,000 binding records, warmed lookup | 87.888 ms (87.888–165.826) | 0.204 ms (0.192–0.204) |
| 10,000 preference records, warmed project projection | 16.200 ms (16.200–23.741) | 0.092 ms (0.085–0.092) |
| 10,000 events, read one event after cursor 9,999 | 39.206 ms (39.206–41.566) | 0.191 ms (0.171–0.191) |
| 10,000 native Claude lines, warmed preview | 20.585 ms (20.585–21.279) | 0.129 ms (0.092–0.129) |
| Activity replay, 5,000 rows, including ported bulk replay | 4,409 ms (4,409–5,385) | 52 ms (38–52) |
| Activity page, 100 rows | 3.999 ms (3.999–4.830) | 1.574 ms (1.309–1.574) |
| Activity append, 100 measured writes with fsync | 7.599 ms (7.599–29.606) | 5.287 ms (5.260–5.287) |
| Completed `mcp --help`, 6 fresh subprocesses | 761 ms (761–1,284) | 116 ms (62–116) |
| Mean peak RSS of those subprocesses | 137.67 MiB | 69.66 MiB |
| Universal MCP schema | 29,821 B / 25 tools | 30,082 B / 25 tools |
| Known grant with only `thread.list` | 29,821 B / 25 tools | 6,089 B / 8 tools |
| Known unbound worker | 29,821 B / 25 tools | 4,827 B / 7 tools |
| Oversized event: largest complete MCP wire response | 360,357 B | 22,905 B |
| Consume all oversized-event content | 1 response / 360,357 B total | 23 responses / 490,882 B total |

Fleet bytes measure serialized result payloads, excluding socket request/framing overhead.
The fixture intentionally includes repeated synthetic launch instructions and five projects;
it is not the audit's actual 768 KiB payload. The script's Fleet CPU field compares different
layers (legacy client join versus broker projection), so it is not used to claim an RPC speedup.
Frame preparation excludes terminal writes, rendering latency and tmux/nvim costs. Journal
and native measurements are warm reads; initial indexing, external-change reparsing, eviction
and crash recovery still require work. Activity replay is one sample per run. Repeated timings
varied with machine load and filesystem caches, especially baseline startup and fsync.

MCP startup measures imports, argument parsing and exit of a completed help command. It
does not include MCP initialization, broker connection, provider startup or harness tool loading.
The oversized-event fixture has 204,000 bytes of text and 60,013 bytes of data. It is fully
reconstructed and compared in the benchmark. The complete MCP wire envelope escapes the
bounded JSON again, so wire bytes exceed the result budget. Consumption now uses more
requests and aggregate bytes. Universal Orc schema bytes also slightly increase because of
continuation parameters. **Actual provider tokens and billed-token savings were not measured.**

To rerun against the preserved baseline:

```sh
cd /Users/brandon/code/personal/cyberdeck-worktrees/fleet-performance
rtk proxy env PATH=/Users/brandon/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin pnpm build
rtk proxy env PATH=/Users/brandon/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin node scripts/bench-fleet-performance.mjs /private/tmp/cyberdeck-fleet-performance-evidence/baseline/dist
rtk proxy env PATH=/Users/brandon/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin node scripts/bench-fleet-performance.mjs dist
```

Run the two measurements sequentially, with no validation jobs launched concurrently. On
macOS, `/usr/bin/time -l` requires access to read kernel RSS statistics. To rebuild a disposable
baseline after deleting the saved artifacts, export the exact base with `git archive` into a
temporary directory, provide dependencies from the same frozen lockfile, and run its build
there. Do not rebuild or reset the dirty original checkout.

## Remaining gates and runtime activation

`pnpm audit --prod --audit-level=high` remains unverified. The sandbox could not resolve npm;
automatic approval review then rejected the network audit because it uploads production
dependency names and versions to npm's public advisory service. An explicit approval request
is pending. The exact CI npm clean-install/global `broker start/status/stop` smoke was not run
because this machine's single broker namespace is live and the task prohibits activation or
restart; the isolated, pinned offline package smoke above passed.
Live provider/container evaluations and real terminal latency were not run.

One early offline Promptfoo run used its default local history directory and wrote an evaluation
entry to the existing `~/.promptfoo/promptfoo.db`. It was disclosed and left intact. Later runs,
including the final passing run, explicitly used disposable `PROMPTFOO_CONFIG_DIR`. This is
the one known state mutation outside the worktree/disposable fixtures; it did not touch the
original checkout or live Cyberdeck journals.

The 2-second fallback still performs a complete compact projection, and each connection
retains all historical display rows. Legacy brokers continue polling, and dashboard/detail
actions may still request full data. Authority caches intentionally reparse on every detected
external change and after own writes. Native offset readers assume append-oriented provider
logs, with inode/size/stamp plus prefix/boundary checks; they do not promise adversarial
whole-prefix integrity and are not substituted into container capture. Orc harnesses retain a
universal `tools/list` catalog across capability changes; every call still gets fresh authorization.
Continuation rereads only the selected event but serializes/hashes it again; it does not cache
transcript contents across requests.

Separate activation requires an operator-approved runtime rollout: finish the network audit
and clean-install smoke on a disposable host/CI runner, choose a broker change window that
preserves live sessions and durable state, and explicitly start the reviewed broker build.
Only then reconnect Fleet and MCP harnesses to receive the compact projection/catalog. Keep
the repository's nvim module/version instructions during any real Fleet/nvim rollout. Follow
with real terminal/provider reconnect checks and measured workload latency. No broker was
restarted, no candidate activated, and no branch merged or deployed in this task.
