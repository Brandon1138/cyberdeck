# Worker infrastructure implementation checkpoint

Worktree: /Users/brandon/code/personal/cyberdeck/worktrees/worker-infrastructure

```sh
cd /Users/brandon/code/personal/cyberdeck/worktrees/worker-infrastructure
```

Active checkout revalidated at 70190e2b3c7834011f39c0418764c2e4aca19b37. Only the original
untracked AGENTS.md, planning documents and handoffs remain there. No active-broker restart,
migration, protected merge, hosted-account change, external comment, model call or remote telemetry.

Committed stack: 62ee50a accepted preflight; 9820585 executor identity (#103); 9ac0b82 private
boundary and 87bc85f OrbStack runtime (#104); 3bc9429 prepared-resource cleanup/force escalation;
e41216e evidence-gated retirement; d59ba54 hostile-Git review protection; 94c59ec local activity/cursors;
988dbc5 bounded Sentry projection (#105). cebd64c production composition (#106); e016bea offline real-broker Promptfoo (#107).
Durability drafts: native capture #108, disk index #109, cancellation/deadlines/retry #110.
Current branch: feat/worker-infrastructure-coordination-activity at 75b569d. Follow-up commits: dae5789 atomic launch/source
containment; 3486609 native container binding; 0668336 causal intervals; d5b3bc1 resume activation
fencing; 3882828 disk activity index/pins; e82b25a cancellation/deadlines; f2fd754 bounded queue retry.

Container composition supplies private workspace/provider/credential directories, selected dirty-input
hashes, independent-clone representation, Claude/Codex guest configuration, report-only MCP,
startup recovery retry, staged-credential retirement and activity/Sentry composition. No host fallback.
Unsupported jobs/providers/modes refuse. Ordinary isolation remains opt-in; two 4-GiB slots fit the
measured 12-CPU / 12,599,844,864-byte OrbStack VM under the accepted reserve.

Activity records acknowledged instruction/execution transitions. Completed queued instructions now
bind container native turns through exact semantic receipts, explicit resume IDs, persisted byte
cursors and source-prefix validation. Provider-native turn/tool intervals and parent IDs are observed,
not HTTP/request timings. SQLite indexes the canonical JSONL by location without keeping payloads in
memory; incident pins persist across restart. Initial/direct/in-progress and host-native tool coverage
and index capacity/rebuild hardening remain incomplete. Post-commit coordination reports, controls and
handoffs now project with source provenance and replay deduplication; session-wide activity reads join
these with lifecycle and instruction events. Missing explicit session mappings durably degrade coverage.

The Sentry serialized envelope excludes content, hashes native tool IDs and links instruction segments.
The bounded queue retries transient failures/429 after 60 seconds and drains without new activity;
timer, hung-transport, permanent-failure and close tests pass. Export remains disabled; no remote trace.

Actual runtime evidence under /var/folders/dn/ts3sd7810lb9wv8j58h_3qrh0000gn/T/:

- cyberdeck-broker-container-proof-xTIuP9: real isolated broker, UID/resource/read-only boundary,
  interactive echo/93x31 resize, report-back, primary-to-peer handoff, stale fencing, reconciliation.
- cyberdeck-broker-container-proof-2SLMpT: intentional broker SIGKILL after fsynced checkpoint.
  Guest remained running; a fresh recovery process stopped, collected and removed it.
- cyberdeck-broker-container-proof-di5Ijd: preserved failed OOM assertion; Engine observed OOM but
  launcher lost the child signal and returned 1. Container collected and removed.
- cyberdeck-broker-container-proof-RGQqdD: corrected launcher; real OOMKilled=true and exit 137,
  handoff, slot release, collection and removal passed.

Newer actual proofs under the same temporary root:

- cyberdeck-broker-container-proof-vxzRvk: rebuilt native-binding image, real isolated broker,
  UID/resource/read-only/control/resize/report/handoff/recovery/cleanup.
- cyberdeck-broker-container-proof-8bfTTa: stop/resume preserves execution/container/workspace;
  session/execution generation 2, resumed gateway report, handoff, recovery and cleanup.
- cyberdeck-broker-container-proof-12IhOQ: actual five-second deadline stops the guest, records
  timeout, releases the slot and preserves evidence before collection/removal.

Exact-commit activity/resume proof at clean 75b569d: cyberdeck-broker-container-proof-37EeF8.
The real broker session read returned 14 ordered events including execution lifecycle, control,
worker report and handoff, with no recorder degradation. Generation-2 resume/report, handoff,
fencing, recovery and evidence-preserving removal passed; cleanup is absent.

Latest image: sha256:5d179eccc6bd197adbb6d0ca2928778e04716ce3ab4d6a3ae560fbe95227e413.
Base: node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d.
Guest versions: Node 24.18.0, Claude 2.1.261, Codex 0.153.4. No model authentication/calls proved.
OrbStack 2.2.3 / Engine 29.4.0; explicit orbstack context, socket ~/.orbstack/run/docker.sock.
Current daemon connection and empty cyberdeck.broker-labelled container inventory rechecked after
interruption. Private clones, images and failed/successful evidence are retained.

Promptfoo 0.122.2 is pinned separately in evals. Eight offline real-broker scenarios passed.
Promptfoo run eval-sZR-2026-09-05T18:54:05: 8 passes, 0 failures/errors, cache/telemetry disabled.
evals/results/offline.json and offline-broker.json retain evidence references. The post-validator
rejects empty/missing/skipped/malformed suites; critical checks have negative/omission grader tests.
OOM/mount scenarios use explicit scripted Engine fixtures offline. Live mode refuses pending its
container/native-evidence bridge and provider/model/spend authorization; offline is not live proof.

Verification at e82b25a: full suite 173 files / 2,077 tests, TypeScript/build and architecture/file-size
ratchets passed. After f2fd754, 10 observability tests and TypeScript passed. cyberdeck-pack-proof-e7qaQT
retains an earlier clean-installed CLI proof: 0.1.0-alpha.2; eval files excluded. Packed CLI broker
commands were not aimed at the hardcoded active socket. These proofs predate final acceptance.

After 75b569d: 58 focused persistence/coordination/observability/handoff/architecture tests and
TypeScript passed. The new session inspection proof is scripted-provider runtime evidence, not a live
model run.

Next: remaining native capture coverage, index
capacity/rebuild durability, multi-worker/crash coverage, provider auth/resume matrix, container-backed
live harness, exact-candidate proof and rollout commands. Missing Sentry activation/project/region/DSN/
quota and live provider/model/total spend remain external gates. Request only those after independent
implementation is complete. Objective remains open.
