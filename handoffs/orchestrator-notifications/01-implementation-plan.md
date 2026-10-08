# Orchestrator notification feed: implementation plan

> **For agentic workers:** execute one bounded task at a time in an isolated worktree with separate test state, socket and identity. The live broker serves other orchestrators; never restart it or touch `~/Library/Application Support/Cyberdeck` while implementing. Repository instructions keep Superpowers workflows opt-in. Read [00-spec.md](00-spec.md) and [02-acceptance.md](02-acceptance.md) before your task.

**Goal:** an orchestrator keeps working after `cyberdeck_workers_start` and is told, through a one-line notice, when a worker it controls settles, blocks, asks for a decision, or loses an instruction; it drains details with one tool call. Works for Claude, Codex and Cursor orchestrators and any worker provider.

**Architecture:** broker-side producer → durable per-controller inbox → two delivery channels (tool-result piggyback while busy, instruction-queue wake while idle) → one drain tool; provider hooks as an enhancement layer that must degrade to the universal channels.

**Stack:** existing TypeScript/Node, pnpm, Vitest, JSONL persistence, zod schemas. No new dependencies expected.

Items marked **PENDING** are implementation details deliberately left to the owning worker or to the spike; everything else is decided.

## Global constraints

- One truth: every state a notification reports comes from `projectWorkerTruth`, `WorkerCoordinationService.projectEvents`, and instruction records. No private readings.
- Bounded everything: summaries ≤512 chars, notices ≤200 chars (≤400 with one inlined critical summary), ≤50 records per drain, hard cap of unacknowledged records per controller (**PENDING**: pick with the same reasoning as the worker-event active-queue limit).
- At-least-once, acknowledged by cursor, fsynced before the next page. Never a silent drop; drops are counted and reported.
- Human control priority and the dependency rule (`docs/architecture/dependency-rule.md`) and file-size ratchets stay enforced. New files go where the architecture baseline allows; check before creating.
- The Orc owns edits to `src/broker/main.ts`, `src/mcp/server.ts` tool registrations, `src/protocol/*`, shared domain schemas, and `orchestrator-manager.ts` prompt text. Workers propose patches to those through the Orc.

## Ownership and order

| Task | Owner | Depends on | Reviewable result |
| --- | --- | --- | --- |
| S: provider hook spike | Worker S (Codex or Claude), read-mostly | none | Verified matrix of what each installed provider actually does with `PostToolUse`/`Stop`/`asyncRewake`/`followup_message`; recorded in `docs/architecture/provider-parity.md` |
| A: domain + persistence | Worker A | none | `OrchestratorNotification` schema, inbox store with replay tests |
| B: producer | Worker B | A | Broker service that turns truth transitions, worker events, instruction states, budget and handoff state into inbox records with coalescing and routing |
| C: delivery | Worker B or Orc | A, B | Notice file, tool-result piggyback, instruction-queue wake with coalescing, wake budget, withdrawal on busy |
| D: control plane | Orc | A | Broker RPC `agent.notifications.read|configure`, MCP tools, CLI `cyberdeck notifications notice|read|configure` |
| E: provider hooks | Worker S | S, C, D | Claude `--settings` hooks, Codex managed `hooks.json` entries, Cursor decision |
| F: prompt + docs | Orc | C, D | Orchestrator prompt text, `docs/architecture/orchestrator-notifications.md`, README section, CHANGELOG |
| G: acceptance | Orc + fresh reviewer | all | Evidence per [02-acceptance.md](02-acceptance.md) |

S and A start together. B, C, D follow A. E waits for S and D. Two implementation workers at once is the ceiling while the host also runs other fleets.

## Shared interface contract

Decided now so the tasks can proceed in parallel. Names are planning names; adjust together with every consumer if the architecture check forces a move.

### Domain (`src/domain/orchestrator-notification.ts`, Task A)

```ts
export const NotificationKindSchema = z.enum([
  "settled", "intervention", "attention", "delivery", "risk", "progress", "budget", "handoff",
]);
export const OrchestratorNotificationSchema = z.object({
  id: z.uuid(),
  cursor: z.number().int().positive(),          // per controller, monotonic
  controllerId: z.string().min(1),              // orchestratorController(binding).controllerId
  kind: NotificationKindSchema,
  severity: WorkerEventSeveritySchema,          // reuse
  sessionId: z.uuid(),                          // the worker session
  workerId: z.string().optional(),
  taskId: z.string().optional(),
  waveId: z.string().optional(),
  completionTarget: z.number().int().positive().optional(),  // for settled
  summary: z.string().min(1).max(512),
  refs: z.array(z.string()).max(8).default([]), // eventId, instructionId, scout:// handles
  wakeEligible: z.boolean(),
  createdAt: z.iso.datetime(),
  noticedAt: z.iso.datetime().optional(),
  deliveredVia: z.array(z.enum(["tool-result", "hook", "wake", "wait"])).default([]),
  acknowledgedAt: z.iso.datetime().optional(),
  schemaVersion: z.literal(1),
});
export const NotificationPolicySchema = z.object({
  wake: z.enum(["all", "steering-only", "off"]).default("steering-only"),
  quietMinutes: z.number().int().min(1).max(120).default(10),
  maxWakesPerHour: z.number().int().min(0).max(120).default(12),
  coalesceMs: z.number().int().min(0).max(60_000).default(3_000),
});
```

Notice shape (what crosses into the model):

```ts
export interface Notice {
  pending: number;
  byKind: Partial<Record<NotificationKind, number>>;
  oldestAgeSeconds: number;
  inline?: { kind: NotificationKind; severity: string; summary: string }; // ≤400 chars total
  drain: "cyberdeck_notifications_read";
}
```

### Persistence (`src/persistence/orchestrator-notification-store.ts`, Task A)

Append-only JSONL `orchestration/orchestrator-notifications-v1.jsonl`, one fsynced record per mutation (`append`, `acknowledge`, `drop`, `policy`), replay to latest state, fail closed on corrupt records exactly like the coordination log. Ports: `append`, `listPending(controllerId, afterCursor, limit)`, `acknowledgeThrough(controllerId, cursor)`, `policy(controllerId)`, `setPolicy`, `noticeState(controllerId)` / `markNoticed`.

### Producer (`src/broker/orchestrator-notification-service.ts`, Task B)

Inputs, all existing: registry lifecycle/truth transitions (**PENDING**: identify the registry bus surface the enforcer and reconciler already subscribe to and extend `session-ports.ts` only if nothing fits), `WorkerCoordinationService.submitEvent` outcomes (wrap or subscribe; do not fork the event path), `onInstructionState` for `undelivered` and `queued/human-controller`, budget enforcer soft-limit, handoff pending transitions, scout wave digest completion. Lease lookup resolves `controllerId`; records for a worker with no live controller go to the orphan family and surface on adoption.

Coalescing: `progress` and `stalled` keep the latest per worker (replace, do not append); `settled` is keyed by `(sessionId, completionTarget)` and written once.

### Delivery (`src/broker/orchestrator-notification-delivery.ts`, Task C)

- `noticeFor(controllerId)` builds the Notice; `shouldNotice` applies the debounce (`lastNoticedCursor`, `quietMinutes`).
- Notice file: `<state>/orchestrators/<sessionId>/notice.json` rewritten atomically on every inbox change for the controller's bound session; deleted when empty.
- Piggyback: `server.ts` `tools/call` appends `{cyberdeckNotice: Notice}` after the result when `shouldNotice`; `cyberdeck_notifications_read` itself never gets one.
- Wake: on inbox change with a wake-eligible record and policy allowing it, after `coalesceMs`, `enqueueBroker({targetSessionId: orchestratorSession, messageId: uuidv5("notice:" + controllerId + ":" + cursor)})`. The message text is the notice rendered for a human-readable composer line, prefixed `[cyberdeck notice]`. Withdrawal: if the orchestrator's truth is `working` when the record is still `accepted|queued`, cancel it (**PENDING**: confirm `cancelled` is reachable from the queue API; `docs/architecture/worker-truth.md` lists `accepted/queued --withdrawn--> cancelled`). Wake counter per rolling hour; exceeding `maxWakesPerHour` records one `budget` notification and suppresses further wakes until the window moves.

### Control plane (Task D)

Broker RPC: `agent.notifications.read {actorSessionId, cursor?, limit?, acknowledgeThrough?, kinds?, severities?}` and `agent.notifications.configure {actorSessionId, policy}`; authority through the same orchestrator binding lookup `waitForWorkers` uses, `thread.read` capability per worker session in the page.

MCP tools in `src/mcp/server.ts` and `worker-input-schemas.ts`:
- `cyberdeck_notifications_read` → `{notifications, nextCursor, pending, dropped, policy}`; a `settled` record embeds the bounded result the registry's `waitForWorkerResults` would return for that single target with `retrieval: "notification"`.
- `cyberdeck_notifications_configure` → the stored policy.

CLI (`src/cli/notifications.ts`): `cyberdeck notifications notice --actor-session <id> [--format claude|codex|cursor]` prints the provider-specific hook JSON from the notice file (no broker connection, exit 0 always, empty output when nothing pending); `read` and `configure` for operators and for debugging.

### Provider hooks (Task E, shaped by S)

- Claude: extend `claudeLaunchSettings` with `PostToolUse` (matcher `.*`) and, depending on S, `Stop` or an `asyncRewake` hook, all invoking the CLI with the fixed `--actor-session` exactly as the transcript hook does. Orchestrator-only.
- Codex: extend the managed `hooks.json` written by `CodexOrchestratorHome.prepareFirstPartyConfiguration` with `PostToolUse` and `Stop` entries carrying the same CLI command; keep the operator's own hooks and the headroom filter intact.
- Cursor: per S and spec open question 3. Default v1: no Cursor hooks; tier A only.

### Prompt and docs (Task F)

`orchestrator-manager.ts:444-445`: replace with the feed contract from spec 5.6, keeping the `wait.state` vocabulary paragraph. New `docs/architecture/orchestrator-notifications.md`. `docs/architecture/provider-parity.md` gets the hook matrix from S. README gets a short "Notifications" section next to "Bounded workflows". CHANGELOG entry.

## Task briefs

### Task S: hook spike (first, alone)

Run disposable Claude, Codex and Cursor sessions outside the broker with a throwaway hooks config whose command appends to a log and returns a fixed `additionalContext` / `followup_message`. Answer, per provider and installed version: does `PostToolUse` inject on MCP tool calls; does it inject on native tools; does `Stop`/`stop` continue the turn and with what text; does Claude `asyncRewake` wake an idle session; what is the latency; what breaks when the hook prints nothing. Record the matrix. Do not touch the operator's real hook files; use `--settings` for Claude, a scratch `CODEX_HOME` for Codex, and a scratch project directory for Cursor.

### Task A: domain + store

Schemas above, store with replay and corruption tests modelled on the coordination log tests. No wiring into `main.ts`.

### Task B: producer

Service and unit tests with fake registry and coordination inputs: each row of spec 5.2 produces exactly the expected record; coalescing; routing by lease; orphan family; transfer semantics.

### Task C: delivery

Notice builder, debounce, notice file, piggyback hook in `server.ts` (Orc applies), wake scheduling against a fake `InstructionQueue`, withdrawal, wake budget. Tests cover the timing table in acceptance.

### Task D: control plane

RPC, MCP tools, CLI, schema docs in tool descriptions. Integration test through `handleMcpRequest` with a scripted broker.

### Task E: hooks

Per S. Tests assert the generated settings/hooks JSON exactly, as `launch-settings` tests do today.

### Task F: prompt + docs

### Task G: acceptance

Per [02-acceptance.md](02-acceptance.md), on a separate test broker first, then one supervised live run with a Claude orchestrator and a Codex worker, then a Codex orchestrator.
