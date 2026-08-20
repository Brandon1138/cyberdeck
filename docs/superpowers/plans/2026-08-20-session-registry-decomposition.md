# Session Registry Clean Architecture Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `SessionRegistry` from a 3,415-line semantic magnet into a lifecycle/attachment facade over explicit application-owned ports, worker-turn policy, workspace coordination, and Scout supervision, without changing Cyberdeck behavior or making MIK-91 design decisions.

**Architecture:** `src/broker/main.ts` becomes the one explicit composition root allowed to construct infrastructure. Orchestration services consume narrow capability ports rather than the concrete registry or JSONL stores. Stateful worker-turn, workspace, and Scout responsibilities move into application-owned components; provider/runtime/persistence modules implement their inward ports, while `SessionRegistry` remains canonical session truth and the compatibility surface used by broker RPC during the migration.

**Tech Stack:** TypeScript, Node.js 24, Vitest, JSONL persistence, Cyberdeck broker/session runtime.

**Spec:** `docs/architecture/mik-94-decomposition-proposal.md`

## Global Constraints

- Begin every slice from the then-current green `origin/main`; never build a later slice on an unmerged predecessor.
- Preserve canonical broker/session truth, event ordering, sequence semantics, provider argv/env behavior, attachment behavior, durable JSONL formats, and all CLI/Fleet/MCP schemas.
- Do not implement or design SBX, Sentry, Promptfoo, executor selection, telemetry schemas, privacy/redaction, permission relaxation, dependencies, cost policy, or sandbox lifecycle for MIK-91.
- `src/client/**` must gain no import from broker/runtime internals.
- The architecture dependency baseline starts at exactly 103 entries on `4318b2d33f4691d6b54a8133cce81bb099190b8a`; every slice must keep it flat or reduce it, and no removed violation may remain stale in the baseline.
- Do not run `pnpm install` or any package-manager install/prune command; use the shared `node_modules`.
- For linked worktrees under `worktrees/*`, invoke shared tools via `../../node_modules/.bin` (for example, `../../node_modules/.bin/vitest` and `../../node_modules/.bin/tsc`); do not install dependencies.
- Treat `tests/runtime/shell-command.test.ts` `streams output as it arrives` as a known load-sensitive flake only after it passes in isolation.
- Use isolated worktrees, conventional commits with the slice's Linear identifier, normal GitHub review, exact-head `verify`, zero live unresolved findings, and merge commits.
- Do not update the baseline by replacing one violation with a differently located violation. New application components import only application/domain contracts.
- Every extraction owns state and invariants. Do not move thin forwarding helpers or expose the 38-field `RuntimeSession` aggregate across a new boundary.

## Baseline Profile

- `src/broker/session-registry.ts`: 3,415 physical lines; 2,936 lines in `SessionRegistry`; 108 callable declarations; 38 per-session runtime fields; 11 registry-wide fields; 12 injected concerns.
- Dependency baseline: 103 violations total; 25 are legitimate `src/broker/main.ts` composition edges; 14 originate in `session-registry.ts`.
- Green baseline: architecture 10/10, full suite 1,829/1,829, typecheck clean.
- Only the final architecture report may claim MIK-91 readiness, and only as readiness for operator-led design. MIK-91 remains blocked from autonomous implementation by its own consultation gate.

## Linear Slice Chain

- Parent: MIK-137
- Task 1: MIK-138 blocks MIK-139
- Task 2: MIK-139 blocks MIK-140
- Task 3: MIK-140 blocks MIK-141
- Task 4: MIK-141 blocks MIK-142
- Task 5: MIK-142 blocks MIK-143
- Task 6: MIK-143 closes the programme; MIK-137 blocks MIK-91 until this chain is complete.

---

### Task 1: Make the Composition Root Explicit

**Current responsibility:** `src/broker/main.ts` already constructs providers, runtimes, stores, and use cases, but the ratchet classifies it as ordinary application code and carries 25 false-positive baseline entries.

**Destination boundary:** A dedicated `composition` layer used only by `src/broker/main.ts`. Composition may import all layers; no other broker module receives that privilege. The exact executable bootstrap edge `src/cli.ts -> src/broker/main.ts` may enter the composition root; no other source may import composition.

**Allowed dependency direction:** `composition -> delivery | infrastructure | application | domain`, plus the one source-aware `cli.ts -> broker/main.ts` boot edge; all existing delivery/application/domain/infrastructure directions remain unchanged.

**Files:**
- Modify: `tests/architecture/dependency-rule.test.ts`
- Modify: `docs/architecture/dependency-rule-baseline.json`
- Modify: `docs/architecture/dependency-rule.md`
- Modify: `docs/architecture/mik-94-decomposition-proposal.md`
- Create: `src/orchestration/startup-thread-retention.ts`, `tests/orchestration/startup-thread-retention.test.ts`
- Modify: `src/broker/main.ts`

**Interfaces:**
- Consumes: existing `Layer`, `ALLOWED_IMPORTS`, `layerFor`, and exact baseline comparison.
- Produces: `Layer = "composition" | "delivery" | "application" | "domain" | "infrastructure"`; the exact `broker/main.ts` path maps to `composition`; source-aware import allowance admits only `cli.ts -> broker/main.ts`; baseline count becomes 78. The application-owned `src/orchestration/startup-thread-retention.ts` owns structural ports for session catalog load/compact, Scout report removal, and Claude binding removal.

- [ ] **Step 1: Add the failing composition-root regression**

Add next to the current layer-assignment tests:

```ts
it("treats only broker/main.ts as the composition root", () => {
  expect(layerFor(resolve(SOURCE_ROOT, "broker/main.ts"))).toBe("composition");
  expect(layerFor(resolve(SOURCE_ROOT, "broker/server.ts"))).toBe("application");
  expect(isAllowedLocalImport(
    resolve(SOURCE_ROOT, "cli.ts"),
    resolve(SOURCE_ROOT, "broker/main.ts"),
  )).toBe(true);
  expect(isAllowedLocalImport(
    resolve(SOURCE_ROOT, "client/fleet.ts"),
    resolve(SOURCE_ROOT, "broker/main.ts"),
  )).toBe(false);
});
```

- [ ] **Step 2: Prove the test fails for the present classification**

Run:

```bash
../../node_modules/.bin/vitest run --configLoader runner tests/architecture/dependency-rule.test.ts
```

Expected: FAIL because `layerFor(.../broker/main.ts)` is `application` and 25 current violations originate there.

- [ ] **Step 3: Add the startup-retention tests first and capture RED**

Create `tests/orchestration/startup-thread-retention.test.ts` importing the desired orchestration
module path before the module exists. Use recording in-memory ports and assert no-op retention,
interleaved survivor order in both the returned and compacted arrays, Scout-only cleanup, cleanup
rejection settlement, Scout-rejection binding skip, and deferred cross-record cleanup where the
second record starts before the first settles and compaction waits for both.

Run:

```bash
../../node_modules/.bin/vitest run --configLoader runner tests/orchestration/startup-thread-retention.test.ts tests/architecture/dependency-rule.test.ts
```

Expected: RED from the missing `src/orchestration/startup-thread-retention.ts` module while the existing architecture tests remain green.

- [ ] **Step 4: Add the exact composition layer**

Implement the explicit layer before the top-level `broker` classification:

```ts
type Layer = "composition" | "delivery" | "application" | "domain" | "infrastructure";

const ALLOWED_IMPORTS: Readonly<Record<Layer, ReadonlySet<Layer>>> = {
  composition: new Set(["composition", "delivery", "application", "domain", "infrastructure"]),
  delivery: new Set(["delivery", "application", "domain"]),
  application: new Set(["application", "domain"]),
  domain: new Set(["domain"]),
  infrastructure: new Set(["infrastructure", "application", "domain"]),
};

function layerFor(path: string): Layer {
  const relativePath = relative(SOURCE_ROOT, path).split(sep).join("/");
  if (relativePath === "broker/main.ts") return "composition";
  // Preserve every remaining assignment exactly.
```

Apply the layer matrix through a source-aware predicate so the executable can enter the root without allowing all delivery code to depend on composition:

```ts
const CLI_ENTRYPOINT = resolve(SOURCE_ROOT, "cli.ts");
const BROKER_COMPOSITION_ROOT = resolve(SOURCE_ROOT, "broker/main.ts");

function isAllowedLocalImport(importer: string, target: string): boolean {
  if (layerFor(target) === "composition") {
    return importer === CLI_ENTRYPOINT && target === BROKER_COMPOSITION_ROOT;
  }
  return ALLOWED_IMPORTS[layerFor(importer)].has(layerFor(target));
}
```

Use `isAllowedLocalImport(importer, target)` inside `currentViolations()`.

Delete all 25 sorted baseline entries whose `from` is `src/broker/main.ts`; do not add replacement entries.

- [ ] **Step 5: Move startup retention into the application layer**

Create `src/orchestration/startup-thread-retention.ts` with only domain imports and three narrow
structural ports: catalog `load`/`compact`, Scout `remove`, and Claude `dropClaudeBinding`.
Move `retainThreads` and its expired-record policy out of `main.ts`; preserve sequential per-record
cleanup, cross-record `Promise.allSettled`, rejection behavior, post-settlement compaction, and
original catalog order. `main.ts` constructs the concrete stores and wires the ports. Update the
architecture regression to assign the orchestration module to application with zero violations.
Delete the old broker module/test paths using `apply_patch` add/delete edits.

- [ ] **Step 6: Align the architecture documents**

Change the dependency-rule status from provisional to enforced, document the one exact composition path and its sole CLI bootstrap importer, and record that startup retention is application-owned. Mark proposal row 0A landed with the orchestration production/test paths. Record that composition is construction only: application policy must not move into `main.ts`.

- [ ] **Step 7: Verify the slice**

Run:

```bash
../../node_modules/.bin/vitest run --configLoader runner tests/orchestration/startup-thread-retention.test.ts tests/architecture/dependency-rule.test.ts
../../node_modules/.bin/tsc -p tsconfig.json --noEmit
../../node_modules/.bin/vitest run --configLoader runner tests/domain/thread-retention.test.ts tests/broker/thread-durability.test.ts tests/integration/broker-recovery.test.ts tests/persistence/claude-transcript-rebind.test.ts
../../node_modules/.bin/vitest run --configLoader runner
```

Expected: focused architecture/retention tests green, parity and typecheck clean, full suite green, baseline exactly 78, with startup retention policy extracted from the composition root.

- [ ] **Step 8: Commit, publish, review, and merge**

```bash
git add -- src/broker/main.ts src/orchestration/startup-thread-retention.ts tests/orchestration/startup-thread-retention.test.ts tests/architecture/dependency-rule.test.ts docs/architecture/dependency-rule-baseline.json docs/architecture/dependency-rule.md docs/architecture/mik-94-decomposition-proposal.md docs/superpowers/plans/2026-08-20-session-registry-decomposition.md
git commit -m "refactor(architecture): move startup retention into application (MIK-138)"
```

Open a dedicated PR, require exact-head `verify`, resolve every live finding, merge with a merge commit, and confirm green `main` before Task 2.

---

### Task 2: Introduce Consumer-Owned Session and Repository Ports

**Current responsibility:** Application use cases import concrete `SessionRegistry`, `InstructionStore`, and `OrchestratorStore`. `InstructionQueue` owns real delivery policy but cannot be tested without `as never` fakes or replaced infrastructure.

**Destination boundary:** Narrow capability ports under `src/orchestration/session/`, owned by the consuming use cases. No umbrella `SessionRegistryPort` is permitted.

**Allowed dependency direction:** orchestration use case -> orchestration port -> domain types; persistence/broker implementations -> orchestration port. `broker/main.ts` supplies structurally compatible implementations.

**Files:**
- Create: `src/orchestration/session/session-ports.ts`
- Modify: `src/broker/session-registry.ts`
- Modify: `src/orchestration/instruction-queue.ts`
- Modify: `src/orchestration/workflow-service.ts`
- Modify: `src/orchestration/worker-handoff-service.ts`
- Modify: `src/orchestration/worker-control-service.ts`
- Modify: `src/orchestration/orchestrator-manager.ts`
- Modify: `src/orchestration/agent-control-service.ts`
- Modify: `src/broker/worker-event-channel.ts`
- Modify: `src/broker/nvim-binding-service.ts`
- Modify: `src/orchestration/scout-wave-digest.ts`
- Test: `tests/orchestration/instruction-queue.test.ts`
- Test: `tests/orchestration/workflow-service.test.ts`
- Test: `tests/orchestration/worker-handoff-service.test.ts`
- Test: `tests/broker/worker-event-channel.test.ts`
- Test: `tests/broker/nvim-binding-service.test.ts`
- Modify: `tests/architecture/dependency-rule.test.ts`
- Modify: `docs/architecture/dependency-rule-baseline.json`

**Interfaces:**
- Consumes: `SessionRecord`, `WorkerTruth`, `OrchestratorBinding`, `InstructionRecord`, existing public registry method signatures.
- Produces: consumer-specific `SessionLookupPort`, `SessionStartPort`, `SessionResumePort`, `SessionProcessControlPort`, `WorkerTruthQueryPort`, `ScoutArtifactQueryPort`, `SessionUpdatePort`, `SessionInstructionPort`, `InstructionRepository`, and `OrchestratorBindingReader`.

- [ ] **Step 1: Replace permissive queue fakes with a failing structural contract**

Define the queue fake without `as never`:

```ts
const sessions = {
  get: vi.fn(),
  onControllerReleased: vi.fn(() => () => undefined),
  onDeliveryBoundary: vi.fn(() => () => undefined),
  onInstructionState: vi.fn(() => () => undefined),
  submitInstruction: vi.fn(),
} satisfies SessionInstructionPort;
```

Add an architecture regression asserting `instruction-queue.ts` has no static import containing `/broker/` or `/persistence/`.

- [ ] **Step 2: Prove the contract fails**

Run:

```bash
../../node_modules/.bin/vitest run --configLoader runner tests/orchestration/instruction-queue.test.ts tests/architecture/dependency-rule.test.ts
../../node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Expected: FAIL because the ports do not exist and `InstructionQueue` still imports broker/persistence implementations.

- [ ] **Step 3: Define narrow capability ports**

Move `InstructionDelivery`, `InstructionStateUpdate`, `WorkerWaitTarget`, `WorkerResultSnapshot`, and `WorkerWaitResult` out of the concrete registry module when they describe application contracts. Define method groups without a catch-all facade, for example:

```ts
export interface SessionLookupPort {
  get(sessionId: string): SessionRecord;
}

export interface SessionInstructionPort extends SessionLookupPort {
  onControllerReleased(listener: (sessionId: string) => void): () => void;
  onDeliveryBoundary(listener: (sessionId: string) => void): () => void;
  onInstructionState(listener: (update: InstructionStateUpdate) => void): () => void;
  submitInstruction(
    sessionId: string,
    message: string,
    source: "orchestrator" | "worker",
    metadata?: Record<string, unknown>,
    instructionId?: string,
  ): Promise<InstructionDelivery>;
}

export interface InstructionRepository {
  list(targetSessionId?: string): Promise<InstructionRecord[]>;
  put(record: InstructionRecord): Promise<void>;
}

export interface OrchestratorBindingReader {
  findBySessionId(sessionId: string): Promise<OrchestratorBinding | undefined>;
}
```

Use intersections at each constructor, such as `SessionLookupPort & SessionStartPort`, rather than growing one interface.

- [ ] **Step 4: Migrate one consumer at a time**

Update in this order, running its focused test after each change: `InstructionQueue`, `WorkflowService`, `WorkerHandoffService`, `WorkerEventChannel`, `NvimBindingService`, `OrchestratorManager`, `WorkerControlService`, `AgentControlService`, and `scout-wave-digest`. Remove duplicate local `{ get(...) }` interfaces and the unused `SessionRegistry` import in `worker-event-channel.ts`.

- [ ] **Step 5: Tighten the ratchet**

Delete the two sorted baseline entries:

```json
{"from":"src/orchestration/instruction-queue.ts","to":"src/persistence/instruction-store.ts"}
{"from":"src/orchestration/instruction-queue.ts","to":"src/persistence/orchestrator-store.ts"}
```

Do not add an orchestration-to-broker allowlist. The targeted test makes this migrated use case unable to regress while the broader broker/application split remains incremental.

- [ ] **Step 6: Verify the slice**

Run focused tests for every migrated consumer, then architecture, typecheck, and full suite. Expected baseline: exactly 76. No runtime behavior, schemas, record formats, or provider calls change.

- [ ] **Step 7: Commit, publish, review, and merge**

```bash
git add src/orchestration/session/session-ports.ts src/broker/session-registry.ts src/orchestration src/broker/worker-event-channel.ts src/broker/nvim-binding-service.ts tests docs/architecture/dependency-rule-baseline.json
git commit -m "refactor(orchestration): depend on session capability ports (MIK-139)"
```

Use the same exact-head review/verify/merge gate, then rebuild Task 3 on fresh `main`.

---

### Task 3: Extract the Worker Turn and Truth Engine

**Current responsibility:** `RuntimeSession` and `SessionRegistry` jointly own replay interpretation, composer state, instruction transitions, completion ledgers, canonical-turn reconciliation, stall detection, wait projection, preview/model refresh, and timers. These are application truth, not broker transport or process ownership.

**Destination boundary:** `WorkerTurnEngine`, one stateful application component per session. It owns all turn/instruction/projection state and consumes terminal/transcript observations through inward ports. It never sees attachment clients, provider launch specs, worktree provisioning, or Scout storage.

**Allowed dependency direction:** registry/lifecycle facade -> worker-turn engine -> domain + application ports; runtime terminal observation adapter and transcript persistence -> worker-turn ports; composition root constructs adapters.

**Files:**
- Create: `src/orchestration/session/worker-turn-ports.ts`
- Create: `src/orchestration/session/worker-turn-engine.ts`
- Create: `src/runtime/worker-turn-observation-adapter.ts`
- Modify: `src/broker/session-registry.ts`
- Modify: `src/broker/main.ts`
- Modify: `src/persistence/thread-transcript-store.ts`
- Test: `tests/orchestration/session/worker-turn-engine.test.ts`
- Modify: `tests/broker/session-registry.test.ts`
- Modify: `tests/integration/instruction-delivery-truth.test.ts`
- Modify: `tests/integration/wait-deadline-recovery.test.ts`
- Modify: `docs/architecture/dependency-rule-baseline.json`

**Interfaces:**
- Consumes: `SessionRecord`, `WorkerTruth`, `InstructionDelivery`, `InstructionStateUpdate`, `SessionRuntime.snapshot()`, transcript turn/message/model reads.
- Produces: `WorkerTurnEngineFactory.create(record, replayChars)`, engine methods `appendOutput`, `resetReplay`, `submitInstruction`, `projectTruth`, `waitResult`, `stopPendingInstructions`, `releaseTimers`, and read-only `completedTurns`, `canonicalTurns`, `latestResult`, `providerLimit` accessors.

- [ ] **Step 1: Write engine-level failing state-machine tests**

Create tests that instantiate the engine with recording ports and prove:

```ts
it("never settles an instruction from a turn completed before it was rendered", async () => {
  engine.recordCompletion(1, "older answer", "provider-transcript");
  engine.noteRenderedInstruction({ instructionId: "i-1", expectedTurn: 2, renderedAt: now });
  expect(engine.waitResult(1)).toMatchObject({ status: "working" });
});

it("holds delivery while the composer or a modal is occupied", async () => {
  observations.composer = { occupied: true, modalOpen: true };
  engine.appendOutput(Buffer.from("approval dialog"), replay);
  expect(await engine.submitInstruction(input)).toMatchObject({ state: "queued" });
});

it("banks provider transcript turns with canonical provenance", async () => {
  transcripts.captureProviderTurns.mockResolvedValue([{ text: "canonical" }]);
  await engine.reconcileCanonicalTurns();
  expect(engine.waitResult(1)).toMatchObject({
    status: "completed",
    provenance: "provider-transcript",
    text: "canonical",
  });
});
```

- [ ] **Step 2: Prove the engine tests fail before the boundary exists**

Run the new test file and typecheck. Expected: module/interface not found.

- [ ] **Step 3: Define infrastructure-neutral observation and transcript ports**

The replay port exposes only the six operations actually used today:

```ts
export interface ReplayObservation {
  appendBytes(chunk: Buffer): void;
  reset(replay: string): void;
  frameText(): string;
  strippedTail(maxChars: number): string;
  tokenCount(): number | undefined;
  readonly version: number;
}

export interface WorkerTurnObservationPort {
  createReplay(replayChars: number): ReplayObservation;
  activity(provider: string, replay: ReplayObservation): ProviderTerminalActivity;
  composer(provider: string, replay: ReplayObservation): ComposerObservation;
  fatalTermination(tail: string, at: string): SessionTermination | undefined;
  compactFrame(frame: string): string;
  compactTerminal(replay: string): string;
  fallbackTerminal(replay: string): string;
  truncateResult(text: string, maxChars: number): string;
}
```

Define transcript reads/appends as application ports using application/domain types. `worker-turn-observation-adapter.ts` delegates byte-for-byte to the existing runtime functions; it contains no new heuristics.

- [ ] **Step 4: Move state ownership into `WorkerTurnEngine`**

Move these `RuntimeSession` fields together: replay, activity, observedWorking, completed/canonical turn counts, instruction floor/rendered queue, composer/delivery hold, provider limit, latest result, fatal flag, completion ledger, idle/canonical timers, turn-capture ownership, suppressed-turn flag, and stall observation.

Move the methods that exclusively govern those fields, including `deliveryHold`, `terminalDelivery`, `holdInstruction`, `projectTruth`, worker-result projection, completion recording, composer observation, rendered-instruction advancement, screen banking, canonical reconciliation, preview/model refresh, stall observation, and turn-timer cleanup. Side effects leave through injected callbacks for persistence, events, transcripts, instruction-state notification, delivery-boundary notification, and session-update notification.

- [ ] **Step 5: Replace the mutable field cluster in `RuntimeSession`**

`RuntimeSession` keeps lifecycle/process/attachment/Scout fields and adds one property:

```ts
interface RuntimeSession {
  record: SessionRecord;
  sessionRuntime?: SessionRuntime;
  turns: WorkerTurnEngine;
  controller?: Controller;
  watchers: Map<string, Watcher>;
  // lifecycle and Scout fields only
}
```

Registry methods delegate to `runtime.turns`; no engine method receives `RuntimeSession`.

- [ ] **Step 6: Remove obsolete outward imports and baseline entries**

Remove `session-registry.ts` imports of `composer-state`, `conversation-preview`, `observed-model`, `replay-digest`, `session-liveness`, and `terminal-replay`. Delete the six matching baseline entries. If the concrete transcript-store import is removed by the port, delete that baseline entry too. Expected baseline: 70 or lower; no new baseline entry is permitted.

- [ ] **Step 7: Verify behavior and size**

Run engine tests, registry tests, instruction truth integration, wait recovery integration, all runtime interpretation tests, architecture, typecheck, and full suite. Compare public registry method signatures and broker schemas before/after. Record `wc -l`; target `session-registry.ts <= 2,700` without moving blank lines/comments merely to hit the number.

- [ ] **Step 8: Commit, publish, review, and merge**

```bash
git add src/orchestration/session src/runtime/worker-turn-observation-adapter.ts src/broker/session-registry.ts src/broker/main.ts src/persistence/thread-transcript-store.ts tests docs/architecture/dependency-rule-baseline.json
git commit -m "refactor(sessions): extract worker turn truth engine (MIK-140)"
```

Require an independent adversarial review focused on stale completion replay, lifecycle races, modal/composer transitions, and canonical-vs-terminal provenance before merge.

---

### Task 4: Extract Workspace Preparation and Verification

**Current responsibility:** Registry validates cwd with filesystem APIs, provisions/rolls back worktrees, single-flights repository state hashing, and verifies Scout immutability alongside unrelated lifecycle code.

**Destination boundary:** `SessionWorkspaceCoordinator` owns validation, provisioning/rollback, and state capture. It consumes existing `WorktreeProvisioner` plus two narrow ports; it returns facts for the registry to journal rather than owning event publication.

**Allowed dependency direction:** session lifecycle -> workspace coordinator -> domain workspace contracts; runtime/provider adapters -> workspace ports; composition root constructs the coordinator.

**Files:**
- Create: `src/orchestration/session/session-workspace-coordinator.ts`
- Create: `src/runtime/session-workspace-adapter.ts`
- Modify: `src/broker/session-registry.ts`
- Modify: `src/broker/main.ts`
- Test: `tests/orchestration/session/session-workspace-coordinator.test.ts`
- Modify: `tests/broker/session-registry.test.ts`
- Modify: `tests/broker/scout-session.test.ts`
- Modify: `docs/architecture/dependency-rule-baseline.json`

**Interfaces:**
- Consumes: `StartSessionRequest`, `ProvisionedWorktree`, `WorktreeProvisioner`, existing workspace-state hash function.
- Produces: `validate(cwd)`, `provision(request, sessionId)`, `discard(provisioned)`, and single-flight `captureState(cwd)`.

- [ ] **Step 1: Write coordinator failures first**

Cover inaccessible cwd, absent provisioner, provision failure mapping, non-force rollback after downstream failure, and two concurrent state reads sharing one capture promise. Assert exact existing error codes/messages.

- [ ] **Step 2: Implement the inward coordinator**

Use explicit ports:

```ts
export interface SessionCwdAccess {
  validate(cwd: string): Promise<void>;
}

export interface WorkspaceStateReader {
  capture(cwd: string): Promise<string>;
}
```

The runtime adapter owns `realpath`/`stat` and delegates repository hashing to the existing implementation. The coordinator owns its in-flight map and worktree rollback rules.

- [ ] **Step 3: Route registry start and Scout verification through the coordinator**

Replace `validateCwd`, `worktreeProvisioner`, `scoutWorkspaceState`, `scoutWorkspaceStateInflight`, `provisionWorkspace`, and `validateSessionCwd` in the registry. Keep the exact ordering: validate -> admission -> reserve -> Scout drop-box init -> provision -> baseline capture -> provider spawn; journal provisioning before returning success; discard only a worktree created for a start that failed.

- [ ] **Step 4: Tighten and verify**

Delete the registry-to-`providers/cursor/workspace-state.ts` baseline edge. Run the new unit tests, registry provisioning tests at `252-349`, Scout canary tests, architecture, typecheck, full suite. Target registry size `<= 2,550` and baseline `<= 69`.

- [ ] **Step 5: Commit, publish, review, and merge**

```bash
git add src/orchestration/session/session-workspace-coordinator.ts src/runtime/session-workspace-adapter.ts src/broker/session-registry.ts src/broker/main.ts tests docs/architecture/dependency-rule-baseline.json
git commit -m "refactor(sessions): isolate workspace preparation (MIK-141)"
```

Review must specifically prove rollback, base/cwd selection, and Scout pre/post hash ordering remain unchanged.

---

### Task 5: Extract the Scout Session Supervisor

**Current responsibility:** Registry owns Scout trace/capture tails, budget timers, cutoff/finalization flags, card promotion, canary verification, launch-failure preservation, recovery, and report-store access.

**Destination boundary:** `ScoutSessionSupervisor`, one optional stateful component per Scout session. It owns Scout-only runtime state and consumes report/workspace/persistence/event callbacks through inward ports. Ordinary workers never instantiate it.

**Allowed dependency direction:** session lifecycle -> Scout supervisor -> domain/application ports; `ScoutReportStore` and workspace adapters implement ports; composition root creates the factory.

**Files:**
- Create: `src/orchestration/session/scout-session-ports.ts`
- Create: `src/orchestration/session/scout-session-supervisor.ts`
- Modify: `src/broker/session-registry.ts`
- Modify: `src/broker/main.ts`
- Modify: `src/persistence/scout-report-store.ts`
- Test: `tests/orchestration/session/scout-session-supervisor.test.ts`
- Modify: `tests/broker/scout-session.test.ts`
- Modify: `tests/broker/session-registry.test.ts`
- Modify: `tests/broker/thread-durability.test.ts`
- Modify: `docs/architecture/dependency-rule-baseline.json`

**Interfaces:**
- Consumes: `ScoutRuntimeState`, `ScoutDecisionCard`, `ScoutReportCapture`, `ScoutArtifactRead`, workspace coordinator state reads, runtime kill/snapshot callbacks.
- Produces: `initialize`, `readArtifact`, `decisionCard`, `onOutput`, `armBudget`, `finalize`, `preserveLaunchFailure`, `recover`, `dispose`, and read-only completion/latest-result projection.

- [ ] **Step 1: Write supervisor state-machine tests first**

Cover: valid card capture triggers one expected SIGTERM; trace persistence failure fails verification; workspace hash mismatch fails canary; budget cutoff persists before kill and cannot later promote output; valid report after restart recovers completion; duplicate exit paths finalize once.

- [ ] **Step 2: Define the report port and supervisor-owned state**

The port is exactly the current used surface:

```ts
export interface ScoutReportPort {
  initialize(sessionId: string, cwd: string): Promise<ScoutRuntimeState>;
  capture(scout: ScoutRuntimeState, replay: string): Promise<ScoutReportCapture>;
  collect(scout: ScoutRuntimeState): Promise<ScoutReportCapture>;
  appendTrace(scout: ScoutRuntimeState, chunk: Buffer): Promise<void>;
  readArtifact(scout: ScoutRuntimeState, kind: ScoutArtifactKind, cursor: number, maxBytes: number): Promise<ScoutArtifactRead>;
  remove(sessionId: string): Promise<void>;
}
```

Move all Scout-only timers, tails, failure strings, flags, and card state out of `RuntimeSession` into the supervisor.

- [ ] **Step 3: Move complete Scout behaviors, not forwarding helpers**

Move headless finalization, failure marking, launch preservation/failure, trace append, report capture/apply, budget arm/exhaustion, and recovery. The supervisor receives callbacks for record persistence, broker events, transcript lifecycle entries, session updates, workspace-state capture, process kill, and raw replay. It never receives the whole mutable runtime aggregate.

- [ ] **Step 4: Rewire registry lifecycle hooks**

Start creates a supervisor only after profile validation. Output calls `supervisor.onOutput`; headless exit awaits `supervisor.finalize`; delete/retention remove reports through the port; recovery invokes the supervisor before `ready()` resolves. Keep `handleExit` as the canonical lifecycle transition after Scout finalization returns its terminal outcome.

- [ ] **Step 5: Remove concrete imports and verify**

Remove registry imports of `ScoutReportStore`, `ScoutReportCapture`, `ScoutArtifactRead`, and direct workspace hashing. Delete the remaining registry-to-`persistence/scout-report-store.ts` baseline entry. Run supervisor tests, all Scout tests, registry/durability tests, architecture, typecheck, and full suite. Target `session-registry.ts <= 2,050`, baseline `<= 68`, and no Scout field outside the supervisor except durable `SessionRecord.scout`.

- [ ] **Step 6: Commit, publish, review, and merge**

```bash
git add src/orchestration/session/scout-session-ports.ts src/orchestration/session/scout-session-supervisor.ts src/broker/session-registry.ts src/broker/main.ts src/persistence/scout-report-store.ts tests docs/architecture/dependency-rule-baseline.json
git commit -m "refactor(scout): extract session supervisor (MIK-142)"
```

Require independent review of budget/cutoff races, duplicate exits, mutation canary ordering, durable trace failure, restart recovery, and terminal-state projection.

---

### Task 6: Close the Architecture Programme and Establish MIK-91 Readiness

**Current responsibility:** The preceding PRs land neutral boundaries; documentation and Linear must state what owns each concern and what MIK-91 still requires from Brandon.

**Destination boundary:** Filesystem ownership and Linear dependency graph clearly describe session truth, workspace, Scout, infrastructure adapters, composition, and the MIK-91 consultation gate.

**Allowed dependency direction:** Documentation records the code as landed; it does not authorize new runtime features.

**Files:**
- Modify: `docs/architecture/mik-94-decomposition-proposal.md`
- Modify: `docs/architecture/dependency-rule.md`
- Modify: `docs/architecture/session-model.md`
- Modify: `docs/architecture/scout-profile.md`
- Create: `docs/architecture/session-registry-decomposition.md`

**Interfaces:**
- Consumes: final merged SHAs, final baseline count, final `wc -l`, final import graph, Linear issue relations.
- Produces: responsibility matrix, allowed dependency diagram, migration record, MIK-91 readiness statement with explicit consultation exclusions.

- [ ] **Step 1: Measure the final tree**

Record largest files, registry line/method/field/import counts, baseline count and exact remaining registry violations. Confirm only lifecycle/catalog, process adoption, attachment routing, and compatibility facade responsibilities remain.

- [ ] **Step 2: Write the architecture record**

Document before/after ownership, each inward port and outer implementation, why rejected generic facades were not introduced, and the remaining suspected seams. State explicitly that MIK-91 may now design against neutral session/runtime/workspace boundaries but still requires Brandon consultation before any executor, telemetry, privacy, permission, dependency, cost, or lifecycle decision.

- [ ] **Step 3: Update Linear in dependency order**

Mark each slice issue Done only after its merge commit is on `main`; link the slice chain with `blockedBy`/`blocks`; comment on MIK-94 and MIK-133 with prerequisite SHAs; comment on MIK-91 with the landed neutral seams and its unchanged consultation gate. Remove no existing MIK-91 safeguards and create no SBX/Sentry/Promptfoo child implementation issue.

- [ ] **Step 4: Run final verification from fresh `main`**

```bash
../../node_modules/.bin/tsc -p tsconfig.json --noEmit
../../node_modules/.bin/vitest run --configLoader runner tests/architecture/dependency-rule.test.ts
../../node_modules/.bin/vitest run --configLoader runner tests/orchestration tests/broker tests/integration
../../node_modules/.bin/vitest run --configLoader runner
```

If the known shell-stream test fails under load, run only that test once and report both results. No other failure is waived.

- [ ] **Step 5: Publish and merge the documentation closeout**

```bash
git add docs/architecture
git commit -m "docs(architecture): record session decomposition (MIK-143)"
```

Open a docs-only PR, require exact-head `verify` and normal review, and merge with a merge commit.

- [ ] **Step 6: Produce the final SITREP**

Report the full Phase 1/2/3 merge order and SHAs; delayed findings; PR #82 and 850 -> 90 byte result; exact verification; slice PRs; registry before/after profile; folder ownership; baseline 103 -> final; Linear issues/relations; MIK-91 readiness; and every rejected/deferred/suspect item.

## Self-Review

- Spec coverage: composition, application ports, session truth, workspace, Scout, dependency direction, behavior preservation, tests, Linear, and MIK-91 consultation are each mapped to a task.
- Placeholder scan: implementation steps name exact files, interfaces, tests, expected failures, verification commands, measurable outcomes, and the already-created Linear identifiers MIK-137 through MIK-143.
- Type consistency: `SessionInstructionPort`, `ReplayObservation`, `WorkerTurnObservationPort`, `SessionCwdAccess`, `WorkspaceStateReader`, and `ScoutReportPort` are defined once and consumed consistently by later tasks.
- Scope check: every task is independently reviewable and testable; worker truth, workspace, and Scout state do not edit the same hot spot concurrently.

Execution is already authorized by the operator's mission. Use sequential subagent-driven implementation with two-stage review per slice; do not pause to ask for an execution mode.
