# Resource-managed autonomy evidence

Implementation base: `af8d19ecda9e16ece12c4b713e9867c66984920b`.
Implementation tree: `/private/tmp/cyberdeck-resource-managed-autonomy`.
Policy target: 8 GiB total. No production configuration changes or broker restart authorized by this artifact.

| Gate | State | Evidence / remaining work |
| --- | --- | --- |
| Orientation | inspected | Source clean except pre-existing untracked AGENTS, handoffs, older prompt; Node 24.18.0, Codex 0.154.0, ChatGPT subscription, Xcode 27.0 |
| A measurements | in progress | Native libproc and cgroup adapters; 10-minute active baseline and separate Claude/Codex subscription footprint canaries (JSON summaries here). Idle/W1 calibration pending |
| B efficiency | in progress | Native projection, semantic index and Fleet frame reuse committed; synthetic benchmarks in docs/evidence/resource-efficiency; live plateau/delta refresh incomplete |
| C admission | in progress | Durable shared admission wired into session preparation/spawn; per-generation container envelopes, observed-budget holds, helper caps. Whole-VM upper-bound calibration, native lifetime cleanup and job adapter support remain open |
| D lifecycle / native / services | unverified | D3/D4 source delivered separately; integration and actual native/service runs pending. D1 parking and D2 credential refresh incomplete |
| E observability | unverified | Closed resource schema and exporter health implemented; monitor-to-activity bridge and fresh remote receipt pending (no browser/read credential available) |
| F evaluation | unverified | Durable outbox and offline grader implemented; architecture seam corrected. Canonical retention/replay, broker composition and admitted evaluator still pending |
| G operating package | unverified | Exact image/config, recovery and rollout pending |
| H independent review | unverified | Exact final candidate review and checks pending |
| W0 idle 10 minutes | unverified | Live snapshot is active workload, not idle acceptance |
| W1 eight authenticated workers x3 | unverified | No capacity claim from configured limits or thread count |
| W2 two families | unverified | Shared policy and real fair service pending |
| W3 heavy phase | unverified | Same-budget measured build/test pending |
| W4 helpers | unverified | Full ownership inventory pending |
| W5 transcripts | in progress | Deterministic before/after benchmark |
| W6 parking | unverified | Confirmed memory release and native resume pending |
| W7 evaluation load | unverified | Attempt reconciliation and queue progress pending |
| W8 24-hour soak | unverified | Not started; cannot infer from unit tests |
| W9 native | unverified | Unsigned simulator fixture plus representative project pending |
| W10 services | unverified | Scoped service fixture and selective teardown pending |
| Live activation | not performed | Original broker preserved; no production build/config/restart changes. Earlier isolated baseline broker runs older compiled dist, not current source |
| Physical M4 mini | pending hardware | Independent of MacBook delivery |

Initial private configuration inspected through an allowlist: mode 0600, no workerExecution override,
Sentry enabled at 0.1 sample rate / 5000 daily envelopes. DSN and credentials excluded.
Foreign running containers are Start Parking services; no stop, prune, volume or network changes.
Initial process RSS and CPU snapshots are approximate and do not establish physical aggregate use.

Current limitations of the opt-in composition: native polling never proves whole-lifetime cleanup, so
unproven native reservations remain held. Job dispatch fails explicitly under resource management
until its runtime identity is accounted; it cannot bypass the gate. VM accounting uses a conservative
whole-VM upper bound pending residual calibration. These are incomplete requirements, not acceptance.

The worktree now has an independent frozen-lockfile install (Node 24.18.0, pnpm 11.5.0). The lockfile
resolves Vitest 4.1.11 and TypeScript 7.0.2; package ranges are not exact resolved versions.
