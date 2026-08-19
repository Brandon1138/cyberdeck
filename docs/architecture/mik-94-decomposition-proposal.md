# MIK-94 decomposition proposal

Status: Wave 1 decomposition map. This is a source-grounded proposal, not authorization to move
code or change behavior.

Scope inspected: every TypeScript module under `src/` and every document under
`docs/architecture/`, on 2026-08-19. Citations are current checkout `file:line` locations. The
dependency map records static imports/exports; runtime-only construction is called out separately.

## Executive finding

Cyberdeck already has strong domain contracts, but physical boundaries do not match its stated
dependency rule. Most use cases live in `src/orchestration/`, yet they import the broker runtime,
concrete JSONL stores, and a client policy module. Several application services live in
`src/broker/`. `SessionRegistry` is the largest knot: one 3,408-line class owns session lifecycle,
provider selection, provider launch preparation, PTY/pipe control, replay interpretation,
instruction truth, Scout verification, transcript capture, persistence, worktree provisioning, and
filesystem validation (`src/broker/session-registry.ts:1-83`,
`src/broker/session-registry.ts:185-225`, `src/broker/session-registry.ts:413-435`).

Current package graph contains bidirectional edges between:

- `broker` and `orchestration` (`src/broker/main.ts:34-44`; `src/orchestration/agent-control-service.ts:30`);
- `broker` and `persistence` (`src/broker/main.ts:25-33`; `src/persistence/migrations/0001-worker-coordination.ts:1`);
- `broker` and `runtime` (`src/broker/main.ts:18-19`; `src/runtime/pipe-process.ts:4`);
- `client` and `orchestration` (`src/client/fleet.ts:22-29`; `src/orchestration/agent-control-service.ts:35`);
- `client` and `persistence` (`src/client/fleet.ts:31-35`; `src/persistence/provider-permission-preference-store.ts:5-8`);
- `control-plane` and `persistence` (`src/control-plane/runtime.ts:5-7`; `src/persistence/job-store.ts:5-9`);
- `orchestration` and `persistence` (`src/orchestration/instruction-queue.ts:7-8`; `src/persistence/scout-report-store.ts:21-24`);
- `providers` and `persistence` (`src/providers/session-launch-files.ts:4`; `src/persistence/scout-egress-grant-store.ts:5`);
- `providers` and `runtime` (`src/providers/cursor/run-everything.ts:3`; `src/runtime/pty-process.ts:3`).

MIK-94 should break these cycles by adding owned inward ports and moving composition outward. It
should not rewrite state machines, rename public methods, alter provider argv, reinterpret identity,
or migrate durable formats unless separately approved.

## Target dependency rule

```text
CLI / Fleet TUI / MCP / broker socket / nvim delivery
                         |
                         v
              controllers and presenters
                         |
                         v
              application use cases + ports
                         |
                         v
                       domain

PTY, child processes, tmux, provider CLIs, Git, filesystem, JSONL stores
                         |
                         v
             implement inward-owned application ports

composition root may import every layer solely to construct the graph
```

Ports belong with the use case that needs them. Infrastructure imports those ports; application
code never imports infrastructure to discover an interface. Domain remains pure policy and state.
Delivery converts wire/UI input into controller input and renders controller output. Only the
composition root knows concrete implementations.

## Current dependency map

“Imports” lists local top-level units plus material platform dependencies. “Imported by” is the
reverse static edge. Same-directory imports are omitted.

| Current unit | Imports | Imported by |
| --- | --- | --- |
| `domain/` | `limits.ts`, `zod`, `node:path`, `node:crypto` (`src/domain/policy.ts:2`, `src/domain/worker-workspace.ts:1-2`, `src/domain/orchestrator.ts:1-2`) | `app-server`, `broker`, `cli.ts`, `client`, `config.ts`, `control-plane`, `mcp`, `nvim`, `orchestration`, `persistence`, `protocol`, `providers`, `runtime` (representative edges: `src/app-server/dispatch-adapter.ts:3-16`, `src/broker/session-registry.ts:5-17`, `src/providers/claude.ts:1-7`, `src/protocol/frames.ts:2`) |
| `orchestration/` | `domain`, `broker`, `persistence`, `client`, `limits.ts`, `zod`, `node:child_process`, `node:fs/promises`, `node:path`, `node:util`, `node:crypto` (`src/orchestration/agent-control-service.ts:1-68`, `src/orchestration/git-worktree-provisioner.ts:1-11`) | `broker`, `cli.ts`, `client`, `mcp`, `persistence` (`src/broker/main.ts:34-44`, `src/cli.ts:20-29`, `src/client/fleet.ts:22-29`, `src/mcp/server.ts:12`, `src/persistence/scout-report-store.ts:21-24`) |
| `broker/` | `app-server`, `config.ts`, `control-plane`, `domain`, `limits.ts`, `nvim`, `orchestration`, `paths.ts`, `persistence`, `protocol`, `providers`, `runtime`, `runtime-config.ts`, plus socket/filesystem/crypto/path Node APIs and `zod` (`src/broker/main.ts:1-52`, `src/broker/server.ts:1-85`) | `cli.ts`, `client`, `orchestration`, `persistence`, `runtime` (`src/cli.ts:8-12`, `src/client/fleet.ts:12-19`, `src/orchestration/agent-control-service.ts:30`, `src/persistence/migrations/0001-worker-coordination.ts:1`, `src/runtime/pipe-process.ts:4`) |
| `runtime/` | `domain`, `providers`, `broker`; `node-pty`, child processes, filesystem, streams, path, crypto (`src/runtime/pty-process.ts:1-3`, `src/runtime/pipe-process.ts:1-4`, `src/runtime/shell-command.ts:1-4`) | `broker`, `cli.ts`, `client`, `persistence`, `providers` (`src/broker/session-registry.ts:32-52`, `src/cli.ts:65`, `src/client/fleet.ts:42-44`, `src/persistence/thread-transcript-store.ts:14-21`, `src/providers/cursor/run-everything.ts:3`) |
| `providers/` | `domain`, `paths.ts`, `persistence`, `runtime`; child processes, filesystem, OS/path/util/crypto, `zod` (`src/providers/cursor/dispatch-adapter.ts:1-20`, `src/providers/cursor/mcp-isolation.ts:1-9`, `src/providers/codex.ts:1-9`) | `app-server`, `broker`, `cli.ts`, `client`, `persistence`, `runtime` (`src/app-server/dispatch-adapter.ts:17-18`, `src/broker/main.ts:11-17`, `src/client/fleet.ts:36-41`, `src/persistence/scout-egress-grant-store.ts:5`, `src/runtime/pty-process.ts:3`) |
| `persistence/` | `domain`, `broker`, `client`, `control-plane`, `orchestration`, `providers`, `runtime`; filesystem/path/crypto/readline/OS and `zod` (`src/persistence/job-store.ts:1-13`, `src/persistence/provider-permission-preference-store.ts:1-10`, `src/persistence/scout-report-store.ts:1-25`) | `app-server`, `broker`, `cli.ts`, `client`, `control-plane`, `orchestration`, `providers` (`src/app-server/dispatch-adapter.ts:21`, `src/broker/main.ts:25-33`, `src/control-plane/runtime.ts:5-7`, `src/orchestration/instruction-queue.ts:7-8`, `src/providers/session-launch-files.ts:4`) |
| `tmux/` | Child processes, filesystem, OS/path/crypto (`src/tmux/cockpit.ts:1-3`, `src/tmux/interactive-shell.ts:1-4`) | `cli.ts`, `nvim` (`src/cli.ts:44-51`, `src/cli.ts:64`, `src/nvim/pane.ts:2`) |
| `mcp/` | `domain`, `orchestration`, `limits.ts`, `version.ts`, readline/streams (`src/mcp/server.ts:1-13`) | `cli.ts` (`src/cli.ts:63`) |
| `app-server/` | `domain`, `control-plane`, `persistence`, `providers`, `version.ts`, child process/path (`src/app-server/dispatch-adapter.ts:1-27`) | `broker` (`src/broker/main.ts:7`) |
| `client/` | `broker`, `control-plane`, `domain`, `orchestration`, `paths.ts`, `persistence`, `protocol`, `providers`, `runtime`; socket/process/filesystem/path/OS/crypto and `zod` (`src/client/fleet.ts:1-44`, `src/client/rpc-client.ts:1-7`) | `cli.ts`, `orchestration`, `persistence` (`src/cli.ts:40-43`, `src/orchestration/agent-control-service.ts:35`, `src/persistence/provider-permission-preference-store.ts:5-8`) |
| `control-plane/` | `config.ts`, `domain`, `persistence`, crypto/filesystem/path and `zod` (`src/control-plane/runtime.ts:1-17`, `src/control-plane/worktree-lease-manager.ts:1-6`) | `app-server`, `broker`, `client`, `persistence` (`src/app-server/dispatch-adapter.ts:20`, `src/broker/main.ts:4-5`, `src/client/dashboard.ts:1-4`, `src/persistence/job-store.ts:5-9`) |
| `protocol/` | `domain`, `zod` (`src/protocol/frames.ts:1-2`, `src/protocol/jsonl.ts:1-2`) | `broker`, `client` (`src/broker/server.ts:27-28`, `src/client/attach.ts:1`, `src/client/rpc-client.ts:2-7`) |
| `nvim/` | `domain`, `tmux`, child process/filesystem/path/util (`src/nvim/open-worktree.ts:1-8`, `src/nvim/window-layout.ts:1-2`) | `broker`, `cli.ts` (`src/broker/nvim-binding-service.ts:3-6`, `src/cli.ts:52-61`) |
| `cli.ts` | `broker`, `client`, `domain`, `mcp`, `nvim`, `orchestration`, `paths.ts`, `persistence`, `providers`, `runtime`, `tmux`, `version.ts`; filesystem/process/path/url and Commander (`src/cli.ts:3-76`) | No `src/` importer; executable entry point. |
| `config.ts` | `domain`, `limits.ts`, `zod` (`src/config.ts:1-8`) | `broker`, `control-plane`, `runtime-config.ts` (`src/broker/session-registry.ts:3`, `src/control-plane/runtime.ts:1`, `src/runtime-config.ts:2`) |
| `limits.ts` | No imports. | `broker`, `config.ts`, `domain`, `mcp`, `orchestration` (`src/broker/session-registry.ts:4`, `src/config.ts:4`, `src/domain/policy.ts:2`, `src/mcp/server.ts:2-9`, `src/orchestration/agent-control-service.ts:3-11`) |
| `paths.ts` | OS/path (`src/paths.ts:1-2`) | `broker`, `cli.ts`, `client`, `providers`, `runtime-config.ts` (`src/broker/main.ts:10`, `src/cli.ts:39`, `src/client/fleet.ts:30`, `src/providers/claude/mcp-allowlist.ts:6`, `src/runtime-config.ts:3`) |
| `runtime-config.ts` | `config.ts`, `paths.ts`, filesystem (`src/runtime-config.ts:1-3`) | `broker` (`src/broker/main.ts:45`) |
| `version.ts` | Filesystem (`src/version.ts:1`) | `app-server`, `cli.ts`, `mcp` (`src/app-server/dispatch-adapter.ts:19`, `src/cli.ts:62`, `src/mcp/server.ts:13`) |

### What the graph says

1. Directory names are not reliable layers. `broker/` contains delivery, application services,
   infrastructure, and the composition root. `runtime/` contains both pure terminal interpretation
   and process owners. `control-plane/` contains use cases and concrete store construction.
2. Many imports are type-only, but type-only edges still make inner policy name concrete outer
   modules. Moving only runtime construction will not enforce the dependency rule.
3. Ports often exist, but in the wrong ownership location. `JobStateRepository` is correctly narrow
   but declared in the application implementation file (`src/control-plane/job-control-plane.ts:99-109`),
   while `ProviderAdapter` is declared under the concrete provider package and exposes executable,
   argv, `NodeJS.ProcessEnv`, and terminal buffers (`src/providers/provider.ts:4-19`,
   `src/providers/provider.ts:21-60`).
4. `src/broker/main.ts` already behaves like a composition root: it imports every provider adapter,
   both runtime implementations, stores, use cases, and delivery services (`src/broker/main.ts:4-52`).
   Preserve that role, but make it the explicit, narrow exception to layer lint.

## Inward-violation hotspots

### Ranked by blast radius

| Rank | Hotspot | Direct violation | Blast radius |
| --- | --- | --- | --- |
| 1 | `SessionRegistry` | Imports filesystem, provider adapter/CLI-shaped contracts, concrete transcript/Scout stores, provider workspace hashing, and runtime terminal interpreters (`src/broker/session-registry.ts:1-83`). Runtime record stores PTY plus application truth in one object (`src/broker/session-registry.ts:185-225`); options mix adapters, PTY factory, stores, filesystem validation, Scout storage, and worktree provisioning (`src/broker/session-registry.ts:413-435`). | 3,408 lines; source of session identity, process lifecycle, attachment, worker truth, instruction truth, replay, resume, Scout results, and persistence. Nearly every delivery/use-case surface reaches it. Any semantic split can change operator-visible truth. |
| 2 | Orchestration service cluster | `AgentControlService`, `InstructionQueue`, `OrchestratorManager`, `WorkerControlService`, `WorkerHandoffService`, and `WorkflowService` import concrete broker and persistence modules; two also import client permission policy (`src/orchestration/agent-control-service.ts:30-35`, `src/orchestration/instruction-queue.ts:6-8`, `src/orchestration/orchestrator-manager.ts:23-29`, `src/orchestration/worker-control-service.ts:19-27`, `src/orchestration/worker-handoff-service.ts:3-17`, `src/orchestration/workflow-service.ts:11-14`). | Central MCP/Fleet worker start, wait, stop, lease, handoff, workflow, instruction, and orchestrator behavior. Combined classes exceed 3,700 lines. |
| 3 | Worker ownership/event substrate in `broker/` | `WorkerCoordinationService` imports concrete `WorkerCoordinationStore` (`src/broker/worker-coordination.ts:34-37`, `src/broker/worker-coordination.ts:62-73`). Application control services then import that broker class (`src/orchestration/worker-control-service.ts:21`, `src/orchestration/worker-handoff-service.ts:3`). Migration imports it back from persistence (`src/persistence/migrations/0001-worker-coordination.ts:1`, `src/persistence/migrations/0001-worker-coordination.ts:20-27`). | 2,144-line ownership source of truth plus lease tokens, audit, events, checkpoints, handoffs, idempotency, and migration. Identity or transaction drift can strand or steal workers. |
| 4 | Git/worktree logic under `orchestration/` and `broker/` | `GitWorkspaceProbe`, `GitWorktreeProvisioner`, and `GitWorktreeInventory` run Git and access filesystem directly (`src/orchestration/git-workspace-probe.ts:1-6`, `src/orchestration/git-worktree-provisioner.ts:1-13`, `src/orchestration/worktree-inventory.ts:1-7`). `FleetProjectService` defaults its application service to a Git implementation and concrete store (`src/broker/fleet-project-service.ts:1-3`, `src/broker/fleet-project-service.ts:34-54`). | Worker admission, branch/base validation, creation rollback, provenance, pruning, and Fleet grouping. Worktree removal is consequential even though current commands refuse force. |
| 5 | Control-plane lease/composition | `WorktreeLeaseManager` directly imports `realpath` and concrete `LeaseStore` types (`src/control-plane/worktree-lease-manager.ts:1-6`, `src/control-plane/worktree-lease-manager.ts:28-39`, `src/control-plane/worktree-lease-manager.ts:58-72`). `ControlPlaneRuntime` constructs `JobStore`, `ArtifactStore`, and `LeaseStore` inside the application package (`src/control-plane/runtime.ts:5-17`, `src/control-plane/runtime.ts:72-117`). | Job admission/recovery, canonical lease identity, fencing, artifact availability, and startup ordering. Wrong split can alter exclusivity or recovery semantics. |
| 6 | Provider capability discovery | `WorkerCapabilityCatalog` contains application caching/fallback policy and direct `execFile` provider queries in one module (`src/orchestration/worker-capability-catalog.ts:1`, `src/orchestration/worker-capability-catalog.ts:16-27`, `src/orchestration/worker-capability-catalog.ts:53-60`, `src/orchestration/worker-capability-catalog.ts:85-117`, `src/orchestration/worker-capability-catalog.ts:168-240`). | Fleet model picker, provider-capabilities API, and worker launch validation all use this answer. Lower code volume, broad public visibility. |
| 7 | nvim/project application services | `NvimBindingService` imports concrete nvim bridge and Git-change functions despite already exposing injectable options (`src/broker/nvim-binding-service.ts:3-6`, `src/broker/nvim-binding-service.ts:30-43`). | Worker file locks and final refresh. Lower fleet-wide blast radius, but incorrect lifecycle handling can expose concurrent writes. |
| 8 | Persistence files containing policy | `ThreadTranscriptStore` combines filesystem storage with provider transcript attribution/read models (`src/persistence/thread-transcript-store.ts:1-22`). `ScoutReportStore` combines filesystem artifacts with decision-card parsing and terminal/report framing (`src/persistence/scout-report-store.ts:1-25`). | Transcript truth, Claude binding conflicts, Scout completion evidence, and recovery. These are outer modules with inward dependencies, but policy cannot be reused or tested without the filesystem implementation. |

### Direct-violation inventory

This inventory is exhaustive for direct imports from domain/application-like code into PTY/process,
tmux, provider CLI, filesystem, or persistence implementations.

#### `src/domain/**`

No domain module imports `node:fs`, `node:child_process`, `node-pty`, `tmux`, `providers`, or
`persistence`. Seven modules do import `node:path`: `artifact.ts`, `job.ts`, `lease.ts`,
`session.ts`, `worker-coordination.ts`, `worker-profile.ts`, and `worker-workspace.ts`
(`src/domain/artifact.ts:1`, `src/domain/job.ts:1`, `src/domain/lease.ts:1`,
`src/domain/session.ts:1`, `src/domain/worker-coordination.ts:1`,
`src/domain/worker-profile.ts:1`, `src/domain/worker-workspace.ts:1`). This is path-shape policy, not
filesystem I/O, but a strict platform-free core rule must decide whether it remains allowed.
`orchestrator.ts` also uses Node crypto for deterministic controller identity
(`src/domain/orchestrator.ts:1`), and `policy.ts` imports an outer root constant
(`src/domain/policy.ts:2`). These are secondary purity decisions, not current process/filesystem
implementation access.

#### `src/orchestration/**`

- Direct process/provider CLI: `worker-capability-catalog.ts` (`node:child_process` and exact
  `agent models` / `agy models` commands at `src/orchestration/worker-capability-catalog.ts:1`,
  `src/orchestration/worker-capability-catalog.ts:53-60`); `git-workspace-probe.ts`,
  `git-worktree-provisioner.ts`, and
  `worktree-inventory.ts` (`src/orchestration/git-workspace-probe.ts:1-3`,
  `src/orchestration/git-worktree-provisioner.ts:1-4`,
  `src/orchestration/worktree-inventory.ts:1-4`).
- Direct filesystem: `git-worktree-provisioner.ts` and `worktree-inventory.ts` at the imports above.
- Direct persistence implementations: `src/orchestration/agent-control-service.ts:31-34`,
  `src/orchestration/instruction-queue.ts:7-8`,
  `src/orchestration/orchestrator-manager.ts:23-25`,
  `src/orchestration/worker-control-service.ts:26`,
  `src/orchestration/worker-handoff-service.ts:16`, and
  `src/orchestration/workflow-service.ts:12-13`.
- Direct broker implementations: `src/orchestration/agent-control-service.ts:30`,
  `src/orchestration/instruction-queue.ts:6`,
  `src/orchestration/orchestrator-manager.ts:26`,
  `src/orchestration/scout-wave-digest.ts:6`,
  `src/orchestration/worker-control-service.ts:19-25`,
  `src/orchestration/worker-handoff-service.ts:3-6`,
  `src/orchestration/worker-intervention-wait.ts:1`, and
  `src/orchestration/workflow-service.ts:11`.
- Direct delivery/client policy: `src/orchestration/agent-control-service.ts:35` and
  `src/orchestration/orchestrator-manager.ts:27`.
- No orchestration module directly imports `node-pty` or `tmux`.

Five use-case modules also call Node `randomUUID` directly:
`src/orchestration/agent-control-service.ts:1`, `src/orchestration/instruction-queue.ts:1`,
`src/orchestration/worker-control-service.ts:1`,
`src/orchestration/worker-handoff-service.ts:1`, and
`src/orchestration/workflow-service.ts:1`. Clock/ID injection already exists in parts of the codebase; standardizing it
would improve deterministic application tests, but adds DI machinery and needs operator approval.

#### Equivalent application logic outside `domain/` and `orchestration/`

- `broker/session-registry.ts`: filesystem, provider adapters, stores, runtime, Git/Scout adapter
  as detailed above.
- `broker/worker-coordination.ts`: concrete worker-coordination store
  (`src/broker/worker-coordination.ts:34-37`, `src/broker/worker-coordination.ts:62-73`).
- `broker/fleet-project-service.ts`: concrete Git and preference store
  (`src/broker/fleet-project-service.ts:1-3`, `src/broker/fleet-project-service.ts:34-54`).
- `broker/nvim-binding-service.ts`: concrete nvim/Git output functions
  (`src/broker/nvim-binding-service.ts:3-6`).
- `broker/worker-event-channel.ts`: concrete persistence/controller types and default broker token
  custodian (`src/broker/worker-event-channel.ts:15-26`,
  `src/broker/worker-event-channel.ts:61-87`).
- `control-plane/worktree-lease-manager.ts`: filesystem canonicalization and concrete lease store
  (`src/control-plane/worktree-lease-manager.ts:1-6`,
  `src/control-plane/worktree-lease-manager.ts:58-72`).
- `control-plane/runtime.ts`: concrete persistence construction; reclassify as composition
  infrastructure instead of pretending it is an application module
  (`src/control-plane/runtime.ts:5-17`, `src/control-plane/runtime.ts:72-117`).
- `persistence/thread-transcript-store.ts` and `persistence/scout-report-store.ts` are inverse
  straddlers: application-level attribution/promotion policy lives inside filesystem implementations
  (`src/persistence/thread-transcript-store.ts:1-22`,
  `src/persistence/scout-report-store.ts:1-25`). Split policy inward before moving either store.

`broker/server.ts`, `cli.ts`, `mcp/server.ts`, `client/**`, `nvim/**`, `tmux/**`, provider adapters,
runtime processes, and persistence stores also import platform implementations, but those modules
are delivery/interface/infrastructure. Their problem is layer mixing or reverse imports, not an
inner layer directly reaching outward.

## Proposed layer assignment

Assignments cover every `src/` module. “Split” means current file holds more than one target layer;
the first PR should establish a seam before any physical move.

### Domain

| Modules | Assignment | Split note |
| --- | --- | --- |
| `domain/artifact.ts`, `budget.ts`, `capability.ts`, `control-plane.ts`, `delegation.ts`, `dispatch.ts`, `events.ts`, `instruction.ts`, `job.ts`, `lease.ts`, `permission-resolution.ts`, `policy.ts`, `provider-registration.ts`, `scout-output.ts`, `session.ts`, `thread-retention.ts`, `thread.ts`, `usage.ts`, `worker-coordination.ts`, `worker-handoff.ts`, `worker-profile.ts`, `worker-truth.ts`, `workflow.ts` | Domain entities, schemas, value objects, state machines, and pure policies. | Keep behavior. Move `DEFAULT_MAX_CONCURRENT_WORKERS` inward or inject it so `policy.ts` stops importing root `limits.ts`. Decide whether pure `node:path` validation is allowed. |
| `domain/orchestrator.ts` | Domain identity and grants. | Split Node hash implementation only if platform-free domain is required; controller identity algorithm and output must not change. |
| `domain/worker-workspace.ts` | Domain workspace value objects and validation plus application ports. | Split `WorkspaceProbe`/`WorktreeProvisioner` port declarations into application ports; retain pure invariants in domain. Do not move Git commands inward. |

### Application

| Current modules | Assignment | Split/move note |
| --- | --- | --- |
| `orchestration/agent-control-service.ts`, `instruction-queue.ts`, `orchestrator-manager.ts`, `scout-wave-digest.ts`, `worker-control-service.ts`, `worker-handoff-service.ts`, `worker-intervention-wait.ts`, `worker-profiles.ts`, `workflow-service.ts` | Application use cases. | Replace broker/store/client imports with inward-owned ports. Keep schemas near controllers or move request parsing to interface adapters later. |
| `orchestration/orchestrator-catalog.ts`, `worker-capabilities.ts` | Application policy/catalog. | No provider process access. Capability data remains neutral and source-attributed. |
| `orchestration/worker-capability-catalog.ts` | Split: application cache/fallback policy plus infrastructure provider-CLI probe. | Keep `ProviderModelProbe` inward; move `execFile`, executable table, and command runner outward. |
| `orchestration/git-workspace-probe.ts`, `git-worktree-provisioner.ts` | Infrastructure Git/filesystem adapters. | Move outward; they implement existing workspace ports. Preserve exact argv, refusal, rollback, and provenance behavior. |
| `orchestration/worktree-inventory.ts` | Split: application retention policy/use case plus infrastructure Git/filesystem inventory. | Keep `retentionVerdict`, `liveWorktreeCwds`, and data contracts inward; move reading/removal outward. |
| `broker/worker-coordination.ts` | Application ownership/event use case. | Move behind `WorkerCoordinationRepository`; concrete JSONL store stays infrastructure. Preserve atomic transaction boundary. |
| `broker/worker-event-channel.ts` | Interface controller over worker-event application use case. | Keep enrichment/validation controller; depend on session/controller/checkpoint ports and credential port, not concrete broker/store classes. |
| `broker/worker-lease-credential-custodian.ts` | Application port plus in-memory infrastructure implementation. | Split interface from `BrokerWorkerLeaseCredentialCustodian`; preserve restart-loses-token semantics. |
| `broker/fleet-project-service.ts` | Application project-registry use case. | Inject `ProjectRepositoryProbe` and `FleetProjectRepository`; no nvim Git helper or concrete store import. |
| `broker/nvim-binding-service.ts` | Application binding/lifecycle use case. | Existing `changes`/`notify` options are nearly ports; remove concrete default imports and construct defaults in composition. |
| `broker/session-registry.ts` | Split: application session lifecycle/worker-truth use cases plus runtime/interface adapters. | Do not move whole file. First expose `SessionCatalog`, `SessionCommands`, `SessionRuntime`, transcript, Scout, journal, and workspace ports; then extract state-machine sections one at a time. |
| `control-plane/admission-scheduler.ts`, `budget-ledger.ts`, `job-control-plane.ts`, `reconciler.ts` | Application use cases and ports. | Move `JobStateRepository`, runtime/artifact/lease inspector contracts to stable application port modules. Keep recovery/order semantics. |
| `control-plane/provider-registry.ts` | Application in-memory adapter for domain provider registry port. | Can remain near use case; composition owns default registrations. |
| `control-plane/worktree-lease-manager.ts` | Split: application lease/fencing use case plus filesystem/persistence adapters. | Inject lease repository and canonical-path port; remove `realpath` and concrete `LeaseStore` import. |
| `config.ts` | Application runtime-configuration contract. | Keep neutral declarations inward; filesystem loading remains in `runtime-config.ts`. |
| `limits.ts` | Split application/delivery constants. | Move domain concurrency default beside domain policy; keep pagination/wait/output limits with owning use cases or delivery adapters. |

### Interface adapters and protocol

| Current modules | Assignment | Split/move note |
| --- | --- | --- |
| `protocol/frames.ts`, `protocol/jsonl.ts` | Interface-adapter wire schemas and framing. | Broker/client may depend on them; application/domain must not. Domain event import into protocol is inward and valid. |
| `broker/server.ts` | Split: socket delivery plus RPC controllers. | Keep socket ownership, frame parsing, and method routing outward. Controllers call application ports. Do not rename methods or error codes. |
| `app-server/protocol.ts` | Infrastructure-facing protocol codec/interface adapter. | Remains beside Codex App Server infrastructure, not application core. |
| `runtime/composer-state.ts`, `conversation-preview.ts`, `observed-model.ts`, `replay-digest.ts`, `session-liveness.ts`, `terminal-replay.ts` | Provider-terminal interface adapters/pure interpreters. | Separate pure incremental state from process modules. Application consumes neutral observations, not terminal buffers or provider glyphs. |
| `providers/launch-record.ts` | Interface adapter from provider launch spec to durable neutral record. | Keep mapping outward. |
| `nvim/quickfix.ts` | Interface adapter/presenter for nvim payload. | Depend on neutral change-set DTOs, not Git implementation. |
| `client/permission-policy.ts` | Application permission preference policy currently misplaced in delivery. | Move schema/resolution inward; leave labels/rendering in client. This also removes persistence-to-client reverse import. |
| `client/provider-capability-view.ts`, `lease-custody.ts`, `owner-sigil.ts` | Delivery presenters. | Consume controller view models only. |

### Infrastructure

| Current modules | Assignment | Split/move note |
| --- | --- | --- |
| `persistence/artifact-store.ts`, `claude-conversation-bindings.ts`, `fleet-detach-store.ts`, `fleet-preference-store.ts`, `instruction-store.ts`, `job-store.ts`, `lease-store.ts`, `orchestrator-store.ts`, `private-files.ts`, `provider-permission-preference-store.ts`, `scout-egress-grant-store.ts`, `session-store.ts`, `worker-coordination-store.ts`, `worker-preference-store.ts`, `workflow-store.ts` | Filesystem/JSONL infrastructure implementing inward repositories. | Durable paths, schemas, fsync, corruption behavior, and replay order remain unchanged. Replace imports from client/broker with application/domain contracts. |
| `persistence/thread-transcript-store.ts` | Split: filesystem store plus provider transcript readers/attribution adapter. | Preserve Claude binding conflict, `/clear`, cursor, and retention semantics. Expose neutral transcript repository inward. |
| `persistence/scout-report-store.ts` | Split: filesystem artifact store plus Scout card/trace promotion policy. | Keep parsing/promotion policy inward or in provider interface adapter; store only bytes/metadata outward. |
| `persistence/migrations/0001-worker-coordination.ts` | Infrastructure migration runner against application coordination port. | Remove import of broker implementation; preserve stable-controller resolution and idempotency. |
| `broker/journal.ts` | Filesystem event-journal infrastructure. | Implement inward event journal port; composition supplies it. |
| `runtime/pty-process.ts`, `pipe-process.ts`, `shell-command.ts` | PTY/process/filesystem infrastructure. | Implement `SessionRuntime`/command ports. `pipe-process.ts` must stop importing `PtyHandle` from broker. SessionRuntime sibling slice is already doing this seam. |
| `app-server/dispatch-adapter.ts` | Codex App Server process/protocol infrastructure implementing `JobDispatchAdapter`. | Replace concrete lease/artifact types with inward ports when those seams exist. Keep argv/protocol/safety behavior. |
| `providers/claude.ts`, `codex.ts`, `provider.ts`, `image-input.ts`, `launch-environment.ts`, `session-adapter-errors.ts`, `session-launch-files.ts`, `worker-mode.ts`, `worker-reporting.ts` | Provider CLI infrastructure and shared provider interface adapters. | Split CLI-shaped `ProviderLaunchSpec`/terminal buffer interfaces away from application session use case. Keep exact commands, environment allowlists, permission mapping, MCP injection, resume identity, and cleanup. `image-input` policy may move inward; file attachment stays outward. |
| `providers/antigravity/capabilities.ts`, `commands.ts`, `dispatch-adapter.ts`, `session-adapter.ts`, `text-output.ts`, `workspace-trust.ts` | Antigravity CLI infrastructure and codecs. | Preserve evidence grades, exact `agy` argv, trust-store mutation, result bounds, cancellation, and resume refusal. |
| `providers/claude/dispatch-adapter.ts`, `headless-command.ts`, `mcp-allowlist.ts`, `no-subagents.ts`, `permissions.ts`, `stream-codec.ts`, `transcript-hook.ts` | Claude CLI infrastructure and codecs. | Preserve explicit-model safety, permission mapping, MCP allowlist, transcript binding, stream interpretation boundary, and exact launch/resume identity. |
| `providers/cursor/commands.ts`, `dispatch-adapter.ts`, `input.ts`, `mcp-hosting.ts`, `mcp-isolation.ts`, `run-everything.ts`, `session-adapter.ts`, `stream-codec.ts`, `workspace-state.ts` | Cursor CLI infrastructure and codecs. | Preserve session-scoped MCP state, pasted-input pacing, `/run-everything` verification, Scout isolation/mutation hash, stream bounds, and resume identity. |
| `nvim/bridge.ts`, `server-address.ts`, `window-layout.ts`, `worktree-changes.ts` | nvim/Git/tmux/filesystem infrastructure. | Implement nvim notification and repository-change ports. |
| `tmux/cockpit.ts`, `interactive-shell.ts` | tmux/process/filesystem infrastructure supporting delivery. | No application import. Preserve tmux ownership rule and rollback-only `kill-session`. |
| `paths.ts`, `runtime-config.ts`, `version.ts` | Filesystem/configuration infrastructure. | Inject resolved settings/version into application/controller constructors. |
| `control-plane/runtime.ts`, `broker/worker-coordination-runtime.ts` | Composition helpers, not application. | May remain outward or fold into one bootstrap package. They are allowed to construct concrete stores. |

### Delivery

| Current modules | Assignment | Split/move note |
| --- | --- | --- |
| `cli.ts` | CLI delivery plus oversized composition/helper code. | Keep Commander declarations, text/JSON output, and process exit behavior. Move broker bootstrap and direct store/Git/tmux/nvim helpers behind controllers. |
| `mcp/server.ts` | MCP stdio delivery plus controllers. | First controller extraction is already in flight. Keep JSON-RPC/tool names, schemas, descriptions, actor identity, and error envelopes byte-compatible where fixtures assert them. |
| `client/fleet.ts` | Fleet TUI delivery plus controller/persistence/process helpers. | Split views/input/rendering from permission repository, image capture, shell command, and broker DTO construction. Do not redesign UI in decomposition PRs. |
| `client/attach.ts`, `dashboard.ts`, `display-width.ts`, `octopus.ts` | Delivery/presentation. | `attach.ts` uses protocol/socket transport adapter; keep transport behind `AttachTransport`. |
| `client/rpc-client.ts` | Unix-socket delivery adapter. | No application import of this module. |
| `client/clipboard-image.ts`, `path-completion.ts`, `pr-status.ts` | Filesystem/process infrastructure called by Fleet delivery through ports. | Preserve platform behavior and cache/error rendering. |
| `nvim/open-worktree.ts`, `layout-hook.ts`, `pane.ts` | nvim delivery/controllers mixed with process/tmux infrastructure. | Keep key/action semantics; call application nvim/project ports. Move process/pane discovery outward where needed. |
| `broker/worker-coordination-view.ts` | Fleet presenter. | Move near client/controller view models; it must not become ownership source of truth. |
| `broker/main.ts` | Top-level composition root/bootstrap. | Explicit dependency-lint exception. It may import all concrete modules but owns no business rules. |

## Ordered strangler slices

Ten slices shown. First three are sibling work already in flight and must be integrated, not
reimplemented here. Every slice preserves behavior and can land independently.

| Order | Status | Seam established | Files touched | Risk | Parity proof |
| --- | --- | --- | --- | --- | --- |
| 0A | **In flight: sibling** | Executable dependency rule and documented allowed-import matrix. | Sibling-owned new architecture rule doc and Vitest architecture test; exact new paths are not present in this checkout and are intentionally not invented. | Low, but may expose many existing violations. | Architecture test first records narrow temporary exceptions, then fails on any new outward import. Existing test suite remains unchanged. |
| 0B | **In flight: sibling** | `SessionRuntime` port over PTY/pipe runtime so session logic no longer names `node-pty`/child-process implementations. | Declared scope: `src/runtime/pty-process.ts`, `src/runtime/pipe-process.ts`, session/runtime wiring in `src/broker/session-registry.ts` and `src/broker/main.ts`, plus focused runtime/broker tests. | High. Process exit, replay, signal, resize, and fast one-shot adoption are lifecycle-critical. | `tests/runtime/pty-process.test.ts`, `pipe-process.test.ts`, `tests/broker/session-registry.test.ts`, `scout-session.test.ts`, and `tests/integration/session-lifecycle.test.ts`; assert unchanged replay/exit/signal behavior. |
| 0C | **In flight: sibling** | First MCP controller extracted from stdio/tool delivery. | Declared scope: `src/mcp/server.ts`, one new controller module, `tests/mcp/server.test.ts`, and/or `tests/mcp/orchestrator-control-tools.test.ts`. Exact new path belongs to sibling slice. | Medium. Public tool contracts are orchestrator-facing API. | Existing MCP fixture tests assert unchanged tool names, input schemas, actor injection, broker method/params, result/error envelopes, and conversation-drift note. |
| 1 | Proposed | `ProviderModelProbe` becomes inward application port; CLI execution becomes infrastructure adapter. Cache/fallback stays application. | `src/orchestration/worker-capability-catalog.ts`; new application port and provider-CLI adapter modules; `src/broker/main.ts`; `tests/orchestration/worker-capability-catalog.test.ts`. | Low. | Recording probe tests retain TTL/single-flight/fallback semantics. Adapter tests assert exact `agent models`/`agy models`, closed stdin, `/` cwd, timeout, max buffer, parser, and errors. `agent-control-service` capability tests stay unchanged. |
| 2 | Proposed | Orchestrator permission/session ports isolate `OrchestratorManager`; permission preference contract moves out of client. One use case only. | New application permission and orchestrator-session ports; `src/orchestration/orchestrator-manager.ts`; `src/client/permission-policy.ts`; `src/persistence/provider-permission-preference-store.ts`; broker composition adapter; corresponding orchestrator/permission/persistence tests. | Medium. | Existing orchestrator-manager, permission-policy, provider-permission-store, provider resolution, and session-policy tests. Assert unchanged provider modes, warnings, Fable grant, create/ensure/reset behavior, error codes, and durable preference records. |
| 3 | Proposed | Instruction/workflow repository and session-catalog ports remove concrete broker/store imports from two tightly coupled use cases. | New ports; `src/orchestration/instruction-queue.ts`, `workflow-service.ts`; `src/persistence/instruction-store.ts`, `workflow-store.ts`, `orchestrator-store.ts`; broker adapters/composition; focused tests. | Medium. | Existing instruction/workflow/store tests plus `tests/integration/instruction-delivery-truth.test.ts`. Assert FIFO, capability scope, workflow limits, wake behavior, and rendered/submitted/acknowledged/completed truth remain unchanged. |
| 4 | Proposed | `WorkerCoordinationRepository` and neutral coordination use-case interface owned inward; JSONL store and migration depend on it. | Port module; `src/broker/worker-coordination.ts`, `worker-coordination-runtime.ts`; `src/persistence/worker-coordination-store.ts`, `migrations/0001-worker-coordination.ts`; worker coordination unit/integration tests. Physical service move may be a separate mechanical commit in the same PR after the port compiles. | High. | `tests/broker/worker-coordination.test.ts`, persistence replay/corruption tests, and integration ownership/events tests. Assert transaction atomicity, stable controller IDs, monotonic lease versions, token fencing, idempotency, migration counts, and restart recovery unchanged. |
| 5 | Proposed | `AgentControlService` depends on narrow session, transcript, preference, capability, Scout, and intervention ports. No worker-control/handoff changes in this slice. | New ports/adapters; `src/orchestration/agent-control-service.ts`, `scout-wave-digest.ts`, `worker-intervention-wait.ts`; broker composition; focused agent-control/wait/Scout tests. | High because this is the largest use case, but scope is type dependencies and adapters only. | Existing agent-control, worker-capability, Scout digest/profile, wait deadline/recovery, broker Scout, and session lifecycle tests. Assert worker start fields, IDs, grants, wait targets/results/provenance, Scout handles, stop behavior, and error codes. |
| 6 | Proposed | Existing `WorkspaceProbe` and `WorktreeProvisioner` contracts become application ports with Git/filesystem implementations outside orchestration. | `src/domain/worker-workspace.ts`; `src/orchestration/git-workspace-probe.ts`, `git-worktree-provisioner.ts`; new infrastructure Git modules; `src/broker/main.ts`, `session-registry.ts`; matching tests. | Medium-high. | Existing domain/probe/provisioner/session-registry tests against temporary Git repos. Assert exact argv, canonical paths, base commit pinning, provenance location/content, no package manager, warnings, non-force discard, and failure codes. |
| 7 | Proposed | Lease repository and canonical-path ports remove filesystem/store implementation from `WorktreeLeaseManager`; composition owns `LeaseStore`. | `src/control-plane/worktree-lease-manager.ts`, `runtime.ts`; `src/persistence/lease-store.ts`; `src/app-server/dispatch-adapter.ts`; new ports/adapters; lease/runtime/app-server tests. | High. | Worktree lease unit tests plus `tests/integration/app-server-lease.test.ts`, `app-server-interruption.test.ts`, and control-plane acceptance/recovery tests. Assert canonical key, sharing/exclusion, monotonic fencing, heartbeat, orphan blocking, expiry, stale release, and no cleanup change. |

After slice 7, next horizon is worker-control/handoff/event-channel ports; worktree inventory/removal
separation; physical extraction of `SessionRegistry` state-machine sections; broker RPC controllers
beyond the first MCP example; Fleet/CLI presenter splits; nvim project/binding adapters;
transcript/Scout store separation; and provider-port inversion. Those should be planned from the
now-stable ports, not bundled into Wave 1.

## Requires operator approval

MIK-94 consultation gate applies before any item below changes. Default for every slice is “retain
current owner and semantics; add seam only.”

1. **Session source of truth.** Approve any move of lifecycle authority out of `SessionRegistry`:
   session ID creation, provider-native identity, active/interrupted/terminal mapping, controller and
   watcher ownership, resume eligibility, stop/delete, parent/child rules, or recovery rewrite.
2. **Worker truth and instruction truth.** Approve any new owner for `completedTurns`,
   `canonicalTurns`, composer/modal observations, delivery state, expected-turn floors, replay
   retrieval, provider-limit precedence, or terminal projection. These semantics are shared by wait,
   thread list, worker events, Fleet, and nvim locking.
3. **Worker ownership identity.** Approve movement or redesign of controller/family/scope identity,
   immutable origin, lease tokens, process-local credential loss, lease expiry/adoption/transfer,
   audit actor, transaction atomicity, checkpoint identity, handoff acknowledgement, or migration.
4. **Durable sources of truth.** Approve any change to JSONL paths, schema versions, record shapes,
   fsync/atomicity, corruption policy, crash-tail handling, replay order, idempotency indexes,
   tombstones, retention, or migration ordering for jobs, sessions, transcripts, orchestrators,
   workers, preferences, grants, artifacts, and leases.
5. **Worktree responsibility and safety.** Approve moving provisioning/pruning ownership, canonical
   repository identity, base-ref pinning, provenance location, rollback behavior, live/dirty/pushed
   retention rules, operator `--yes` gate, or current refusal to force/delete automatically.
6. **Lease identity/lifecycle.** Approve canonical-key changes, read-only sharing, write exclusivity,
   owner key, TTL/heartbeat defaults, fencing monotonicity, orphan mapping, stale release behavior,
   or manual remediation contract.
7. **Provider launch boundary.** Approve any change to provider ID, executable/argv, cwd, environment
   allowlist, sandbox/approval resolution, writable roots, explicit-model/Fable gates, MCP injection,
   transcript hooks, initial input, terminal setup, output interpretation, cancellation, resume
   identity, launch records, or cleanup. Moving code with byte-identical specs needs no semantic
   approval; changing port shape in a way that moves responsibility does.
8. **Provider capability authority.** Approve changes to live CLI versus fallback-catalog precedence,
   cache TTL, query cwd/timeout, parser acceptance, model labels/IDs, effort pairing, failure wording,
   or whether a transient CLI failure blocks launch versus serves fallback.
9. **Transcript and Scout authority.** Approve moving attribution, Claude `/clear` handling,
   binding conflicts, native-versus-terminal turn provenance, card validation/promotion, trace/evidence
   bounds, repository mutation verification, or completion criteria between store, adapter, and use
   case.
10. **New abstractions and DI.** Approve port granularity, application directory/module naming,
    clock/ID/hash/canonical-path interfaces, composition-root exception, compatibility re-exports,
    and whether constructors receive grouped contexts or narrow individual ports. Avoid service
    locator or container framework unless separately approved.
11. **Domain purity rule.** Approve whether `zod`, pure `node:path`, Node crypto hashing, and root
    constants are allowed in domain. Current domain has no filesystem/process implementation access;
    making it fully platform-free creates extra adapters and must be deliberate.
12. **Public behavior.** Approve any CLI command/flag/default/output/exit-code change; Fleet key,
    screen, wording, ordering, or state change; MCP tool/name/schema/description/result/error change;
    broker RPC method/frame/error change; nvim payload/lock/command change; or tmux ownership,
    session naming, focus, detach, rollback, or process behavior.
13. **Control-plane authority.** Approve moving job lifecycle, admission order, budget debit,
    adapter registration, report-back acknowledgement, quarantine, reconciliation, startup gate, or
    shutdown ordering. Composition may move; these decisions may not drift.
14. **Configuration ownership.** Approve movement or reinterpretation of state-directory defaults,
    limits, concurrency/budget declarations, retention policy, broker socket path, provider allowlist
    files, or version discovery. Injection must preserve current resolved values.
15. **Rollout compatibility.** Approve removal of temporary compatibility imports/re-exports or lint
    exceptions. Strangler slices should add ports first, migrate one consumer at a time, then remove
    old paths only after all callers and tests are proven.

## Definition of parity for MIK-94 slices

A green typecheck/unit suite is necessary but not sufficient. Each slice must state which proof it
has:

- static dependency proof: architecture rule passes and no new exception appears;
- contract proof: existing schemas, public methods, error codes, and durable record fixtures match;
- provider/process proof: exact argv/env/stdin/signal/replay fixtures match, without live model calls;
- persistence proof: replay/corruption/fsync/idempotency tests match;
- integration proof: existing broker/session/control-plane/worker coordination integration tests
  covering affected lifecycle pass;
- runtime proof, only when operator authorizes it: live broker/provider/tmux acceptance. Source tests
  never claim this gate.

No slice should combine a boundary move with behavior cleanup. First depend on a port, then move the
implementation, then delete compatibility paths. Each step lands with the same behavior and a
smaller exception list.
