# Worker infrastructure design

Status: accepted by the operator on 2026-09-05; implementation authorized. Remote telemetry activation, paid model runs, active-broker migration and protected merges retain their explicit gates.

Inspected 2026-09-05 at `70190e2b3c7834011f39c0418764c2e4aca19b37` on `main`.

## Objective and existing decisions

Give each Cyberdeck worker an independently controlled execution boundary, retain enough attributable evidence to investigate its actions, and evaluate real orchestration behaviour with repeatable Promptfoo scenarios. Cyberdeck remains authoritative for worker identity, instructions, leases, handoffs, and results.

The [MIK-91 design record](https://linear.app/mikoshi/document/mik-91-hardening-design-sbx-sentry-promptfoo-fbef04f65f08) records Brandon's August 29 decisions: per-worker OrbStack containers, Sentry free tier with metadata-only export, and Promptfoo after execution and telemetry. These are existing decisions, not questions to reopen. The September 5 request strengthens the desired worker coverage and asks for exact action reconstruction. This specification identifies the changes needed to achieve that without claiming evidence the providers do not expose.

## What exists today

| Area | Inspected evidence | Consequence |
|---|---|---|
| Execution | `src/runtime/session-runtime-adapter.ts` selects host `PtyProcess` or `PipeProcess`; `src/broker/main.ts` injects it | No container executor is wired into sessions |
| Permissions | `src/domain/session.ts` defines `sandbox` as `read-only` or `workspace-write` | This field describes provider permissions, not process isolation |
| Lifecycle | Launch, resume, exit, and cleanup live in `src/orchestration/session/` | Useful existing seams; do not rebuild the registry |
| Identity | Worker subjects, session resource references, lease versions, and controller identities already exist | Bind execution to the worker/session mapping; never key it to the current Orc or lease token |
| Other launch paths | `src/app-server/dispatch-adapter.ts` and provider `dispatch-adapter.ts` files spawn job runtimes separately | Session-only wiring would leave a host execution bypass |
| Evidence | `ThreadTranscriptStore` stores bounded semantic events, primarily native final responses; Cursor/Antigravity use marked terminal fallback | Current transcript storage cannot reconstruct all tool activity |
| Telemetry | Budget/model parsers exist; no Sentry/OTel dependency or exporter found | Quota observation is not agent tracing |
| Evaluation | Vitest and macOS CI exist; no Promptfoo dependency, configuration, or harness found | Behavioural evaluation is missing |
| Machine | Docker client 29.4.0, context `orbstack`, missing `/Users/brandon/.orbstack/run/docker.sock`; `sbx` absent | Current daemon operation and isolation are unverified, not a product failure |

The source search found prior planning references to SBX/Sentry/Promptfoo, not an implementation. The current checkout had pre-existing untracked `AGENTS.md` and `handoffs/`; preserve both. No worker was launched, no daemon started, no account data read, no model calls made, and no Sentry project configuration inspected in this planning pass.

## Docker product distinction

Use Docker Engine containers on **explicit context `orbstack`**, as ratified. Name the backend `orbstack-container` in persisted facts; retain `sbx` only as a documented compatibility name if necessary.

Current Docker documentation describes **Docker Sandboxes** as the standalone `sbx` product, giving each sandbox a microVM and not requiring Docker Engine or Docker Desktop. The removed `docker sandbox` command is not an OrbStack executor. Adopting that product instead would be a separate architecture change, not a command substitution.

OrbStack containers share its Linux VM/kernel. They provide filesystem/process/resource boundaries, not a separate microVM per worker. Default egress also permits network access and possible credential exfiltration. State those properties honestly in capability output and threat documentation.

## Worker ownership and policy

One durable execution environment belongs to one worker. A worker session may have many turns and process generations. Resume reuses its private workspace and provider conversation; handoff changes controller authority while preserving the environment. Different workers never share a writable workspace, provider home, package store, or transcript directory.

Broker, Fleet, tmux, nvim, orchestration, integration/review, credential provisioning, and Sentry export stay on macOS. Sandboxed provider CLIs and build/test commands run in Linux. Native macOS/iOS tasks require an explicit host execution profile and visible reason. Arbitrary existing sessions are not migrated while live.

Rollout proposal: retain host semantics for existing records and an initial opt-in canary; after the proof gates, configure new ordinary workers to require `orbstack-container`. Unsupported providers or native-only work return a specific refusal or require an explicit host profile. Never fall back to host because Docker, an image, credentials, or a capability is unavailable. Orchestrators remain host-native under the existing first-party routing policy.

The `sandbox` and `approvalMode` fields remain independent of `executor`. Broad provider permissions are allowed only for a `workspace-write` container profile that passed mount, credential, network, and broker-access checks. Read-only requests must remain read-only at the mounted workspace. Do not silently reinterpret `approvalMode: prompt` as automatic, or change host flags. Automatic inside-container permissions were a proposed default in August, not a ratified global bypass; the implementation must expose the requested and achieved permission policy.

## Boundary corrections to the August design

1. **Worktree Git metadata:** a normal linked worktree's `.git` file points outside its tree. Mounting only that tree breaks Git; mounting the primary checkout's Git directory read-write exposes other workers and repository configuration. Use a broker-created, independent clone with its own Git metadata per worker (`git clone --no-local` from a verified local source/base, with hooks disabled during provisioning). Seed explicitly selected dirty input using a verified patch and untracked-file manifest; never silently omit it. The worker clone stays on the host for review, while its container sees only that clone. Export commits/diffs for host-controlled integration. Host collectors must treat its Git configuration, hooks, filters, fsmonitor, external diff and textconv settings as untrusted: use a trusted configuration/environment and disable executable extensions when inspecting it. Do not mount the original `.git` tree to make the first prototype work.
2. **Transcript direction:** a writable bind is not a one-way evidence channel. Give each worker a private provider state/transcript directory; the host collector reads it and writes a separate host-only activity journal. Treat provider files as untrusted observations that can be changed/deleted by the worker. Record gaps/rotation/tampering signals. Broker-acknowledged control events and host filesystem snapshots have different provenance.
3. **Authentication:** mounting macOS home/config directories is neither portable nor isolated. Claude Keychain state, Codex auth refresh, remote endpoint configuration, and certificate/proxy paths need explicit Linux-compatible preparation. Use only selected credentials, never the host home or Keychain. Credentials staged read-only may need a private writable copy for CLI refresh; that is a documented credential exposure, and refreshed state must not overwrite host credentials automatically. Verify each provider's actual authentication path without logging values.
4. **Worker reporting and MCP:** host absolute Node/CLI paths and Unix sockets do not become usable inside Linux. Bake a minimal Linux-compatible reporting/MCP client into the image and provide an authenticated, narrowly scoped host gateway. Do not mount the unrestricted broker socket, Docker socket, or all broker state. Gateway requests use existing worker authority and capability checks; a worker credential cannot invoke operator handoff or another worker's controls. Allowed worker MCP servers need container-compatible configuration; unknown host commands fail preflight.
5. **Lease versus execution lifetime:** lease renewal/transfer must not recreate or destroy a container. Reconciliation consumes canonical worker/lease state, rather than a second lease engine. A stale controller is fenced by existing versions; container stop is a separate execution effect. “Lease expired” does not prove that shell commands already running inside the container stopped.
6. **Local endpoints:** provider routes using host loopback need a verified container-reachable endpoint and scoped access. `localhost` inside a container is not macOS. Normal egress is not a guarantee that host services are unreachable. The gateway must authenticate even on a trusted local network.

## Execution lifecycle and proposed operating values

Use a persisted execution record, separate from the session's process state:

`reserved → preparing → ready → running → stopping → stopped → collecting → retained → destroyed`

Any phase may record a classified failure. Each resource acquisition is journalled and tagged with durable broker identity, worker identity, and execution ID before admitting another action. Labels alone are not permission to delete: reconciliation must match the durable record and explicit OrbStack endpoint.

| Event | Required behaviour |
|---|---|
| Admission/cancel before launch | Reserve physical capacity before create; cancellation and failure release it exactly once |
| Stop/timeout | Stop the guest process/container, not just the host `docker attach` client; confirm exit and classify timeout/OOM separately |
| Turn completion | Keep the worker usable for follow-up turns; a completed turn is not session retirement |
| Worker retirement/success | Stop writers, collect final evidence and verify artifact hashes, destroy container; retain workspace/evidence under their own policy |
| Failure | Stop compute; retain stopped diagnostic state for 24h by proposed default; running retention does not consume indefinite CPU |
| Resume | Reconcile first, prohibit duplicate live generations; reuse verified state or report lost native resume capability |
| Handoff | Preserve execution ID/workspace; fence old controller using the canonical transfer path |
| Broker crash | Reconcile known IDs before serving launches; explicitly stop or reattach only if guest identity and transport ownership are proved |
| OrbStack unavailable | Record degraded/unreachable, prevent new sandbox launches, retain evidence and retry; never assert destroyed |
| Orphan cleanup | Use canonical lease/worker reconciliation; wait for policy eligibility, preserve uncollected data, retry idempotently |

Proposed initial limits: 4 running container slots (August proposal), 2 vCPU and 4 GiB per normal worker, configurable toolchain profiles for heavier builds. Preflight must compare aggregate reservations against actual OrbStack VM capacity before enabling 4 slots. Queue wait does not consume a running slot. Use per-attempt timeout profiles (proposed 60 minutes, renewable through existing authority), not a fixed TTL that unexpectedly kills a productive persistent worker. Retention cleanup never deletes user worktrees or uncollected results.

Network profiles initially are `egress` and `none`, matching the ratified design. Domain allowlisting is deferred and must not be advertised. No privileged containers, host PID/network mode, extra devices, Docker socket mounts, host SSH-agent forwarding, or writable shared caches. Capabilities dropped and `no-new-privileges` enabled where provider/runtime proof supports them. Dependencies that require Docker (e.g. integration DB stacks) need a separately designed private service profile; mounting OrbStack's socket is not an acceptable shortcut.

## Activity recording and Sentry

The local record is unsampled within declared retention and storage limits. Sentry is a sampled metadata projection. A free-tier remote service cannot be the only complete history.

Record schema version, event ID, ingest sequence, occurred/observed timestamps, run/task ID, worker subject ID, session ID, generation, instruction ID, provider conversation/turn/tool-call IDs when available, execution ID, causal parent/link, provider/model/effort, duration, outcome, usage with provenance, artifact references, and capture coverage. Missing token/cost observations remain unknown; account quota percentages are not per-run token usage.

Event families: instruction queued/rendered/submitted/settled; worker lifecycle; lease/control/handoff; execution prepare/start/stop/collect/destroy; provider request/response where genuinely observed; tool invocation/result where provided; reported decision/risk/checkpoint; capture gap; verified workspace/artifact snapshot; evaluation result.

Keep user/controller claims, provider observations, broker acknowledgements, and host-verified facts distinct. A tool-call record describes an invocation; a shell output or agent claim alone does not prove its reported filesystem effect. Hidden model reasoning and provider-internal actions are not observable. Cursor/Antigravity remain partial until a documented native source appears; do not invent a tool parser from screen text.

Local diagnostic bodies may reference existing private native transcripts, exact tool arguments/results where recorded, and captured artifacts. No new blanket duplication of credentials, all host files, or arbitrary terminal replay. Proposed diagnostic retention: 30 days with a 2 GiB broker-wide cap and explicit pinning/export for incidents. Redact known credentials before persisted derived payloads; originals remain under provider-owned policy. Represent truncation, quota eviction, disk-full, and unsupported capture in the read model. A strict evaluation profile fails when required evidence is missing. Ordinary operation may continue degraded, but never claim complete recording.

Sentry export allowlist: opaque IDs, enumerated operation names, provider and observed/requested model distinction, generation, executor, role labels from reviewed values, lease version/state, timing, classified errors, counts, observed usage, capture coverage, schema/release version. No prompts, transcript bodies, tool arguments/results, shell commands/output, file paths/names, diffs, source, credential values, arbitrary tags, exception text containing payloads, or raw breadcrumbs. Use final transport-envelope tests, not regex redaction alone. The August exclusion remains in force even though Sentry's AI examples show input/output attributes.

Use OTel semantic conventions through an internal recorder port. Sentry's Node SDK plus its supported OTel integration supplies the first sink; a DSN is not an arbitrary OTLP endpoint. Start with explicit instrumentation and avoid broad automatic integrations that capture unrelated process/HTTP data. Represent bounded agent turns with `gen_ai.invoke_agent`, observed tool operations with `gen_ai.execute_tool`, and Cyberdeck control/lifecycle operations with stable custom names. Use short traces/segments and persisted correlation links across long sessions and restarts; do not keep a multi-day span open.

Head sampling cannot recover an earlier unsampled trace when a failure is discovered later. Preserve that history locally. Proposed normal trace rate 10%, bounded error export, and 100% only for a tiny named canary. Set daily export caps from the actual Sentry project's free allowances, measured spans/run, and remaining quota; do not invent today's free-tier prices/quotas. Export backlog is bounded; outage, 429, or exhaustion affects only export health. Sentry is never needed for recovery or Promptfoo assertions.

## Promptfoo evaluation contract

Promptfoo is a development dependency in an isolated `evals/` package, not part of ordinary runtime publication. Its custom provider launches a real **test broker** using separate state/socket/identity, a scratch repository, a container worker, bounded credentials and budgets, and scenario fixtures. It returns structured evidence, not just an agent's final answer. Never dispatch evaluations into the operator's active broker.

Use three levels:

1. Offline CI: parser fixtures, deterministic recorder/assertion tests, and a scripted provider exercising the real test broker. Proves infrastructure and assertion behaviour, not model judgement.
2. Bounded live agent suite: manually dispatched on a dedicated trusted Mac with OrbStack, credentials and explicit budget. Record provider CLI version, model, effort, image digest, commit, scenario version and evidence hashes. No shared active checkout and no secrets on untrusted PR code.
3. Optional later model-graded reviews: advisory until calibrated; deterministic scope/authority/isolation checks remain hard failures. Do not add judge-model charges in the initial implementation.

Initial scenarios: unrelated dirty work preserved; truthful changed-file report checked against baseline/final filesystem facts; instruction delivered before late canonicalization is not swallowed; stale controller output after handoff cannot commit broker mutations; malicious repository/tool text cannot grant authority; timeout/OOM cancels the worker and releases capacity; Sentry failure cannot stop delivery; cross-worker paths and credentials unavailable.

“No destructive Git command” needs actual command/tool evidence for the scenario. Unchanged final files alone cannot prove no destructive command was attempted. If command coverage is absent, fail the evidence requirement or grade a narrower final-state claim explicitly. Infrastructure invariants also keep their conventional unit/integration tests; Promptfoo adds the real-agent behavioural layer.

Gate on zero critical violations, zero harness errors, complete required evidence, and explicit wall-clock/token ceilings where measurable. Report unknown spend as unknown, not zero. Proposed first live baseline: 3 repetitions per scenario with fixed configuration and cache disabled, within an operator-supplied total budget. Record stochastic outcomes and compare against the baseline; do not turn a single successful run into reliability proof.

## Delivery scope and review points

Implementation runs through the companion [plan](../superpowers/plans/2026-09-05-worker-infrastructure.md). The plan proposes corrections to workspaces, credentials/gateway, lifecycle semantics, richer local capture, and eventual default worker isolation. These are concrete reviewable changes to the August record. The operator accepted these corrections and authorized implementation on 2026-09-05. Proceed task-by-task without further architecture consultation; remote activation, spending and active-broker rollout remain separately gated.

Do not automatically create/comment on Linear issues, merge protected branches, change account/project settings, restart the running broker, install dependencies/services on the host, or migrate active workers as part of planning. No such actions have been performed.

## Sources checked

- [MIK-91 umbrella](https://linear.app/mikoshi/issue/MIK-91/harden-cyberdeck-with-sbx-isolation-sentry-observability-and-promptfoo) and the linked August 29 design, retrieved September 5.
- [Docker Sandboxes installation](https://docs.docker.com/ai/sandboxes/install/) and [Docker retired products](https://docs.docker.com/retired/), current documentation retrieved through Context7 (`/docker/docs`): standalone `sbx`, separate microVMs, removed plugin.
- [Sentry manual agent tracing source](https://github.com/getsentry/sentry-docs/blob/master/docs/platforms/javascript/common/agent-tracing/manual-instrumentation.mdx) and [OTel setup source](https://github.com/getsentry/sentry-docs/blob/master/platform-includes/performance/opentelemetry-setup/javascript.mdx), retrieved through Context7.
- [Promptfoo custom provider](https://www.promptfoo.dev/docs/providers/custom-api/) and [Node assertion API](https://www.promptfoo.dev/docs/usage/node-api-reference/), retrieved through Context7.

External docs describe available APIs, not proof that they work on this machine. The August OrbStack smoke proof is historical; this inspection found its current socket unavailable. The implementation must refresh host/runtime evidence.
