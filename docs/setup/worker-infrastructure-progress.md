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
988dbc5 bounded Sentry projection (#105). Current branch: feat/worker-infrastructure-composition.

Container composition supplies private workspace/provider/credential directories, selected dirty-input
hashes, independent-clone representation, Claude/Codex guest configuration, report-only MCP,
startup recovery retry, staged-credential retirement and activity/Sentry composition. No host fallback.
Unsupported jobs/providers/modes refuse. Ordinary isolation remains opt-in; two 4-GiB slots fit the
measured 12-CPU / 12,599,844,864-byte OrbStack VM under the accepted reserve.

Activity records acknowledged instruction/execution transitions. Native cursor fixtures prove
durability, partial-line/restart handling and source modification detection. Production native-turn
binding remains unwired and visibly unavailable. The Sentry envelope drops excluded data, hashes
native tool IDs and links instruction segments. Events remain instantaneous observation markers;
no fabricated provider timings or token/cost observations. Export is disabled; no remote trace exists.

Actual runtime evidence under /var/folders/dn/ts3sd7810lb9wv8j58h_3qrh0000gn/T/:

- cyberdeck-broker-container-proof-xTIuP9: real isolated broker, UID/resource/read-only boundary,
  interactive echo/93x31 resize, report-back, primary-to-peer handoff, stale fencing, reconciliation.
- cyberdeck-broker-container-proof-2SLMpT: intentional broker SIGKILL after fsynced checkpoint.
  Guest remained running; a fresh recovery process stopped, collected and removed it.
- cyberdeck-broker-container-proof-di5Ijd: preserved failed OOM assertion; Engine observed OOM but
  launcher lost the child signal and returned 1. Container collected and removed.
- cyberdeck-broker-container-proof-RGQqdD: corrected launcher; real OOMKilled=true and exit 137,
  handoff, slot release, collection and removal passed.

Latest image: sha256:596f6caf80f4e581392a3fcad8b7a652ec3569d6862e34b4c65e1e9b69c67374.
Previous MCP image: sha256:505299d994e338a099a4332b56b46dbf39feb9efbcb488799122dedec39c6a0b.
Guest versions: Node 24.18.0, Claude 2.1.261, Codex 0.153.4. No model authentication/calls proved.
Inventory confirms no labelled Cyberdeck containers or scripted evaluation processes remain.
Private clones, images and failed/successful evidence are retained.

Promptfoo 0.122.2 is pinned separately in evals. Eight offline real-broker scenarios passed.
Promptfoo run eval-K2F-2026-09-05T17:35:56: 8 passes, 0 failures/errors, cache/telemetry disabled.
evals/results/offline.json and offline-broker.json retain evidence references. The post-validator
rejects empty/missing/skipped/malformed suites; critical checks have negative/omission grader tests.
OOM/mount scenarios use explicit scripted Engine fixtures offline. Live mode refuses pending its
container/native-evidence bridge and provider/model/spend authorization; offline is not live proof.

Verification: full suite 171 files / 2,064 tests passed, then 36 focused composition/workspace/
architecture tests after follow-up changes. TypeScript/build passed. cyberdeck-pack-proof-e7qaQT
retains a clean-installed CLI proof: 0.1.0-alpha.2, 894 published files, eval files excluded. Packed
CLI broker commands were not aimed at the hardcoded active socket. Proofs predate final acceptance.

Next: finish production native attribution/transcript mapping, bounded activity indexing and pin
policy, launch cancellation/timeouts/periodic retention, multi-worker/crash boundary coverage,
provider auth/resume matrix, causal duration tracing, container-backed live harness, exact-candidate
proof and rollout commands. Missing Sentry activation/project/region/DSN/quota and live provider/model/
total spend values remain external gates. Request only those after independent implementation is
complete. Objective remains open.
