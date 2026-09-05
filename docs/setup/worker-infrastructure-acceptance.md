# Worker infrastructure acceptance

Candidate: branch `feat/worker-infrastructure-live-harness`, last code commit 898d2fb, stacked on
#111 (`feat/worker-infrastructure-coordination-activity` at cf34006). Active checkout untouched at
main 70190e2. Image `cyberdeck-worker:20260905` =
`sha256:5d179eccc6bd197adbb6d0ca2928778e04716ce3ab4d6a3ae560fbe95227e413` on
`node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`;
guest Claude 2.1.261, Codex 0.153.4. OrbStack 2.2.3, Engine 29.4.0, context `orbstack`,
endpoint `unix:///Users/brandon/.orbstack/run/docker.sock`, 12 CPUs, 12,599,844,864 bytes.
Node 24.18.0, pnpm 11.5.0, Promptfoo 0.122.2. No active-broker restart, protected merge, remote
telemetry, model call or hosted-settings change was performed.

## What is proved, by evidence kind

Evidence root `/var/folders/dn/ts3sd7810lb9wv8j58h_3qrh0000gn/T/`; temporary evidence can vanish,
verify existence before citing.

| Claim | Kind | Evidence |
| --- | --- | --- |
| Executor selection, durable intent, no host fallback, cancellation, deadlines, retirement | static | `tests/orchestration/worker-execution.test.ts`, `tests/runtime/execution/*` |
| Two concurrent workers isolated; third queued then run; cross-worker report refused from guest and host; selective retirement; reconciliation over two live guests | host + container runtime | `cyberdeck-multi-worker-proof-vggghx` (`isolation.json`, `after-stop.json`, `retirement.json`, `reconciliation.json`) |
| Real attempt-deadline stop, real cgroup OOM (137), gateway probes refused from inside the guest, private clone with selected inputs, report through gateway, mount-disjoint cross-worker | container runtime, scripted guest | `pnpm --dir evals run eval:container` → Promptfoo `eval-n0b-2026-09-05T20:04:11`, 8/8, validator `[]`; per-scenario `cyberdeck-eval-*` dirs named in `evals/results/container.json` (ignored) |
| Every container-native turn captured by dispatch origin, running-turn capture, strict `/clear` | static | `tests/runtime/activity/turn-native-capture.test.ts` |
| Index counted in cap, corrupt index rebuilt, failed write recovered | static | `tests/persistence/agent-activity-store.test.ts` |
| `network: none` refused with reason; health reports profile support and retained failures | static | `tests/runtime/execution/orbstack-executor.test.ts` |
| Earlier lifecycle proofs (resume gen 2, SIGKILL recovery, timeout, OOM, session activity) | container runtime | `cyberdeck-broker-container-proof-{37EeF8,8bfTTa,12IhOQ,2SLMpT,RGQqdD,di5Ijd}` |
| Offline harness | host | `eval:offline` 8/8 after the mode refactor |

Full suite at 898d2fb: 176 files / 2,104 tests, TypeScript for root and evals, architecture and
file-size ratchets unchanged. Packed CLI: see `scripts/prove-pack.ts` output recorded in the
progress checkpoint.

## Gates still open

| Gate | Blocked on | What closes it |
| --- | --- | --- |
| Claude/Codex container cells `unproved → supported` | explicit provider, model and total spend ceiling; credential file | `scripts/provider-canary.ts` with `CYBERDECK_LIVE_EVAL_CONFIG` |
| Live Promptfoo baseline (3 repetitions, cache off) | same authorization | `pnpm --dir evals run eval:live` |
| Real Sentry trace | Sentry activation, project/region/DSN, actual allowance | named 100% canary, then set `dailyEnvelopeCap` |
| Default isolation for ordinary workers | all three above, plus acceptance of the host exceptions below | config switch in `docs/architecture/worker-execution.md`, broker restart |

## Host exceptions for explicit acceptance

Everyday work that keeps the host profile after rollout, each named with its reason
(`HOST_EXCEPTIONS` in `src/domain/execution-support.ts`): Cursor workers, Antigravity workers,
Scout, native macOS/iOS builds and simulators, image-attached prompts, workers that must create
linked worktrees. Rollout under `defaultExecutor: orbstack-container` refuses these unless the
request names `executor: host` and the `host-compatible` profile.

## Known limits, stated

- Local activity replay after retention cannot deduplicate against evicted rows; a replayed old
  event reappears with a new sequence. Retention is 30 days; pins hold incidents.
- Live prompts have not been run against a paid model; the first baseline calibrates them.
- OAuth refresh, custom endpoints, proxy/CA are not staged into containers.
- The timeout scenario advances the clock handed to the real expiry path rather than waiting the
  configured hour; the guest stop and the durable record are real.
