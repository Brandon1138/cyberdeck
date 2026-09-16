# Partial Task B efficiency evidence

Runtime candidate: `ffc32f03b221a6a08eb8495ba0c654cb08d81e5e`, based on `af8d19ecda9e16ece12c4b713e9867c66984920b`. This is deterministic local evidence, not live W0 or complete W5 acceptance. No broker, provider, container, nvim surface or foreign service was changed.

`baseline-exact.json` and `candidate-exact.json` run the identical benchmark script against original and candidate runtime sources. Each records hashes of the runtime sources and script, hardware/OS, Node version, timing, CPU, RSS and process high-water RSS. The baseline temporarily restored only the six owned source files in the isolated worker checkout; the candidate files were then restored before verification/commit. Fixture content is synthetic: 2,000 turns / 2,904,833 bytes, twenty idle reads, twenty appended turns, twenty semantic observations and 1,000 refreshes of 64 catalog rows. No provider processes run.

| Workload | Baseline CPU ms | Candidate CPU ms | Baseline wall ms | Candidate wall ms |
| --- | ---: | ---: | ---: | ---: |
| Native cold read | 36.3 | 55.6 | 36.1 | 51.3 |
| Native idle, 20 reads | 480.3 | 82.2 | 407.3 | 76.7 |
| Native append, 20 turns | 436.8 | 131.6 | 405.4 | 124.4 |
| Semantic idle, 20 observations | 691.0 | 119.7 | 592.7 | 98.2 |
| Fleet idle, 1,000 refreshes | 452.4 | 102.0 | 389.6 | 84.9 |

Whole-process peak RSS across these sequential synthetic phases was 297.5 MiB baseline / 178.9 MiB candidate. These are RSS samples/high-water marks, not physical-footprint attribution or leak/plateau proof. Cold reads get slower because the candidate constructs both budget projections, retains results and hashes the completed prefix; repeated reads and appends improve. Runs on the shared host are noisy, without confidence intervals. `before*.json`, `after*.json` and `final.json` retain exploratory measurements; they used earlier script/candidate versions and must not replace the exact pair. CPU profiles stayed in private temporary files; their initial dominant samples were native read (203), JSON frame parsing (142 and 111), timestamp parsing (133), budget parsing (129), then Fleet display width (91) and grapheme segmentation (46). These are sample counts, not attributed live-broker percentages.

The native projection shares turns, preview, model and both budget windows. It retains at most 64 sessions and a 16 MiB estimated serialized-payload allowance (not an exact heap ceiling). Containment and native identity are checked on every call; growth hashes the **entire previously parsed prefix** before reusing results. Same-size modifications, inode replacement, truncation, generation/execution change and rebind rebuild the projection. Failures never publish partially advanced caches. Returned values do not expose cache-owned mutable data. Summary readers omit copying old turns. `forget(sessionId)` is available for a proved retirement boundary, but lifecycle integration remains root-owned.

**W5 remains partial:** parsing scales with complete appended frames, but integrity validation on growth still reads/hashes the old prefix. Full-turn callers still copy historical results, and running capture may scan semantic history to obtain the committed ordinal. No claim of linear appended-byte I/O is made. Tests prove offset reuse and exact equality with a fresh projection, including an earlier-prefix rewrite plus growth whose last 4 KiB are unchanged. Full-prefix integrity was not traded for performance.

The Fleet cache retains one frame below a 1 MiB string-length allowance. Its key includes the full snapshot, normalized state, appearance, PR statuses and exact displayed age labels. Expirations, keyboard state and preview changes invalidate it. Poll cadence and full snapshot RPCs are unchanged (4,004 requests in each benchmark); there is no delta/subscription/reconnect redesign. Host previews, idle live CPU, live UI latency, 100-cycle heap plateau, lifecycle retirement integration and W0/W5 runtime acceptance remain unverified.

Validation: Node 24.18.0, pnpm 11.5.0; TypeScript no-emit check passed. Eight focused test files / 265 tests passed: native activity, native projection integrity/churn, execution and thread transcript persistence, worker turn engine, and complete Fleet tests including cache invalidation. Seven native-projection tests independently passed after integrity hardening. Fixtures cleaned their temporary roots in `finally`/`afterEach`; no live resources were created. Git staging needed sandbox escalation for worktree metadata and succeeded; no locks were removed.

Reproduce from the candidate with Node 24.18.0:

```sh
rtk proxy /Users/brandon/.local/share/mise/installs/node/24.18.0/bin/node --import tsx scripts/bench-resource-efficiency.ts
```

The script supports `--uncached-fleet` for a same-candidate render comparison and automatically uses the original renderer when run against source predating `FleetFrameCache`. No subscription/auth/model/image settings apply to these offline fixtures.
