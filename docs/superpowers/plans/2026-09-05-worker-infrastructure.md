# Cyberdeck Worker Infrastructure Implementation Plan

> **For agentic workers:** Execute task-by-task with a verification/review checkpoint per deliverable. Superpowers workflows and additional agents remain opt-in under this repository's instructions; this plan does not require their automatic invocation.

**Goal:** Deliver per-worker OrbStack isolation, attributable local activity records with Sentry observability, and repeatable Promptfoo evaluations through the real Cyberdeck broker.

**Architecture:** Add an execution backend beneath existing session/provider orchestration, bind it to durable worker identity, and retain the host control plane. Build a provider-neutral activity recorder independently of its sampled Sentry sink. Evaluate the actual broker and workspace effects with Promptfoo, using isolated fixtures and explicit capture coverage.

**Tech Stack:** TypeScript, Node `>=24.18.0 <25`, pnpm `11.5.0`, existing Vitest; Docker Engine via explicit OrbStack context; pinned Linux toolchain/provider images; OpenTelemetry/Sentry Node integration; Promptfoo in a separate development package.

**Spec:** [Worker infrastructure design](../../design/2026-09-05-worker-infrastructure.md). Read the whole specification and the linked August 29 design first.

## Global constraints

- Baseline inspected: `70190e2b3c7834011f39c0418764c2e4aca19b37`. Revalidate HEAD and dirty files before implementation; never reset to this SHA automatically.
- Prefix repository shell commands with `rtk`. Preserve existing untracked `AGENTS.md` and `handoffs/`, operator state, active broker, worktrees, accounts and provider routing.
- Per-worker OrbStack containers, Sentry free tier, Promptfoo, metadata-only remote export are ratified decisions. `sbx` the Docker product is not the chosen OrbStack backend.
- Provider, executor, permission, workspace and transport remain independent. No automatic host fallback; no additional controller derivation; no parallel lease authority.
- Keep domain/application code free of Docker and Sentry imports. Honor dependency and file-size ratchets; new source files stay at or below 500 lines, and do not raise ceilings to fit this work.
- No raw prompts, transcripts, tool arguments/results, arbitrary output, paths, source or secrets go to Sentry. Local diagnostic data has explicit coverage and retention.
- Preserve terminal bytes and provider submission protocols. If key handling becomes necessary, read `BUGS.md` Standing constraints before touching it. Read `docs/architecture/nvim-surface.md` before any nvim presentation changes; none are planned.
- New implementation worktrees must not run a second Fleet/nvim surface: the documented hardcoded Lua checkout and socket namespace limitations would apply. Test brokers use unique identities/state/sockets and no tmux/nvim integration.
- Plan-only work is complete here. Implementation, host setup, paid live evaluation, remote telemetry activation, and rollout are not claimed or performed.

## Deliverables and dependencies

Use three linked delivery tracks, with small PRs rather than one infrastructure monolith:

```text
0: preflight + approved contract corrections
  ├─ 1: executor/identity seam
  │    → 2: isolated workspace + image + authenticated bridge
  │    → 3: OrbStack runtime + recovery + scheduler
  │    → 4: provider/path parity + explicit permission policy
  └─ 5: activity schema + durable capture
       → 6: Sentry sink + causal canary

4 + 5 → 7: Promptfoo harness + historical regressions
4 + 6 + 7 → 8: acceptance + worker-default rollout
```

Tasks can be implemented in separate sessions. Concurrent agents are not required or authorized by this document. Task 5 can progress independently if OrbStack setup is blocked. Task 7 may build its offline harness before live isolation is ready, but the live gate waits for Task 4.

## Shared interfaces

These are proposed contracts, to be compiled and covered by Task 1/5 tests before dependents consume them. Names below are new unless explicitly imported from existing files. Keep implementation adapters behind these narrow application-owned interfaces.

```ts
// src/domain/worker-execution.ts
export type WorkerExecutor = "host" | "orbstack-container";
export interface WorkerExecutionRequest {
  executor: WorkerExecutor;
  profile: string; // trusted configured profile; not arbitrary mounts/CLI flags
}
export interface ExecutionIdentity {
  brokerId: string;
  executionId: string;
  workerId: string;
  sessionId: string;
  generation: number;
}
export interface ExecutionRef extends ExecutionIdentity {
  executor: WorkerExecutor;
  backendId?: string;
  workspaceId: string;
}
export interface ExecutionInspection {
  ref: ExecutionRef;
  state: "absent" | "stopped" | "running" | "unreachable";
  guestExitCode?: number;
  oomKilled?: boolean;
}

// src/orchestration/session/execution-ports.ts
// Import SessionRecord, SessionRuntime and ProviderLaunchSpec from existing ports.
export interface PreparedExecution {
  ref: ExecutionRef;
  launch: ProviderLaunchSpec; // target-aware spec; secrets never enter durable metadata
}
export interface ExecutionLaunchInput {
  record: SessionRecord;
  request: WorkerExecutionRequest;
  identity: ExecutionIdentity;
  launch: ProviderLaunchSpec;
}
export interface CollectedExecution {
  manifestRef: string;
  complete: boolean;
}
export interface WorkerExecutionPort {
  prepare(input: ExecutionLaunchInput): Promise<PreparedExecution>;
  start(prepared: PreparedExecution, replayBytes: number): Promise<SessionRuntime>;
  inspect(ref: ExecutionRef): Promise<ExecutionInspection>;
  stop(ref: ExecutionRef, force: boolean): Promise<ExecutionInspection>;
  collect(ref: ExecutionRef): Promise<CollectedExecution>;
  destroy(ref: ExecutionRef): Promise<void>;
}
```

`prepare` must not guess host-to-guest paths by string replacement. Task 2 produces an explicit path/config map, and provider adapters must build the guest launch against it. The interface wraps the current sync host factory; it does not pretend container preparation is synchronous. Preserve the existing `SessionRuntime` byte/control surface, but use execution inspection for guest liveness: its `pid` remains only a host transport PID. Container IDs never go in `pid`.

The persisted execution store records state, attempts, image digest, owned resources, resolved policy, cleanup eligibility, and last inspection. A worker has at most one active execution binding; process `generation` changes independently. On a job path without a session, first define the explicit job-attempt → worker/execution binding; do not invent a session UUID merely to satisfy this interface. A separate job execution port may use the same backend resource manager with a discriminated owner reference.

## Task 0: Revalidate environment and settle concrete design corrections

**Files:** Create `docs/setup/worker-infrastructure-preflight.md`; finalize `docs/design/2026-09-05-worker-infrastructure.md` with accepted decisions. No production code in this task.

**Consumes:** current checkout, ratified August design, this proposed spec.
**Produces:** exact supported host/runtime/provider versions, approved configuration values, and a capability matrix; no inferred runtime proof.

- [ ] Record `rtk git status --short --branch`, `rtk git rev-parse HEAD`, `rtk git worktree list`, current architecture tests and package scripts. Create an isolated implementation worktree once implementation is requested; keep the running checkout/broker unchanged.
- [ ] Run read-only host preflight: `rtk docker --context orbstack version`, `rtk docker --context orbstack info`, `rtk docker --context orbstack context inspect orbstack`. Record endpoint and actual VM capacity; never switch the global Docker context. If its socket is unavailable, report that before any host setup, and continue independent source tasks.
- [ ] Record installed provider versions/help and Linux image support without printing credentials. Verify Node/arm64 support, PTY, auth refresh, custom endpoint routing, native transcript paths and reporting bootstrap for each provider.
- [ ] Present/record acceptance of the spec's independent-clone workspace correction, scoped host gateway, read-only versus automatic permission distinction, complete-local/metadata-remote capture, limits/retention, and staged worker-default policy. Do not ask again about already ratified OrbStack/Sentry/Promptfoo choices.
- [ ] Capture Sentry project/region/DSN availability and free allowances as configuration requirements without creating or changing a project. Live model/provider selection and total evaluation spend cap must be supplied before live calls; no hidden paid default.
- [ ] Verify resource-limited Docker/PTTY/filesystem/network behaviour in **owned scratch resources only**, after host/runtime work is authorized. Persist exact command/version/output evidence and cleanup confirmations.

**Gate:** explicit capability matrix and configuration values, with blocked/unverified cells retained as such. Host provider authentication is not evidence of container authentication. August smoke results are historical, not a substitute.

## Task 1: Add executor selection and durable execution identity

**Create:** `src/domain/worker-execution.ts`, `src/orchestration/session/execution-ports.ts`, `src/orchestration/worker-execution-service.ts`, `src/persistence/worker-execution-store.ts`, `src/runtime/execution/host-executor.ts`.

**Modify:** `src/domain/session.ts`, `src/domain/job.ts`, `src/config.ts`, `src/broker/main.ts`, `src/orchestration/session/session-launch-coordinator.ts`, `src/orchestration/session/session-runtime-assembly.ts`, `src/orchestration/session/session-registry-ports.ts`, `src/orchestration/agent-control-service.ts`, `src/mcp/server.ts`, `src/cli/runtime.ts`.

**Test:** `tests/orchestration/worker-execution.test.ts`, `tests/persistence/worker-execution-store.test.ts`, `tests/runtime/execution/host-executor.test.ts`, existing session/broker/schema/architecture tests.

**Consumes:** approved execution profile definitions and existing session/provider ports.
**Produces:** compiled shared interfaces, trusted profile resolution, durable execution intent and binding, host adapter preserving current behaviour.

- [ ] Add Zod schemas for the shared contracts; existing serialized sessions parse as host. New worker requests resolve executor from explicit request or broker policy. Raw `mounts`, credentials and arbitrary Docker flags are not request fields.
- [ ] Write tests for explicit selection round-trip across MCP → service → registry; denied capability/refused profile; old-record migration; no host fallback; orchestrator exclusion. For a required container profile with an unavailable backend, assert the host runtime spy remains uncalled.
- [ ] Add one durable worker-to-execution binding, respecting the existing subject/session resource relationship. Journal launch intent before provisioning; recover incomplete intents and never allocate two active environments for concurrent resumes of one worker.
- [ ] Wrap `createSessionRuntime` in the host executor and await preparation through the existing launch/resume coordinator. Keep activation/grant persistence ahead of first model turn. Failure unwind preserves the primary error and records cleanup failures.
- [ ] Surface requested executor and achieved execution facts in the existing inspection result. Make unsupported job executor requests fail explicitly until Task 4; never strip the field and launch on host.
- [ ] Run focused tests, typecheck, and architecture ratchets, then create a small reviewable commit.

**Core test pattern (adapt to existing test helpers):**

```ts
const hostStart = vi.fn();
const backend = { prepare: vi.fn().mockRejectedValue(new Error("EXECUTOR_UNAVAILABLE")) };
await expect(startContainerWorker({ backend, hostStart })).rejects.toThrow("EXECUTOR_UNAVAILABLE");
expect(hostStart).not.toHaveBeenCalled();
```

`startContainerWorker` is a test helper created in `tests/orchestration/worker-execution.test.ts`; it constructs the real launch coordinator with an explicit container profile and injected fakes. It must not be a second implementation of executor selection.

**Gate:** host regression tests pass unchanged in meaning, failed container intent is durable, requested backend cannot disappear at a serialization boundary.

## Task 2: Build isolated workspace, provider home, image and reporting boundary

**Create:** `src/orchestration/isolated-workspace-provisioner.ts`, `src/runtime/execution/container-launch-context.ts`, `src/runtime/execution/container-credentials.ts`, `src/broker/worker-gateway.ts`, `src/runtime/execution/worker-gateway-client.ts`, `infra/worker/Dockerfile`, `infra/worker/README.md`.

**Modify:** `src/orchestration/session/session-workspace-ports.ts`, `src/orchestration/session/session-workspace-coordinator.ts`, `src/domain/worker-workspace.ts`, `src/providers/launch-environment.ts`, `src/providers/claude.ts`, `src/providers/codex.ts`, `src/orchestration/session/worker-reporting.ts`, Linux client build/pack scripts as needed.

**Test:** `tests/orchestration/isolated-workspace-provisioner.test.ts`, `tests/runtime/execution/container-launch-context.test.ts`, `tests/broker/worker-gateway.test.ts`, `tests/runtime/execution/container-credentials.test.ts`.

**Consumes:** Task 1 execution identity/profile; existing authority and reporting handlers.
**Produces:** isolated clone plus verified input manifest; guest path/config map; pinned Linux image; scoped reporting/MCP transport.

- [ ] Provision a private clone with its own Git metadata and exact base commit. Test a linked-worktree source, dirty tracked/untracked inputs, ignored-file exclusion, symlinks escaping the allowed tree, source paths containing spaces, missing base, and failure rollback. No untracked source input is copied without the declared manifest. Test hostile Git hooks/config/filter/fsmonitor/textconv settings and prove host collection/review never executes them.
- [ ] Persist host workspace path and guest path separately. Keep host review/PR attribution associated with the declared branch/base, never with the operator checkout's branch. Reuse existing worktree inventory semantics where applicable; independent clone mode needs explicit workspace representation rather than pretending to be a linked worktree.
- [ ] Build a pinned, non-root Linux image with the selected provider CLI/toolchain and private package store. Do not `npm install` the macOS-only root package unchanged: package metadata currently declares `os: ["darwin"]`. Bundle only the Linux-compatible worker reporting client and dependencies, keeping Fleet/node-pty host packaging separate.
- [ ] Stage exact credentials and minimal configuration per worker, using 0700 directories/0600 files where supported. Exclude ambient homes, unrelated MCP servers, host hooks, socket paths and secret-bearing launch metadata. Test required credential absence, refresh in private writable provider state, and cleanup without deleting host originals.
- [ ] Make all launch references guest-valid: initial prompt files, instruction/MCP files, images, hooks, auth, CA/proxy paths, workspace roots, reporting command, resume state and transcript bindings. Preflight unsupported references before creating a provider process.
- [ ] Implement an authenticated gateway that invokes existing worker-scoped handlers with existing authority checks. Bind only to the tested required interface; verify origin/network reachability, bounded request sizes, revocation, replay/idempotency, wrong-worker requests and attempts to call operator-only methods. Do not expose a generic broker proxy or a Docker-control method.
- [ ] Read and export evidence through host-owned collectors; each worker only writes its own native state. Test that worker A cannot access B's state, the broker journal, the primary checkout, Docker socket, or host SSH agent.
- [ ] Run focused tests and a scratch image/container proof; inspect the actual mount list and guest UID/capabilities. Commit source and reproducible build instructions, never credentials or private build context.

**Gate:** provider login and report-back work inside the target container without ambient host authority; Git changes remain private and reviewable; boundary tests run on actual OrbStack.

## Task 3: Implement OrbStack execution, scheduling and crash recovery

**Create:** `src/runtime/execution/orbstack-client.ts`, `src/runtime/execution/orbstack-executor.ts`, `src/runtime/execution/container-session-runtime.ts`, `src/orchestration/execution-slot-scheduler.ts`, `src/orchestration/execution-reconciler.ts`.

**Modify:** Task 1 execution store/service, `src/orchestration/session/session-lifecycle-controller.ts`, `src/orchestration/session/session-runtime-observer.ts`, `src/orchestration/session/session-record-projection.ts`, `src/broker/main.ts`.

**Test:** `tests/runtime/execution/orbstack-executor.test.ts`, `tests/runtime/execution/container-session-runtime.test.ts`, `tests/orchestration/execution-reconciler.test.ts`, `tests/orchestration/execution-slot-scheduler.test.ts`.

**Consumes:** isolated launch context, execution intent and owned-resource manifests.
**Produces:** real container PTY/pipe runtime, confirmed guest outcomes, bounded physical execution, durable recovery and idempotent cleanup.

- [ ] Invoke Docker with argument arrays and an explicit verified context/endpoint on every operation. Parse structured inspect output; do not infer guest status from CLI stdout text or the local attach PID. Use durable ownership labels and pinned image digest.
- [ ] Create stopped resources, persist backend ID, and start only after policy/auth activation. Apply configured memory/CPU, network, non-root/capability constraints and private mounts. Refuse silently ignored resource/security settings.
- [ ] Implement output streaming, input, terminal resize, stop/force-stop and exit inspection. Test rapid process exit, fragmented UTF-8, interactive prompt delivery, terminal resize, attach-client loss with live guest, guest crash and OOM. Preserve existing provider key handling.
- [ ] Separate logical admission from physical slot reservation. Test five workers under a two-slot test config, FIFO/fair queue behaviour, queued cancellation, prepare failure, timeout, restart, and release exactly once. Recompute occupancy from owned running containers on recovery before admitting replacements.
- [ ] Implement the spec's lifecycle table. Collection follows confirmed writer stop and returns a checksum manifest; failed/incomplete collection prevents destructive cleanup. A completed turn keeps its session available. Diagnostic retention stops compute but retains allowed files.
- [ ] Reconcile canonical worker state and owned containers at startup and periodic sweep; serialize cleanup with handoff/resume. Test crash after every durable/create/start/collect/destroy boundary, Docker unreachability, a foreign similarly named container, and deletion already completed externally.
- [ ] Ensure lease renewal/handoff preserves execution ID and running state. Stop/cancel reaches the guest; stale control messages remain rejected by canonical lease version. Never claim lease fencing kills arbitrary ongoing shell writes without confirmed stop.
- [ ] Commit after focused and host runtime tests pass; attach exact image/context evidence.

**Gate:** broker restart cannot duplicate a worker or destroy unrelated containers; output/result recovery and slot accounting are proved on actual OrbStack. A fake Docker runner proves only command construction.

## Task 4: Close provider and dispatch bypasses; expose truthful execution policy

**Modify:** `src/domain/permission-resolution.ts`, `src/providers/claude/permissions.ts`, `src/providers/codex.ts`, `src/providers/cursor/session-adapter.ts`, `src/providers/antigravity/session-adapter.ts`, `src/app-server/dispatch-adapter.ts`, provider job dispatch adapters, `src/orchestration/worker-capabilities.ts`, `src/client/provider-capability-view.ts`, `src/client/fleet/render-list.ts`, `src/client/dashboard.ts`, CLI/MCP request schemas.

**Create:** `docs/architecture/worker-execution.md`, `docs/setup/worker-execution-acceptance.md`.

**Test:** provider launch/resume fixtures; `tests/integration/worker-execution.test.ts`; corresponding CLI/MCP/broker routing tests.

**Consumes:** working execution backend and boundary proof.
**Produces:** a tested provider/transport matrix and one explicit execution policy across worker creation paths.

- [ ] Inventory start/delegate/worker_ctl/Fleet/Scout/resume/job/app-server entry points. Propagate executor policy end-to-end, including budgets, workspace ownership and reporting. Either implement container execution for an entry point or return an explicit unsupported-executor error; no hidden host path.
- [ ] Prove Claude first, then Codex, then Cursor and Antigravity for the permission/transport modes their CLIs actually support. Do not bypass existing model/effort safety or first-party orchestrator routing. Container image capabilities are probed inside the image rather than copied from host PATH discovery.
- [ ] Resolve provider-native permissions from executor plus the existing requested permissions. A read-only workspace remains mounted read-only. Enable automatic/broad workspace-write only under the accepted container policy; retain explicit host behaviour. Record requested/achieved limits and failure reasons.
- [ ] Verify auth, resume, tool/reporting config, initial/follow-up prompts, transcript discovery, observed model, usage provenance and stop for each supported cell. A native transcript-less provider reports partial capture. Unsupported Linux/native-Mac tasks require a host profile with an operator-visible explanation.
- [ ] Add concise executor/status/coverage to existing views and inspection APIs without changing Fleet keymaps. Errors distinguish image missing, authentication unavailable, resource queueing, capture degraded and daemon unreachable.
- [ ] Run the provider fixture suite and actual runtime canaries within authorized provider/model budget. Record unsupported cells; the final rollout must not describe them as container-supported.

**Gate:** every worker launch path honors isolation policy; no default switch until required provider cells pass or the user explicitly accepts documented host exceptions.

## Task 5: Add durable activity capture independent of Sentry

**Create:** `src/domain/agent-activity.ts`, `src/orchestration/agent-activity-port.ts`, `src/persistence/agent-activity-store.ts`, `src/runtime/activity/codex-activity.ts`, `src/runtime/activity/claude-activity.ts`, `src/runtime/activity/provider-activity-collector.ts`, `src/cli/activity.ts`.

**Modify:** `src/persistence/thread-transcript-store.ts` through a narrow reader seam; session launch/turn/instruction post-commit emitters, worker coordination/handoff/budget services, `src/broker/main.ts`.

**Test:** `tests/persistence/agent-activity-store.test.ts`, `tests/runtime/activity/provider-activity.test.ts`, `tests/orchestration/agent-activity.test.ts` with sanitized fixtures.

**Consumes:** existing durable control events, native provider files and optional execution events.
**Produces:** an unsampled local activity stream, coverage model and causal read/export API used by Tasks 6 and 7.

```ts
// src/domain/agent-activity.ts (minimal shared record; extend with validated fields)
export interface AgentActivity {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  runId: string;
  sessionId: string;
  generation: number;
  occurredAt: string;
  observedAt: string;
  kind: string; // implementation uses the spec's closed event-kind enum
  provenance: "broker" | "provider-native" | "worker-report" | "host-verified" | "terminal-fallback";
  parentEventId?: string;
  executionId?: string;
  providerEventId?: string;
  payloadRef?: string; // local only
  coverage: "complete-for-source" | "partial" | "unavailable";
}
// src/orchestration/agent-activity-port.ts
export interface AgentActivityPort {
  append(event: Omit<AgentActivity, "sequence">): Promise<AgentActivity>;
  read(runId: string, afterSequence: number, limit: number): Promise<AgentActivity[]>;
}
```

- [ ] Define validated event families and stable source deduplication keys; preserve source time versus ingestion order. Attach task/run/instruction/worker identity at actual dispatch, not by nearest timestamp or shared cwd. Segment runs across long sessions with explicit links.
- [ ] Implement append ordering, durable cursors, crash-tail recovery, byte/time retention, manifest hashes, redacted diagnostic references and visible loss counters. Persist provider cursor only after corresponding activity is durable; restart must neither lose nor double-count tool events.
- [ ] Parse documented native Claude/Codex message, tool invocation/result and usage frames with fixtures tied to source versions. Reject attribution conflicts; handle `/clear`, model switches, resume generations, file rotation/truncation, partial lines, unknown frames and missing tool results. Preserve evidence for parallel calls with call IDs.
- [ ] Emit broker operations only at acknowledged state boundaries. Activity failure never fabricates successful execution; ordinary runs surface degraded capture, while strict evals fail their evidence requirement. Keep worker completion claims separate from verified filesystem manifests.
- [ ] Add a local run/session inspection command that returns chronological actions, provenance, coverage, gaps and artifact references. Offer bounded JSON export to a caller-selected local path; do not automatically upload it.
- [ ] Keep Cursor/Antigravity coverage explicit and avoid speculative parsers. Document what is and is not reconstructable for host and container runs. No fabricated provider HTTP spans from whole-turn duration.
- [ ] Run capture/restart/retention tests and verify a captured run against the source fixture and host filesystem facts, then commit.

**Gate:** an inspector can identify which instruction caused which observed tool action and result, through resume/handoff, with missing evidence clearly visible. Final-answer-only collection does not pass.

## Task 6: Add bounded Sentry export and demonstrate causal investigation

**Create:** `src/observability/sentry-sink.ts`, `src/observability/activity-projection.ts`, `src/observability/telemetry-budget.ts`, `docs/setup/sentry-agent-observability.md`.

**Modify:** `package.json`/lockfile with pinned-compatible `@sentry/node`, `@sentry/opentelemetry` and only necessary OTel packages; `src/config.ts`; `src/broker/main.ts` outer composition.

**Test:** `tests/observability/activity-projection.test.ts`, `tests/observability/sentry-sink.test.ts`, `tests/observability/telemetry-budget.test.ts`.

**Consumes:** committed activity stream and approved metadata allowlist.
**Produces:** optional Sentry sink, known sampling/health state and one real investigation example.

- [ ] Pin mutually compatible SDK/OTel versions after checking current peer dependencies and Node 24 support. Initialize exactly one tracing provider using Sentry's supported OTel processor/propagator/context setup; validate configuration. Do not treat a DSN as a generic OTLP URL.
- [ ] Implement closed-schema projection and bounded names/attributes. Use `gen_ai.invoke_agent` for observed agent turns and `gen_ai.execute_tool` for observed calls, with provider/model/agent metadata; no input/output body attributes. Keep unattributed or unknown activity visibly incomplete.
- [ ] Test the final serialized transport envelope with synthetic secrets embedded in prompts, shell output, tool names/args, errors, URLs, paths, headers, breadcrumbs and tags. Assert all sentinel values are absent, and unknown attributes are dropped rather than stringified.
- [ ] Implement consistent head sampling, daily caps, bounded buffering, retry/backoff for transient failure, 429 handling, export-drop metrics and bounded shutdown flush. No sink credentials flow into worker environments. No exception from export changes worker authority/result state.
- [ ] Test a failing sink during launch, tool capture, handoff, successful settlement, restart and cleanup; compare broker outcomes to disabled-sink runs. Avoid automatic capture integrations until their payloads are proven safe.
- [ ] Run one named, 100%-sampled bounded canary after Sentry activation is authorized; inspect the actual remote trace against local run/worker/instruction/tool IDs. Record a real trace link, selected metadata and completeness. Set normal free-tier caps from actual account allowance and measured event volume.
- [ ] Document first queries: launch/queue/provider/settlement latency, canonicalization gap, stalls after delivery, capture fallback rate, OOM/resource failures, retries and cleanup lag. Show how an operator follows a remote trace ID to local detailed evidence.

**Gate:** real Sentry evidence matches local causality, envelopes contain no excluded data, and unavailable Sentry leaves Cyberdeck operational. Mock exporter tests alone do not close this task.

## Task 7: Add Promptfoo against isolated real broker scenarios

**Create:** `evals/package.json`, `evals/pnpm-lock.yaml`, `evals/promptfooconfig.yaml`, `evals/providers/cyberdeck.ts`, `evals/harness/scenario-runner.ts`, `evals/assertions/evidence.ts`, `evals/assertions/invariants.ts`, `evals/scenarios/`, `evals/fixtures/`, `evals/README.md`, `scripts/run-infrastructure-evals.ts`.

**Modify:** `.github/workflows/ci.yml` for offline eval checks; add `.github/workflows/infrastructure-live.yml` for manually triggered trusted live runs. Keep root runtime publication free of evaluation dependencies/data.

**Test:** `tests/evals/evidence.test.ts`, `tests/evals/invariants.test.ts`, fixture-backed integration tests with the real isolated broker.

**Consumes:** Task 4 isolation and Task 5 evidence. Sentry is not required to run assertions.
**Produces:** deterministic assertions, live behavioural reports and historical regression cases.

```ts
// evals/assertions/evidence.ts
export interface ScenarioEvidence {
  schemaVersion: 1;
  runId: string;
  status: "completed" | "failed" | "timed-out";
  captureComplete: boolean;
  expectedChangedPaths: string[];
  actualChangedPaths: string[];
  unrelatedPathsChanged: string[];
  unauthorizedMutationCount: number;
  missingInstructionIds: string[];
  harnessErrors: string[];
}
// evals/assertions/invariants.ts
export function hardFailures(e: ScenarioEvidence): string[] {
  return [
    ...(e.status === "completed" ? [] : ["scenario-not-completed"]),
    ...(e.captureComplete ? [] : ["required-evidence-missing"]),
    ...(e.unrelatedPathsChanged.length ? ["unrelated-work-modified"] : []),
    ...(e.unauthorizedMutationCount ? ["unauthorized-mutation"] : []),
    ...(e.missingInstructionIds.length ? ["instruction-lost"] : []),
    ...e.harnessErrors,
  ];
}
```

Extend this validated evidence envelope with exact command coverage, worker reports, timestamps, budgets and artifact manifests for relevant scenarios. `expectedChangedPaths` comes from fixture intent; compare the worker's separately captured reported paths to host-verified `actualChangedPaths`. Never populate ground truth from worker prose.

- [ ] Pin Promptfoo in the separate package and use its `ApiProvider.callApi` custom-provider interface. The provider invokes `runScenario` in `scenario-runner.ts`, returning JSON evidence as `output`, error status where appropriate, and only actually observed token usage. Validate scenario IDs/config, not arbitrary shell snippets from model output.
- [ ] Start a test broker with distinct state/socket/broker ID and no Fleet/nvim integration. Seed a disposable repo from committed fixtures. Resolve container images/models/toolchains explicitly, apply wall-clock/concurrency/known-token budgets, collect evidence and terminate owned resources in `finally` and crash recovery.
- [ ] Build truthful-completion/scope fixtures with unrelated tracked and untracked changes. Hash baseline/final files and Git state. Assert scope, expected changes and truthful reported changes independently; test the grader with lying and incomplete results before using a model.
- [ ] Encode phantom-turn regression by controlling a scripted provider's delayed final frame while a second instruction enters the actual broker queue. Assert each instruction has distinct correct delivery/settlement and neither is swallowed. Add a live conversational counterpart; distinguish scheduling proof from stochastic provider behaviour.
- [ ] Encode stale controller/handoff and malicious repository/tool-output scenarios. Assert canonical state/evidence, refusal of unauthorized broker mutations, explicit recovery, and no cross-worker filesystem access. Keep existing lease tests; Promptfoo must also exercise agent decisions around those refusals.
- [ ] Encode OOM/timeout and Sentry-outage scenarios; assert real process stop, slot release, retained evidence and truthful failure outcome. Deliberately fail each assertion once to prove the suite can detect the regression.
- [ ] Run offline cases in ordinary CI without network, model keys, Sentry, or Docker; these use a scripted provider and prove the harness. Run live cases manually on a dedicated trusted OrbStack host with explicit spend cap, cache disabled, scenario/model/image/commit provenance and 3 bounded repetitions per scenario.
- [ ] Fail CI/reporting on critical violations, missing required coverage or harness errors. Configure Promptfoo's failure exit behaviour and a result-schema validator; do not accept an empty or skipped suite as green. Never share reports automatically or expose credentials to untrusted PR workflows.
- [ ] Add an incident-to-regression procedure: select local evidence by run/event ID, sanitize/minimize a fixture, record source provenance, reproduce failure, fix, and retain the case. Include phantom-turn and dirty-tree regressions in the initial delivered corpus.

**Concrete grader test:**

```ts
expect(hardFailures({
  schemaVersion: 1, runId: "fixture-run", status: "completed",
  captureComplete: false,
  expectedChangedPaths: ["src/answer.ts"], actualChangedPaths: ["src/answer.ts"],
  unrelatedPathsChanged: [], unauthorizedMutationCount: 0,
  missingInstructionIds: [], harnessErrors: [],
})).toContain("required-evidence-missing");
```

**Gate:** Promptfoo launches at least one real container-backed agent scenario through a test broker and catches a behavioural violation beyond process success. Both historical regressions have reproducible evidence. Offline fixture passes alone do not close the live objective.

## Task 8: Verify the complete objective and roll out worker isolation

**Create:** `docs/setup/worker-infrastructure-acceptance.md` with exact head/image/version and proof links.
**Modify:** operator configuration only when rollout is requested; default profile code/docs only after preceding gates.

**Consumes:** Tasks 4, 6, 7 acceptance reports.
**Produces:** a usable default execution policy, operational runbook and explicit residual exceptions.

- [ ] Run `rtk pnpm check`, `rtk pnpm test`, `rtk pnpm build`, existing architecture tests, and packed CLI installation checks in an appropriate host environment. Run `rtk git diff --check`. Do not upgrade a sandbox-blocked socket/tmux run to a pass.
- [ ] Re-run the end-to-end journey on the exact candidate commit: two workers with independent changes → tool activity → handoff → broker restart/recovery → result inspection → Sentry trace → Promptfoo assertions → cleanup. Verify private host clone and evidence remain available after container retirement.
- [ ] Verify no mutations to the operator checkout, unrelated worktrees, provider accounts, global Docker context or foreign containers. Verify host-native iOS/macOS profile explicitly, without claiming it is container-isolated.
- [ ] Publish a support matrix for every launch path/provider/transport, noting native tool-capture coverage. If an intended everyday worker still needs host execution, report it as an explicit exception and obtain acceptance before calling default isolation complete.
- [ ] Configure new ordinary workers to require the proven OrbStack profile; preserve active sessions and persisted host records. Rollback stops new sandbox admission and uses an explicit host profile for newly requested work; it does not migrate or kill existing workers automatically.
- [ ] Provide daily operating commands for executor health, queued slots, retained failures, activity coverage, Sentry export budget and running evals. Document evidence-preserving cleanup and known limits, including domain egress filtering and unobservable provider actions.
- [ ] Close the objective only with actual host/container evidence, actual remote Sentry trace evidence, actual live Promptfoo behaviour evidence, and the accepted provider exception matrix. PR merge and external issue comments require the user's corresponding authorization.

## Verification/reporting template

Each delivery checkpoint records:

```text
Commit / branch / workspace:
Files and contract changed:
Unit/static evidence:
Host runtime evidence:
Container context + image digest + provider version:
Sentry trace / export proof (if relevant):
Promptfoo run / scenario / model / budget (if relevant):
Unverified or unsupported behaviour:
Preserved resources / cleanup failures:
Next task and exact gate:
```

Do not repeat the complete suite without a new change or unresolved concern. Run targeted tests during each task, then the required complete gates at integration.

## Execution recommendation

Use a **fresh GPT-6 Astra Orc session** for implementation. The scope crosses lifecycle, authority, provider packaging, telemetry and evaluation; a fresh context with this design and durable checkpoints gives it a clear implementation mandate. Keep this session for reviewing the proposed design. The companion [Orc handoff prompt](2026-09-05-worker-infrastructure-orc-prompt.md) carries the precise scope, baseline, constraints and completion criteria.

Start with Task 0 and the first executor PR. Continue through the linked tracks, with evidence at each checkpoint. A backend, credential, Sentry or model-budget blocker should stop only dependent runtime gates, while independent source work continues. Never report source-only infrastructure as operationally complete.
