# Implementation plan (MIK-257)

Branch: `brandonaron38/mik-257-peer-orchestrator-approval` cut from `origin/main` at `f1619a5` or later.
Worktree: Cyberdeck-provisioned, `~/code/personal/cyberdeck-worktrees/orc-peer-approval`.
Workers cannot commit inside linked worktrees: the Orc commits on the host with the full gate green.
Node 24.18.0 (`/Users/brandon/.local/share/mise/installs/node/24.18.0/bin` first in PATH); the host
default Node 26 is outside the engine range.

Gate for every commit: `pnpm check`, full `pnpm test`, `tests/architecture/dependency-rule.test.ts`
and the file-size ratchet green. `src/orchestration/agent-control-service.ts` is at its ceiling; all
new logic goes in `orchestrator-peer-service.ts` and `src/domain/orchestrator.ts`.

## T1. Domain (`src/domain/orchestrator.ts`)

- Add `PeerApprovalSchema` (`kind`, `quote` 1..500 trimmed, `channel`, optional `grantedAt` ISO) and its
  type; export from the domain barrel if one exists.
- Delete `MAX_LIVE_PEERS_PER_CREATOR`.
- `peerGrantCapabilities` returns `[...creator]`; rewrite its doc comment (D4).
- Binding `createdBy`: add `approval: PeerApprovalSchema.optional()` and `depth: z.number().int().nonnegative().optional()`.
- `CreatePeerOrchestratorRequestSchema.createdBy`: same two fields.

## T2. Service (`src/orchestration/orchestrator-peer-service.ts`)

- `AgentCreateOrchestratorParamsSchema`: `approval: PeerApprovalSchema.optional()`.
- Remove `maxLivePeers` from deps and the constructor, `livePeerIds()`, the `PEER_LIMIT` result type and
  its admission branch. Keep the per-actor serialization and the `mutationId` replay exactly as they are.
- `admission()`: after `ACTOR_NOT_ACTIVE`, before the capability check:
  `if (request.approval === undefined) return { outcome: "APPROVAL_REQUIRED", reason: "..." }` (D2 text).
  Audit it like the other refusals that reach `record()`.
- `decide()`: `depth = (binding.createdBy?.depth ?? 0) + 1`; pass `approval` and `depth` inside
  `createdBy` to `manager.createPeer`; add `approval` and `depth` to the `orchestrator.create.requested`
  payload; add `createdBy: { sessionId: actor, depth, approval }` to the `CREATED` result (keep the
  existing top-level `createdBy: actor` string only if a test or Fleet reads it; otherwise replace).

## T3. Manager (`src/orchestration/orchestrator-manager.ts`)

`createPeer` already copies `createdBy` onto the binding; confirm the new fields survive
`OrchestratorBindingSchema.parse` and the binding log round trip. No logic change expected.

## T4. MCP and prompt

- `src/mcp/server.ts`: `cyberdeck_orchestrator_create` description per 00-spec; `inputSchema.properties.approval`
  object with `kind` enum, `quote` (minLength 1, maxLength 500), `channel` enum, `grantedAt` string; not in
  `required`. The dispatcher still strips caller-supplied `actorSessionId` (keep the MIK-256 test).
- `src/orchestration/orchestrator-prompt.ts`: both branches of `peerCreation` become the D5 text; the
  "created by another orchestrator" branch keeps telling a peer who created it but no longer says it
  cannot create peers. Add one sentence: `cyberdeck_thread_message` reaches a peer you created.

## T5. Inspect and Fleet

- Verify `cyberdeck_orchestrator_inspect` returns `createdBy` (sessionId, depth, approval). If the
  inspect projection does not include the binding's `createdBy` today, add it there, not in
  `agent-control-service.ts` body logic (projection helper or the binding itself).
- Verify Fleet's orchestrator rows show the creator. If absent, leave a note in the PR; do not grow
  Fleet files past their ratchets for this slice.

## T6. CLI

`cyberdeck orchestrator peer-create status` output: append "approval: required per create (operator
quote journaled)". Optional; skip if it costs a ratchet.

## T7. Tests (`tests/orchestration/orchestrator-peer-service.test.ts` and friends)

Replace: "caps live peers per creator…", "does not count an errored peer…", "does not count peers
another orchestrator created", and retitle "serializes concurrent creates from one actor so the cap
cannot be raced" to describe replay, keeping its serialization assertion.

Add:
1. create without `approval` → `APPROVAL_REQUIRED`, manager never called, refusal audited;
2. create with per-create approval → `CREATED`; requested audit carries `approval`; binding and result
   carry `createdBy.{approval, depth: 1}`;
3. a peer created with approval holds `orchestrator.create` (grant equals creator's) and can create a
   third orchestrator: depth 2;
4. three live peers from one creator all succeed;
5. standing approval is accepted and journaled with `kind: "standing"`;
6. `grantAllows`/`InstructionQueue.enqueue`: a fleet creator may enqueue to a peer orchestrator session
   (one test in the instruction-queue or capability suite);
7. `tests/mcp/server.test.ts`: schema exposes `approval`, description mentions APPROVAL_REQUIRED and no
   PEER_LIMIT;
8. prompt test: creator and peer text contain the ask-first sentence.

`grep -rn "PEER_LIMIT\|MAX_LIVE_PEERS\|cannot create peers" src tests docs README.md CLAUDE.md` must be empty.

## T8. Docs

- `docs/architecture/orchestrator-peer-create.md`: status line, policy list (replace items 1 and 4, add
  approval and lineage depth), tool table (`approval`), outcomes, the D7 sentence.
- `CLAUDE.md`: MIK-98 paragraph, "the one sanctioned narrowing" sentence.
- `README.md`: operator note under the peer-create toggle: what approval means and that it is journaled.
- `CHANGELOG.md`: entry under Unreleased.

## Order

T1 → T2 → T4 → T7 (red to green as you go) → T3/T5 verification → T8. One worker; the reviewer starts
when the worker's handoff report lands at `handoffs/orchestrator-peer-create-addendum/reports/worker.md`.
