# Resource-managed autonomy evidence

Implementation base: `af8d19ecda9e16ece12c4b713e9867c66984920b`.
Implementation tree: `/private/tmp/cyberdeck-resource-managed-autonomy`.
Policy target: 8 GiB total. No production configuration changes or broker restart authorized by this artifact.

| Gate | State | Evidence / remaining work |
| --- | --- | --- |
| Orientation | inspected | Source clean except pre-existing untracked AGENTS, handoffs, older prompt; Node 24.18.0, Codex 0.154.0, ChatGPT subscription, Xcode 27.0 |
| A measurements | in progress | Native libproc and cgroup adapters; 10-minute active baseline and separate Claude/Codex subscription footprint canaries (JSON summaries here). Idle/W1 calibration pending |
| B efficiency | in progress | Native projection, semantic index and Fleet frame reuse committed; synthetic benchmarks in docs/evidence/resource-efficiency; live plateau/delta refresh incomplete |
| C admission | in progress | Durable shared admission wired into session preparation/spawn; per-generation container envelopes, observed-budget holds, helper caps. Whole-VM upper-bound calibration, native lifetime cleanup remain open; all four native job adapters now use the shared gate |
| D lifecycle / native / services | unverified | D3/D4 and D1 parking source integrated; durable parking composition wired; D2 refresh transport still pending. Real service attempt held by observed-budget; native/service success pending |
| E observability | partial proof | Fresh synthetic receipt matched through authenticated Zen session; see sentry-resource-probe.json. Durable monitor-to-activity bridge wired; final workload receipt pending |
| F evaluation | unverified | Durable retention/replay, historical instruction outbox and broker capture composition implemented; admitted offline evaluator wired but image/live automatic final dispositions pending |
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
| W10 services | capacity-held | Fixed service proof refused before provisioning under observed-budget; foreign inventory unchanged. Successful service test and fault cleanup pending |
| Live activation | not performed | Original broker preserved; no production build/config/restart changes. Earlier isolated baseline broker safely retired after its active-session set was confirmed empty |
| Physical M4 mini | pending hardware | Independent of MacBook delivery |

Initial private configuration inspected through an allowlist: mode 0600, no workerExecution override,
Sentry enabled at 0.1 sample rate / 5000 daily envelopes. DSN and credentials excluded.
Foreign running containers are Start Parking services; no stop, prune, volume or network changes.
Initial process RSS and CPU snapshots are approximate and do not establish physical aggregate use.

Current limitations of the opt-in composition: native polling never proves whole-lifetime cleanup, so
unproven native reservations remain held. Job dispatch fails explicitly under resource management
when the required shared launch port is absent or container execution is requested; composed native jobs now have durable PID binding. VM accounting uses a conservative
whole-VM upper bound pending residual calibration. These are incomplete requirements, not acceptance.

The worktree now has an independent frozen-lockfile install (Node 24.18.0, pnpm 11.5.0). The lockfile
resolves Vitest 4.1.11 and TypeScript 7.0.2; package ranges are not exact resolved versions.

The 2026-09-16T10:26:55Z service attempt measured 9,486,441,624 bytes of managed native
physical footprints (including the existing two Orcs, seven Start Parking workers, Fleet and
implementation tooling), already above 8 GiB before attributable VM overhead. The whole-VM
conservative upper was 13,924,120,144 bytes. Admission held the 640 MiB request without
creating any service infrastructure. This is a real capacity constraint under that active load,
not evidence that the final optimized eight-worker profile is infeasible or complete.

Sentry proof is a synthetic closed-schema transport/privacy check, not measured workload
telemetry or exact-final-candidate acceptance. No remote settings or billing modes changed.

Composition checkpoint (2026-09-16): narrow authenticated `cyberdeck_run_profile` RPC,
durable auxiliary request replay, canonical lease/attempt checks, parking recovery before
input delivery, bounded rotating parking sweeps, canonical retirement of instruction facts,
and shared-admission evaluator scheduling are implemented. Unknown resource measurements
remain null and are omitted remotely. Historical terminal instructions retain their original
execution identity; legacy missing identity remains an explicit migration gap.

Current composition checks: TypeScript passed; 68 resource/architecture/authority/read-model/
projection tests and 83 gateway/coordination/parking/service/evaluation tests passed. These
are source checks of the dirty composition checkpoint, not final-candidate or live acceptance.

Additional checkpoints: full regression at `93ed28a` passed **224 files / 2,470 tests**.
The job composition at `cf4138e` adds asynchronous queued receipts, canonical family recheck
before preparation, and cancellation of resource waits. The interim High review of `93ed28a`
found native workload collisions, stale auxiliary queue debt, and missing integration cleanup
retries; `2ea67ba` integrates the 52-test remediation. This is not final H acceptance.

At 2026-09-16T11:46:03.516Z, read-only current-capacity inspection found native physical
9,493,627,776 bytes, VM physical 4,645,412,768 bytes, conservative total 14,139,040,544 bytes,
normal host pressure and unchanged container inventory. Implementation tooling accounted for
2,859,186,056 native bytes / 58 processes; the larger Orc tree 1,896,373,104 bytes / 17 processes;
existing broker 740,255,568 bytes. Exact source was `8c7acd4` plus the untracked inspection script.
This active-load snapshot is not W0/W1 or proof of optimized eight-worker infeasibility.

Isolated evaluation dependencies installed from the frozen lockfile; exact eval TypeScript
command passed and production dependency audit reported no known vulnerabilities at `8c7acd4`.
Worker/evaluator image builds and live Promptfoo container execution remain capacity-held.
The native lifetime mechanism and automatic subscription refresh remain unresolved.


Recovery review checkpoint: independent High review of `3c7f40c` found three P1 defects:
auxiliary waiting requests lost on restart, mixed-owner admission reopening, and cancelled
prospective resume generations becoming permanently fenced. Root corrections now require
owner-specific readiness and durable releases before global admission, and permit retries
only with cancelled/never-launched evidence. Regression coverage includes the real session
registry, ledger close/reopen, admitted-before-launch cancellation, failed releases and
missing auxiliary owners. Focused source/architecture checks: 68 tests and TypeScript passed.
Auxiliary queue-preservation integration and final-candidate reruns remain pending.

Exact clean `3c7f40c` regression: 229 files / 2,522 tests and build passed. Its offline suite
had 6 passes / 2 fixture errors (`WORKER_EGRESS_PROXY_REQUIRED`); a separate bounded fixture
patch passes all 8 scenarios without changing production egress or grading. Results from
that leaf are not final integrated-candidate evidence.


Recovery follow-up: `3e53b07` passes 77 focused checks. Independent High review reports no
remaining scoped P0/P1 findings in the launch-hold, bounded recovery-retry and typed lease
revocation corrections. Review is source/test inspection, not final workload acceptance.
The `6336faa` full suite passed 2,545/2,546 tests; shell-command streaming's fixed 200ms check
failed under load and passed the focused rerun. Failure report is preserved at
`/private/tmp/cyberdeck-resource-candidate-6336faa/unit-results.json`. A full subsequent
candidate run will use two test workers to reduce fixture timing contention.

Legacy migration composition now seals the exact first-start historical terminal snapshot
before replay. Only records missing both historical generation and terminal projection are
eligible; dispositions are explicit unverified snapshots, not invented attempts. Restart,
new/changed records, disk failure and modern projection gaps are covered; 28 focused tests
and TypeScript pass. Whole-history Gitleaks at `68d425e` scanned 551 commits with no leaks.
Native lifetime SDK findings are in `native-lifetime-investigation.md`; the unresolved
supervision boundary still prevents native cleanup and operational refresh completion.
