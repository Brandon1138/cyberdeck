# Worker infrastructure integration acceptance — 2026-09-09

The complete #103–#112 implementation is integrated with main `79cfcbc` (#113), preserving the
original stack commits on the integration branch. Main requires linear history, so the integration
is squash-merged there; the source branches retain exact commit provenance. Runtime integration commit: `af5ade0`. The subsequent proof/documentation
commit adds the container-policy proof; it does not change production runtime code.
The repository is eligible for an opt-in implementation merge. Live rollout remains gated below.

## Integrated behavior

- #103–#104: explicit executor selection, durable identity, independent clones, selected input
  hashes, private credentials/provider state, report-only gateway and OrbStack runtime.
- #105–#107: local durable activity, bounded Sentry metadata export, broker composition and eight
  offline Promptfoo scenarios using isolated real brokers.
- #108–#111: native conversation/resume bindings and causal capture, disk index/incident pins,
  cancellation/deadlines/retention, bounded export retry and session/coordination activity.
- #112: every-turn attribution, index retention/recovery, multi-worker proofs, container-scripted
  evaluations, gated live harness/canary, support matrix and rollout/rollback runbook.

#113's structured descriptors, enumerated answers, fingerprint recheck, lease checks and
operator-only login/unknown/permission prompts are preserved. Host adapters retain grant-gated
trust writes. Container preparation reuses the same Claude/Codex writers with the exact guest
`/workspace` entry in the private home, after evaluating the source repository grant. Provider-owned
symlinks are refused before host writes. Codex's existing untrusted entry is never overridden.
Modal policy resolves a clone's repository through the broker-owned execution context, never the
request's repository field or guest-controlled Git config. Revocation refuses subsequent answers;
as with #113, it does not erase a provider trust choice already recorded.

Adversarial integration review also strengthened gateway activation to require matching session
and execution generations, and Engine inspection to verify network/PID/IPC isolation, root
read-only state, swap/PID limits, added capabilities and devices. Negative tests cover mismatches.
Neither architecture nor file-size baseline was raised.

## Promptfoo CI failure

GitHub run `33989625627` failed only `sentry-outage`. Instruction persistence publishes
`completed` before its activity projection finishes appending `instruction.settled`. The scenario
read the second journal as soon as it saw the first, producing a timing-dependent missing-evidence
error. Local repetition reproduced it, and a 150 ms delayed activity append made the regression
deterministic. The scenario now waits within its existing timeout for the durable settlement event;
the invariant, error exit and full-suite validator are unchanged. There is no Docker requirement
in the offline execution path and no evaluator gate was skipped.

## Fresh evidence

Runtime: Node 24.18.0, pnpm 11.5.0, Promptfoo 0.122.2; explicit OrbStack context `orbstack`, Engine
29.4.0, 12 CPUs / 12,599,844,864 bytes RAM. Image:
`sha256:5d179eccc6bd197adbb6d0ca2928778e04716ce3ab4d6a3ae560fbe95227e413` (Claude 2.1.261,
Codex 0.153.4). These provider versions identify the pinned image, not authenticated model proof.

Evidence directories below are under `/var/folders/dn/ts3sd7810lb9wv8j58h_3qrh0000gn/T/`.
Temporary artifacts may expire; commands are committed so the proofs can be reproduced.

| Gate | Evidence |
| --- | --- |
| TypeScript, production build, eval TypeScript | `pnpm check`, `pnpm build`, `pnpm exec tsc -p evals/tsconfig.json` passed |
| Repository tests and architecture/file-size/dependency ratchets | 183 files / 2,159 tests passed; baseline files unchanged from #113 |
| History secrets / production dependency audit | Gitleaks: 485 commits across full history, no leaks; `pnpm audit --prod --audit-level=high`: no known vulnerabilities |
| Offline Promptfoo, CI settings, cache disabled | `eval-JdH-2026-09-09T07:52:21`, 8/8, validator clean |
| Real container-scripted Promptfoo | `eval-LEu-2026-09-09T07:51:44`, 8/8, validator clean; real deadline stop, cgroup OOM, gateway refusal and mount isolation |
| Two slots / three workers, cross-report 403, queue handover, selective retirement, reconciliation | `cyberdeck-multi-worker-proof-Brv1U4`, success, all three containers absent |
| Generation-2 resume, same execution/workspace, reporting, handoff/stale fencing and activity | `cyberdeck-broker-container-proof-AkoKwk`, success, container absent |
| Deliberate isolated-broker SIGKILL and fresh recovery | `cyberdeck-broker-container-proof-Gtjume`, recovery observed/stopped the surviving guest, collected evidence, container absent |
| Private Claude/Codex trust, source-grant revocation, operator-only policy, actual queued cancellation and resume | `cyberdeck-policy-proof-LGFYjD` at clean `d979dd0`, both providers' scripted workers passed; containers absent |
| Native attribution, clear/resume, modal answer/refusal/audit, Sentry final-envelope privacy | Repository fixture/regression tests; no claim of authenticated provider or remote telemetry proof |
| Packed CLI, fresh temporary install, development-content exclusion | `cyberdeck-pack-proof-EjxIFX`, CLI 0.1.0-alpha.2, 954 package entries, evals/tests/scripts excluded |

Runtime/eval/pack proofs used clean `af5ade0`; the container-policy proof and 30/30 successful
Sentry-outage repetitions used clean `d979dd0`. Later changes are documentation and EOF whitespace.
No active-broker restart, paid/authenticated provider call,
remote Sentry export, production routing change or host-exception acceptance was performed.

Reproduce using Node 24.18.0:

```sh
rtk pnpm install --frozen-lockfile
rtk pnpm --dir evals install --frozen-lockfile
rtk pnpm check
rtk pnpm test
rtk pnpm build
rtk pnpm exec tsc -p evals/tsconfig.json
rtk pnpm --dir evals run eval:offline
rtk pnpm --dir evals run eval:container
rtk proxy node --import tsx scripts/prove-multi-worker-isolation.ts
rtk proxy node --import tsx scripts/prove-container-policy.ts
rtk proxy node --import tsx scripts/prove-broker-container.ts --resume-before-handoff
rtk proxy node --import tsx scripts/prove-broker-container.ts --crash-after-handoff
# Immediately recover the exact evidence directory printed by the intentional exit-137 run:
rtk proxy node --import tsx scripts/recover-worker-proof.ts <exact-evidence-directory>
rtk proxy node --import tsx scripts/prove-pack.ts
```

## Only operator rollout gates remain

1. Supply explicit Claude/Codex provider/model choices, credential files and a total spend ceiling;
   run `scripts/provider-canary.ts`, then the three-repetition `eval:live` baseline. Container cells
   remain `unproved` until their authenticated canaries pass.
2. Authorize Sentry activation and supply project/region/DSN plus actual allowance-derived cap;
   inspect a named remote canary trace against local causality and privacy expectations.
3. Accept the explicit host exceptions: Cursor, Antigravity, Scout, native macOS/iOS work,
   image-attached prompts and worker-created linked worktrees. OAuth refresh, custom endpoints,
   proxy/CA staging and host-native tool capture remain unsupported/unproved as documented.
4. After these gates, approve/apply the configuration and broker restart in
   [worker-execution.md](../architecture/worker-execution.md). Existing sessions are not migrated;
   a required container request always refuses unsupported execution instead of falling back.

`network: none` remains an explicit refusal because the supported readiness/reporting gateway
requires TCP. Local retention cannot deduplicate against evicted history; pins preserve incidents.
