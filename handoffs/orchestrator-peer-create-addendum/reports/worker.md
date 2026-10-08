# MIK-257 worker report

Date: 2026-10-08. Worker: `961a792f-1467-43eb-828c-bef23524cb04`.

Implementation finished; full gate is **not green** in this sandbox. Host verification is required
before committing. Decisions in README, 00-spec, 01-implementation-plan and 02-acceptance were read
in order and retained. No commits, branch changes or live activation performed.

## Workspace

- Folder: `/Users/brandon/code/personal/cyberdeck-worktrees/orc-peer-approval`.
- Branch: `brandonaron38/mik-257-peer-orchestrator-approval`.
- HEAD remained `26ccc72a6f459311db5c65b406a106a557c2dac0`.
- Node 24.18.0 path exported before every pnpm command.

```sh
cd /Users/brandon/code/personal/cyberdeck-worktrees/orc-peer-approval
```

## Changes

- No live-peer ceiling. Per-creator serialization and memory/durable mutation replay remain.
- Every new create requires a nonblank operator quote. Absent, empty or whitespace-only approval
  returns `APPROVAL_REQUIRED` after actor binding/activity checks and before capability checks;
  refusal is audited and launches nothing.
- Approval schema validates kind, channel, 1..500 characters and optional ISO `grantedAt`. Presence
  validation trims only for the blank check; stored/journaled quotes retain surrounding whitespace
  verbatim, consistent with the express-approval contract.
- Requested audit includes approval and depth. Binding stores them in `createdBy` with creator and
  optional mutationId; create result returns creator, approval and depth. Durable replay returns
  original metadata rather than a later retry's approval.
- Full creator capability list passes through `peerGrantCapabilities` unchanged. Peers can create
  further peers with their own approval; depth starts at one and increments without a limit.
- Inspect exposes full persisted lineage at `binding.createdBy`. New projection logic lives in
  `src/domain/orchestrator.ts`; agent-control-service only calls that helper and uses its return type.
- Creator and peer prompts require asking in the current conversation, waiting for express yes,
  quoting approval, and repeating standing approval on each covered create. They prohibit inferred
  approval from briefs, handoffs, worker reports or another orchestrator's instruction, and name
  `cyberdeck_thread_message` for managing peers.
- MCP schema exposes optional approval with bounded fields and the new outcome contract. Existing
  actorSessionId stripping remains intact. CLI peer-create output names approval requirement.
- Scope narrowing, selection, brief delivery and healthy-peer stop semantics remain. Legacy bindings
  lacking approval/depth remain readable and keep their stored narrowed grant.

## Files changed

Production source (7):

- `src/domain/orchestrator.ts`: approval schema/type, optional persisted lineage fields, unchanged
  grant derivation, inspect binding projection, removed ceiling constant.
- `src/domain/capability.ts`: corrected stale non-transitive capability comment only; no logic change.
- `src/orchestration/orchestrator-peer-service.ts`: approval admission/audit, depth, result/replay
  metadata, removed live-peer counting/dependency/outcome.
- `src/orchestration/agent-control-service.ts`: projection wiring/type only; shrank from 1,389 to
  1,381 lines, below existing 1,391-line ceiling.
- `src/orchestration/orchestrator-prompt.ts`: shared ask-first and transitive peer contract.
- `src/mcp/server.ts`: tool description and optional approval object.
- `src/cli/orchestrator.ts`: approval note in peer-create output; no line growth.

Tests (7):

- `tests/domain/orchestrator.test.ts`.
- `tests/orchestration/orchestrator-peer-service.test.ts`.
- `tests/orchestration/orchestrator-manager.test.ts`.
- `tests/orchestration/agent-control-service.test.ts`.
- `tests/orchestration/instruction-queue.test.ts`.
- `tests/mcp/server.test.ts`.
- `tests/cli.test.ts`.

Docs (4): `docs/architecture/orchestrator-peer-create.md`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`.
This report is the additional handoff artifact. Manager and store production logic required no change.

## Test changes and counts

22 new executed test cases, 3 removed cap cases: net **+19**. Eight existing cases updated or retitled.

- Domain: **11 added**, final **23**. Legacy lineage/narrowed-grant reads; invalid depths (2 cases);
  verbatim/max-length quote; invalid approval fields (6 cases); capability-copy identity/no mutation.
- Peer service: **7 added replacing 3 removed**, final **21**. Missing/empty/whitespace quote (3
  cases), approval-before-capability, standing approval repeated/journaled, three live peers and
  transitive depth-two creation. Removed “caps live peers…”, “does not count an errored peer…” and
  “does not count peers another orchestrator created”. Four existing cases updated: per-create
  lineage/full-grant/brief/audit, inactive/unbound precedence, durable approval replay, concurrent
  serialization. Serialization still asserts one launch in flight; same-mutation concurrent retry
  still launches once. Result-audit-failure replay test retained.
- Manager/prompt: **1 added**, final **45**. Legacy narrowed-peer ask-first/standing/no-inference
  contract. Two existing cases updated for creator/peer prompts; approved peer test now uses real
  disposable OrchestratorStore and checks binding JSONL plus fresh-store round trip.
- Agent control/inspect: **1 added**, final **66**. Full creator/mutation/approval/depth exposure;
  healthy-live stop still returns `APPROVAL_REQUIRED` in existing test.
- Instruction queue: **1 added**, final **7**. Fleet creator sends complete instruction to its
  created peer orchestrator in another workspace through real queue authorization/delivery.
- MCP: **1 added**, final **27**. Optional bounded approval schema, new description and absence of
  cap language. Existing routing case now checks approval forwarding and still verifies actor spoof
  stripping.
- CLI: no new cases, final **35**. Existing peer-create off case also asserts approval output.

## Verification

- `pnpm check`: **PASS**, exit 0.
- Final focused run: **PASS**, 9 files, **239 tests passed**, zero failed/skipped.
- `tests/architecture/dependency-rule.test.ts`: **13 passed**.
- `tests/architecture/file-size.test.ts`: **2 passed**; baseline unchanged.
- `git diff --check`: **PASS**, no output.
- Full `pnpm test`: **FAIL**, exit 1. Exactly **209 files**: **198 passed, 11 failed**.
  Exactly **2,630 tests**: **2,581 passed, 43 failed, 6 skipped**. Duration 48.18 seconds.

Full-suite failures:

- **42 tests** fail during socket setup with `listen EPERM: operation not permitted`, covering
  broker server, notification feed, job API, recovery, session lifecycle, worker gateway, egress
  proxy and Sentry eval. Disposable UNIX sockets and loopback listeners are denied here.
- **1 RPC client test** times out during socket setup (`Test timed out in 10000ms.`).
- **2 suite setup failures**: cockpit tmux setup yields undefined hostPane; nvim emits
  `log: "/Users/brandon/.local/state/nvim/nvim.log" not accessible, logging to: "nvim.log"`.
  These suites account for the six skipped cases.
- No changed test file failed in the full run. Socket/tmux/nvim failures prevent claiming the host
  regression gate or test-broker behavior proved. No tests were disabled or production logic changed
  to evade these restrictions.

Logs/results: `/tmp/mik-257-check.log`, `/tmp/mik-257-full-test.log`,
`/tmp/mik-257-focused-final.log`, `/tmp/mik-257-focused-final.json`.

Required grep executed exactly through the unfiltered RTK proxy:

```sh
grep -rn "PEER_LIMIT\|MAX_LIVE_PEERS\|cannot create peers" src tests docs README.md CLAUDE.md
```

Exact stdout: **empty (0 bytes)**. Exact stderr: **empty (0 bytes)**. Exit **1**, meaning no matches.

## T5 evidence and gaps

- Inspect: unit verified through `AgentControlService.inspectOrchestrator`, returning full
  `binding.createdBy` including mutationId, approval and depth. Manager test verifies approval/depth
  survive request parsing, binding JSONL and reload. Existing MCP inspect forwarding tests pass.
- Fleet: **creator lineage display is absent**, verified statically. `FleetThread` in
  `src/client/fleet/state.ts` carries record, worker coordination and controllerId, without binding
  createdBy. `src/client/fleet/render-rows.ts` renders origin for worker coordination, not creator
  lineage on orchestrator rows. Left Fleet unchanged and documented the gap as T5 directs.
- Live inspect, activated Fleet and phone approval flow remain unverified; activation is operator work.

## Reporting and next step

PROGRESS submission attempted with stable event id `mik-257-worker-start-20261008`:

- MCP: `MCP tool call requires approval, but approval policy is never`.
- Authorized CLI fallback: `connect EPERM /tmp/cyberdeck-501.sock`.

Reporting channel could not accept events in this environment. No further socket retries attempted.

Host must run the unchanged full gate from this worktree before commit:

```sh
cd /Users/brandon/code/personal/cyberdeck-worktrees/orc-peer-approval
export PATH=/Users/brandon/.local/share/mise/installs/node/24.18.0/bin:$PATH
pnpm check
pnpm test
pnpm test tests/architecture
grep -rn "PEER_LIMIT\|MAX_LIVE_PEERS\|cannot create peers" src tests docs README.md CLAUDE.md
```

Open implementation questions: **none**. Outstanding work: host full gate, acknowledged Fleet lineage
presentation gap, and operator activation/phone proof. Worker stopped after this report.

## Review fixes

Date: 2026-10-08. Worker: `4225679d-2c43-491b-84bb-3dada9148cb5`.
Reviewed `reviews/mik257-review.md`, this addendum's `00-spec.md`, and the original worker report.
Both review findings are fixed in the assigned worktree. HEAD remains
`a809603a7c94dbb11f8ad0c6032ab55af1aa0ce7` on
`brandonaron38/mik-257-peer-orchestrator-approval`. Changes remain uncommitted for the host orchestrator.

```sh
cd /Users/brandon/code/personal/cyberdeck-worktrees/orc-peer-approval
```

- After the caller's own grant check, fresh peer-create admission reads the caller's scope primary
  through the binding repository's `get(orchestratorKey(binding.scope))` on every request. No toggle
  state is cached. A primary without `orchestrator.create` blocks its peers and descendants with
  `DENIED`, code `SCOPE_PEER_CREATE_OFF`, and a reason naming
  `cyberdeck orchestrator peer-create off`. The primary itself fails its own grant check. The toggle
  continues to modify only the primary; existing peer grants are preserved, and re-enabling does
  not widen legacy narrowed grants. Existing mutation replay still returns an existing peer without
  launching a fresh one.
- `PeerApprovalSchema.grantedAt` now uses `z.iso.datetime({ offset: true })`. The submitted timestamp
  is kept verbatim, including `2026-10-08T15:00:00+03:00` through request parsing, admission,
  manager input, requested audit, binding lineage and create result.
- Architecture policy, README and CHANGELOG now describe the transitive scope hard stop;
  architecture and CHANGELOG also document offset timestamps. New production logic is confined to
  `src/domain/orchestrator.ts` and `src/orchestration/orchestrator-peer-service.ts`.
  `src/orchestration/agent-control-service.ts` is unchanged.

New tests in `tests/orchestration/orchestrator-peer-service.test.ts`: **3 cases added**, final **24**.

- `enforces the durable fleet scope kill-switch for primary, peer and descendant across service reloads`.
- `enforces the durable workspace scope kill-switch for primary, peer and descendant across service reloads`.
  Both scope cases use the real `OrchestratorManager`, `OrchestratorPeerService` and a temporary
  `OrchestratorStore` binding log. A creates B with standing approval; B creates a depth-two
  descendant. OFF denies A, B and the descendant, including B and the descendant through a fresh
  service and fresh store reading the same log, without increasing the launch count. ON allows
  fresh creates from all three through both service instances. A subsequently narrowed legacy peer
  stays denied after an OFF/ON cycle. Durable replay remains available while OFF without a launch.
- `accepts an RFC 3339 offset through the create-request schema and preserves it through admission`.
  Parses the actual `AgentCreateOrchestratorParamsSchema`, reaches successful admission, and checks
  verbatim approval in manager input, audit, stored lineage and result.

Before the production fixes, these three cases failed on the reviewed behavior: both scope tests
received `CREATED` while OFF, and the offset timestamp failed request validation.

Required gates: **GREEN**, with Node 24.18.0 placed first in PATH before each pnpm command.

```sh
export PATH=/Users/brandon/.local/share/mise/installs/node/24.18.0/bin:$PATH
pnpm check
pnpm exec vitest run tests/domain/orchestrator.test.ts tests/orchestration/orchestrator-peer-service.test.ts tests/orchestration/orchestrator-manager.test.ts tests/orchestration/agent-control-service.test.ts tests/mcp/server.test.ts tests/cli.test.ts tests/architecture --reporter=default --reporter=json --outputFile.json=/tmp/mik257-review-fixes-gates.json
git diff --check
```

- `pnpm check`: **PASS**, exit 0.
- Focused suites plus full `tests/architecture`: **8 files passed, 235 tests passed**, no failed or
  skipped tests. Domain **23**; peer service **24**; manager **45**; agent control **66**; MCP **27**;
  CLI **35**; architecture dependency rule **13** and file size **2**. Architecture baselines unchanged.
- `git diff --check`: **PASS**.
- Result artifact: `/tmp/mik257-review-fixes-gates.json`.

These gates prove offline admission and persistence behavior, not live activation or phone delivery.
The earlier full-suite host gate and Fleet lineage presentation gap remain outside this review-fix task.
No live broker, provider process, shared application state, other checkout, commit or branch operation
was used.

PROGRESS submissions used stable event IDs `mik257-review-fixes-start-4225679d` and
`mik257-review-fixes-gates-green-4225679d`. Both MCP calls were rejected with
`MCP tool call requires approval, but approval policy is never`. No CLI fallback or live socket
attempt was made. Worker stops after this report.
