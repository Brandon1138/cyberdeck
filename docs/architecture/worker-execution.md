# Worker execution

Design: [2026-09-05 worker infrastructure](../design/2026-09-05-worker-infrastructure.md). Acceptance: [worker-infrastructure-acceptance](../setup/worker-infrastructure-acceptance.md).

## The seam

A session names an `executor` (`host` or `orbstack-container`) and a trusted `profile`; the pair is
resolved once by `resolveWorkerExecution` from the request or the broker's `workerExecution`
policy and never from the provider, permissions, approval mode or transport. `WorkerExecutionService`
journals the execution intent before any backend runs, binds one durable execution to one worker
subject (`src/domain/worker-execution.ts`), and hands the backend a `WorkerExecutionPort`:
`prepare → start → inspect → stop → collect → destroy`. A backend that cannot prepare fails the
launch; nothing substitutes another executor. Orchestrators are always host.

The container backend (`src/runtime/execution/orbstack-executor.ts`) drives Docker Engine through the
explicit `orbstack` context, reserves a physical slot before creating anything, creates the container
stopped, verifies the inspected boundary against what it asked for, and starts only after policy and
grant activation. The guest launcher (`infra/worker/launch.mjs`) gates the provider process on the
authenticated `/v1/ready` answer from the broker's worker gateway, so a container can never run a
model turn for a generation the broker has not made authoritative.

## The boundary

Each worker owns: an independent clone with its own Git metadata, cut from a verified base commit and
seeded with the operator's explicitly selected dirty inputs (`selectedInputs`, hash-verified); a
private provider home at `/home/worker`; a read-only credential mount at `/run/credentials` holding
one staged API key and a per-execution gateway token; nothing else. Non-root, all capabilities
dropped, `no-new-privileges`, read-only root, tmpfs `/tmp`, CPU/memory/swap limits, pids limit.
Read-only requests mount the workspace read-only. The host never mounts its home, Keychain, SSH
agent, Docker socket, broker state or another worker's paths. Multi-worker isolation was proved on
real OrbStack: distinct clones, homes and grants; cross-worker reports refused from inside and from
the host; the third worker queued until a slot freed; selective retirement left the others intact.

The gateway (`src/broker/worker-gateway.ts`) accepts `GET /v1/ready` and `POST /v1/report` only,
bound to `127.0.0.1`, authenticated by a per-execution bearer token whose grant is checked against
the live worker/execution/generation on every call. It invokes the existing worker-event facade,
so canonical capability and lease checks apply; there is no operator method and no Docker method.

`network: none` is refused at prepare and reported in health as unsupported: readiness and
reporting are TCP to `host.docker.internal`, and every supported provider needs egress to its model
API. The smallest correction that would make `none` real is a host-reachable non-network transport
(a bind-mounted Unix socket) proved on OrbStack; until then the profile stays a refusal, never a
silent egress launch.

## Lifecycle

`preparing → ready → running → stopping → stopped → collecting → retained → destroyed`, with
`failed` carrying a classified `failure` (`prepare`, `start`, `persistence`, `recovery`,
`timeout`) and a `cleanupEligibleAt`. Timeouts are per attempt (default 60 minutes) and extend only
through acknowledged canonical lease renewal. A stop reaches the guest and is confirmed by
inspection; an OOM is read from the Engine (`OOMKilled`, exit 137). Collection hashes the workspace
and provider-home manifests plus logs into an evidence file; destruction re-verifies that file and
refuses a running or foreign container. Startup reconciliation stops known guest writers before
admission opens and never asserts destroyed for an unreachable daemon. The periodic sweep retires
only failed acquisitions with no registered session after their eligibility time; registered
workers wait for explicit retirement. Shutdown closes admission, then awaits timeout and cleanup work
already in flight.

Resume reuses the same execution, container and workspace at generation+1 and hands the guest its
explicit native conversation id. Handoff moves authority through the one atomic transfer and never
touches the container.

## Workspace trust and interactive prompts

The [#113 prompt policy](provider-interactive-prompts.md) also applies to private clones. A source
repository's operator grant permits the same Claude/Codex trust writer to add only `/workspace` in
that worker's private provider home during quiescent preparation. No host provider config is used
for container launches; provider-owned symlinks refuse preparation. Modal answers resolve the source
through the broker-owned execution context and re-evaluate the current grant. Request metadata and
guest Git config cannot supply a granted source. Revocation blocks answers but does not undo an
existing provider trust entry. Login, unknown and per-action permission prompts remain operator-owned.

## Activity

Every container-native semantic turn is captured from the worker's private transcript under the
identity that dispatched it: a consumed instruction (`expectedTurn`), the launch prompt, a human
composer prompt, or explicitly `unattributed`. Tool invocations and results link to the turn, byte
cursors verify the acknowledged prefix, in-progress turns are read at quiet points, and every
conflict or missing piece is a visible `capture.gap`. Host-native tool capture and
Cursor/Antigravity native capture remain unavailable and say so. Local retention counts the SQLite
index against the cap; the index is disposable and rebuilt at every open.

## Support matrix

`PROVIDER_EXECUTION_SUPPORT` in `src/domain/execution-support.ts` is served through
`cyberdeck_provider_capabilities` and Fleet's capability view.

| Provider | Host | Container | Transports | Auth | Resume | Native capture |
| --- | --- | --- | --- | --- | --- | --- |
| claude | supported | **unproved** (gate: provider canary) | pty, pipe | API-key file | explicit native id from SessionStart hook | turns + tool use/results |
| codex | supported | **unproved** (gate: provider canary) | pty, pipe | API-key file | single rollout under private sessions root | turns + function calls/results |
| cursor | supported | unsupported | none | none | none | none |
| antigravity | supported | unsupported | none | none | none | none |

Refused under a required container profile regardless of provider: scout profile, image
attachments, worker-provisioned worktrees, extra writable roots, job dispatch, app-server dispatch,
network profile `none`. OAuth refresh, custom endpoints and proxy/CA configuration are not staged.

## Canary

`scripts/provider-canary.ts` reads `CYBERDECK_LIVE_EVAL_CONFIG` (provider, model, credential file,
spend ceiling) and runs one real provider in one real container through the production runtime,
recording: an authenticated native turn, a provider-native tool invocation captured by the recorder,
a report through the guest MCP gateway, the observed model, and a generation-2 resume on the same
execution. A passing canary is what moves a provider's container cell to supported.

## Rollout and rollback

Ordinary isolation is opt-in until the acceptance gates pass. The switch is the broker config
(`config.json` under the state directory):

```json
{
  "workerExecution": { "defaultExecutor": "orbstack-container", "hostProfile": "host-compatible", "containerProfile": "ordinary" },
  "containerRuntime": {
    "endpoint": "unix:///Users/brandon/.orbstack/run/docker.sock",
    "image": "sha256:<digest of cyberdeck-worker:20260905>",
    "cpus": 2, "memoryBytes": 4294967296, "slots": 2, "network": "egress", "attemptTimeoutMinutes": 60,
    "credentialFiles": { "claude": "/absolute/private/claude-api-key", "codex": "/absolute/private/openai-api-key" }
  }
}
```

Rollback is `"defaultExecutor": "host"`: new ordinary work returns to the host profile; running
containers, persisted host records and retained evidence are untouched. Neither direction migrates
or kills an existing worker. Both need a broker restart, which is the operator's.

Daily operating commands:

```sh
rtk cyberdeck execution-health                 # daemon reachability, profile support, slots, retained failures, records
rtk cyberdeck execution-cancel --session UUID  # cancel a queued launch or stop an active guest
rtk cyberdeck activity --session UUID          # causal activity, origins, coverage gaps
rtk cyberdeck activity-pin --run UUID          # hold incident evidence against retention
rtk docker --context orbstack ps -a --filter label=cyberdeck.broker=<brokerId>
node --import tsx scripts/recover-worker-proof.ts <evidence-dir>   # evidence-preserving recovery of a proof checkpoint
pnpm --dir evals run eval:container            # the container-backed harness, no model
```
