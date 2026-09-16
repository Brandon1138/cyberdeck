# Resource-managed autonomy evidence

Implementation base: `af8d19ecda9e16ece12c4b713e9867c66984920b`.
Implementation tree: `/private/tmp/cyberdeck-resource-managed-autonomy`.
Policy target: 8 GiB total. No production configuration changes or broker restart authorized by this artifact.

**Operator-requested scope freeze (2026-09-16): draft PR for source review; not full delivery
or activation acceptance.** Latest product source is `15e455d16c5fb1eb20dc6a59bb62b4ab74224065`.
All 2,628 tests across 238 files, root/evaluation TypeScript, build, eight offline scenarios,
production audit, package inspection, fresh-prefix installation and isolated installed-broker
startup/status/shutdown passed. Whole-history scan passed after an exact false-positive
exception for the verified SHA-256 of an earlier redacted scan report; the original failure
is retained. `candidate-15e455d-checks.json` records provenance. Independent follow-up review
found no remaining scoped P0/P1 after the evaluator cleanup correction. Final PR CI remains
a separate check on the documentation/evidence wrap-up commit.

Do not merge or activate on the claim that Tasks A–H are complete. W1's eight concurrent
authenticated workers, W9 native ownership/build/test, final worker/evaluator images,
automatic container evaluation, full W10 composition, workload Sentry receipt, fairness,
parking and the 24-hour soak remain open. There is no measured optimized-eight-worker
infeasibility conclusion. The physical mini gate remains separate. The primary checkout,
its dist/configuration and the original live broker were not replaced.

Unfinished offline worker-image assembler code is preserved separately in
`/private/tmp/cyberdeck-resource-worker-image` and deliberately excluded from this branch.
It has no committed/tested/live proof and must not be used as a completed capability.

| Gate | State | Evidence / remaining work |
| --- | --- | --- |
| Orientation | inspected | Source clean except pre-existing untracked AGENTS, handoffs, older prompt; Node 24.18.0, Codex 0.154.0, ChatGPT subscription, Xcode 27.0 |
| A measurements | in progress | Native libproc and cgroup adapters; 10-minute active baseline and separate Claude/Codex subscription footprint canaries (JSON summaries here). Idle/W1 calibration pending |
| B efficiency | in progress | Native projection, semantic index and Fleet frame reuse committed; synthetic benchmarks in docs/evidence/resource-efficiency; live plateau/delta refresh incomplete |
| C admission | in progress | Durable shared admission wired into session preparation/spawn; per-generation container envelopes, observed-budget holds, helper caps. Whole-VM upper-bound calibration, native lifetime cleanup remain open; all four native job adapters now use the shared gate |
| D lifecycle / native / services | partial service proof | Real fixed PostgreSQL service fixture passed after a logging/cleanup correction; production lease/RPC, concurrent fleet, native and refresh gates remain open |
| E observability | partial proof | Fresh synthetic receipt matched through authenticated Zen session; see sentry-resource-probe.json. Durable monitor-to-activity bridge wired; final workload receipt pending |
| F evaluation | unverified | Durable retention/replay, historical instruction outbox and broker capture composition implemented; admitted offline evaluator wired but image/live automatic final dispositions pending |
| G operating package | unverified | Exact image/config, recovery and rollout pending |
| H independent review | in progress | Clean e6cc020: 234 files / 2,585 tests, CI-equivalent source checks and isolated installed-package smoke passed. Queued launch correction integrated through 369001b; final follow-up review and exact rerun pending |
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
| W10 services | partial proof | Clean 9dde8c7 fixed SQL fixture succeeded under shared admission; failed-start recovery and scoped cleanup proved. Production lease/RPC, automatic evaluation and final concurrent fleet run pending |
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


At 2026-09-16T12:38:42.476Z, exact clean `e87d381` read-only census measured native
7,432,675,288 bytes plus VM 1,760,528,024 bytes = 9,193,203,312 bytes (~8.56 GiB),
603,268,720 bytes above target. The running foreign container set was empty, unlike the
previous baseline; retained foreign containers show recent stops and the database identity
changed. This work issued no stop/restart/prune against those services. Cause/actor remains
unverified. The immediate before/after inventory of this census matched. Original broker
85613 and Fleet 85652 still have their original September 14 process start identities.

Legacy replay now additionally covers only exact preexisting terminal activity source,
sequence and hash; missing-generation events cannot receive a broad instruction-ID waiver.
Initial admission waits for first complete replay plus canonical coverage audit, including
histories exceeding the 400-event per-pass limit. Composition regressions pass 32 tests.
The strict W1/soak artifact validator is integrated, but no live fleet collector result or
24-hour soak is implied by its synthetic negative fixtures.

Exact clean `e6cc02015249483861a553d936a2015edd098e4a` passed root/evaluation TypeScript,
all 2,585 tests in 234 files (two test workers), build, all eight offline scripted scenarios,
production dependency audit, whole-history redacted Gitleaks, package-content assertions,
fresh-prefix package install, installed CLI version/dependency inventory and isolated headless
broker startup/status/shutdown. Package SHA-256 is
`c9b1b7cc97bab205e240ee463156fac465aaa3b1cff408c5eafea6f6fa05c5d7`.
`candidate-e6cc020-checks.json` records provenance and private log hashes. The first install
attempt failed only in mise's post-install reshim; direct npm passed with the two inspected
package scripts allowed. The first smoke was denied Unix-socket creation by the sandbox;
the authorized retry used a fresh socket/state, launched no providers and removed its socket.
Both failed attempts remain in the private artifact folder.

Subsequent scoped High review found a P1 in fresh interactive starts: capacity waiting occurred
before a durable launch record or Fleet row, so a restart could lose the launch callback and
initial input. A separate worktree is implementing durable pending launch receipts, recovery
and cancellation. Passing the existing suite did not cover this defect or establish completion.

After that package smoke, the next read-only census refused the changed/missing OrbStack VM birth
identity; subsequent process-name inspection found no OrbStack process. No service proof or
image build was attempted, and no VM/container restart was performed. The live broker 85613
and Fleet 85652 retained their September 14 start identities. Current foreign-service state
must be re-inspected once the Engine is available; older bracketed inventories are not a
claim that external state stayed unchanged throughout the session.

The operator restored OrbStack. Fresh read-only census at `2026-09-16T13:17:47.849Z`
used the new VM birth identity and measured 6,375,214,136 bytes conservative physical usage
with normal pressure and matching immediate inventories. This opened capacity for a serialized
640 MiB service reservation; it is still not W1 feasibility evidence.

The clean `4b51f27` service attempt failed before PostgreSQL started because Docker's local
logging compression rejects `max-file=1`. Cleanup also retained the owned resources because
that never-started container had no log stream. `7c32069` explicitly disables compression in
service/evaluator arguments and permits evidence-preserving cleanup only with Docker's exact
never-started state. Previously started containers still require their logs. All 58 focused
service/evaluator tests passed. Recovery through the corrected executor restored the original
foreign inventory and released the held reservation; no foreign object was stopped or removed.

Clean proof leaf `9dde8c7764af8a2f9253dccafa549020a71afdd8` then passed actual PostgreSQL
readiness and SQL rollback assertions from `2026-09-16T13:28:01.639Z` through
`2026-09-16T13:28:12.183Z`. Both owned containers exited zero without OOM; scoped teardown
completed, foreign inventory matched, and reserved bytes returned to zero. Three distinct
five-second physical samples peaked at 6,249,262,616 bytes (about 5.82 GiB); this is a sampled
peak, not a lifetime maximum. `integration-service-proof.json` records exact source, image,
config/policy hashes, artifact hashes and preserved failure/recovery provenance. The fixture
uses fixed operator authority, so production lease/RPC, automatic evaluation and final W10
composition remain unverified.

Queued interactive launches now persist private input and a public metadata-only receipt
before capacity waiting. Recovery preserves the original identity/FIFO, checks canonical
authority without replaying grants, and fences ambiguous launch boundaries. `369001b`
adds durable terminal catalog-projection acknowledgement and a post-preparation authority
recheck; 460 focused worker tests, TypeScript and architecture checks passed on the leaf.

Task F follow-up captures cancelled/failed/interrupted initial-prompt launches as canonical
attempts, without inventing instructions or grading infrastructure failures as model quality.
Outbox ownership and the durable catalog projection are both required before private launch
input retirement. Root tests cover startup after store reopen, automatic capture of later
terminal launches, restart deduplication, and delayed catalog projection. The focused
20-test evaluation suite and TypeScript passed; automatic real-container execution remains
unverified. The first new timing check observed outbox capture before async retirement
completed; it now waits for complete reconciliation and preserves the durability assertions.

Follow-up High review found no additional P0/P1 in launch recovery/capture, but found an
evaluator cleanup P1: a never-started container's missing logs could strand evaluation and
recovery admission. Evaluator cleanup now requires Docker's exact created/PID-zero/zero-start
identity before recording an explicit no-log observation; previously started containers still
retain evidence and capacity on log failure. All 35 focused evaluator checks pass, including
recovery and a subsequent successful attempt. Final source review and exact suite are pending.
