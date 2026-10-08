# Orchestrator-created peers

> **Status: IMPLEMENTED (MIK-256, approval addendum MIK-257); activation is operator-owned.** Slice 1 of MIK-254. Tracks `cyberdeck_orchestrator_create`
> and the `orchestrator.create` capability. The successor handoff packet, lease inheritance and
> predecessor retirement in MIK-254 are later slices and are not described here.

## Problem

Every orchestrator Cyberdeck launches starts with the provider's Remote Control surface attached,
so a running orchestrator can be steered from a phone. A *new* orchestrator cannot be started that
way: `orchestrator.create` is a Fleet-only broker method, and Fleet is a terminal UI. When the
operator is away from the keyboard and the current orchestrator is spent, rate-limited or the
wrong provider, orchestration stops until someone is back at the machine.

## What exists

The broker already starts a distinct bound peer through `OrchestratorManager.create`: it validates
the provider and model against the orchestrator catalog, resolves the permission plan, starts a
detached session with `kind: "orchestrator"`, writes a `:peer:` binding with its own controller
identity (MIK-98), and the Claude and Codex adapters launch that session with Remote Control on.
Nothing about Remote Control changes in this slice.

`cyberdeck_orchestrator_create` supplies the orchestrator-reachable, grant-gated path, with express
operator approval required on every create.

## The capability

`orchestrator.create` is added to `CyberdeckCapabilitySchema` and to
`ORCHESTRATOR_GRANT_CAPABILITIES`, so it is **on by default** for every binding the manager writes
from now on. The operator turns it off or back on per scope with a durable toggle on the scope's
primary binding, through the same grant-toggle path as `fable-workers`:

```bash
cyberdeck orchestrator peer-create status
cyberdeck orchestrator peer-create on
cyberdeck orchestrator peer-create off
```

Bindings written before this capability existed do not carry it. They keep resuming as they are;
one `peer-create on` for that scope adds it. There is no migration on read, because a missing
entry cannot be told apart from one the operator switched off.

`peer-create off` blocks every fresh create by the scope's primary, existing peers and their
descendants, even when their own durable grants retain `orchestrator.create`. Admission reads the
scope's primary binding afresh on every create. Turning it back on resumes creation only for callers
whose own grants allow it; legacy narrowed peer grants remain narrowed.

The toggle does not supply approval: every create must quote the operator's express approval from
the current conversation. Peers inherit their creator's capabilities unchanged and may create peers
under the same rule, with no live-peer cap or depth limit. MIK-256 peers retain their durable narrowed
grants and legacy lineage without approval/depth; retire and recreate them to gain the full grant.

## The tool

`cyberdeck_orchestrator_create` reaches `agent.orchestrator.create` on the broker, which is served
by `OrchestratorPeerService` (application layer, `src/orchestration/orchestrator-peer-service.ts`).

Inputs:

| field | required | meaning |
| -- | -- | -- |
| `provider` | yes | `claude`, `codex` or `cursor`: the providers the orchestrator catalog can host the MCP server in |
| `model` | yes | provider-native model id, validated against the orchestrator catalog |
| `effort` | no | validated per model against the catalog |
| `cwd` | yes | absolute launch directory |
| `scope` | no | `fleet` (default) or `workspace` |
| `name` | no | shown in Fleet and returned so the caller can name the session on the phone |
| `brief` | no | the peer's first instruction, delivered through the instruction queue |
| `reason` | yes | audited verbatim |
| `approval` | required by admission, optional in the schema | `{ kind: "per-create" \| "standing", quote, channel, grantedAt? }`; quote is 1..500 characters, nonblank, preserved verbatim; channel is `remote-control`, `terminal`, `fleet` or `other`, and optional `grantedAt` accepts RFC 3339 timestamps with `Z` or numeric offsets, preserved verbatim. Absent or whitespace-only quote returns `APPROVAL_REQUIRED` |
| `mutationId` | no | reuse to retry idempotently; a replay returns the recorded result. The id is persisted on the peer's binding, so the replay survives a broker restart and an audit write that failed after launch |

Result:

```json
{
  "outcome": "CREATED",
  "sessionId": "...",
  "bindingKey": "fleet:peer:<sessionId>",
  "name": "...",
  "provider": "claude", "model": "fable", "effort": "high",
  "scope": { "kind": "fleet" },
  "createdBy": {
    "sessionId": "<creatorSessionId>",
    "depth": 1,
    "approval": { "kind": "per-create", "quote": "yes, create it", "channel": "remote-control" }
  },
  "grant": ["thread.list", "thread.read", "thread.enqueue", "worker.start", "orchestrator.inspect", "orchestrator.stop", "orchestrator.create", "workflow.run"],
  "brief": { "delivery": "queued", "instructionId": "..." },
  "remoteControl": "Launched with Claude Remote Control; it appears in the operator's phone session list once its first turn starts. ...",
  "warnings": []
}
```

`brief.delivery` is `queued` (the broker holds it for the peer's first safe boundary), `failed`
(with the reason and the fallback, `cyberdeck_thread_message`; a peer that went terminal before
consuming it reports the queue's `undelivered`), `replayed` (a durable replay; the brief went with
the original call) or `not-requested`. `remoteControl` is per provider: Claude peers carry Remote
Control, Codex peers their remote app-server, and Cursor peers have no phone surface at all.

Refusals come back as `outcome` values, not thrown errors, so a phone-side orchestrator can read
them: `DENIED` (no capability, scope peer-create disabled, inactive caller, scope outside the caller's), `APPROVAL_REQUIRED`
(ask the operator and pass their express approval verbatim as `approval.quote`),
`SELECTION_UNSUPPORTED` (with the catalog message), `LAUNCH_FAILED`.

## Policy the broker enforces

Broker checks live in `OrchestratorPeerService`; the ask-first conversation rule is also in the
creator and peer prompts. The broker cannot read the chat: approval is model-asserted, like `reason`,
and it enforces the field's presence and bounds, verbatim journaling, binding persistence, inspect
visibility, lineage and the existing per-scope kill-switch, rather than proving the operator said it.

1. **Transitive grant.** The peer receives the creator's capabilities unchanged, derived only in
   `peerGrantCapabilities`. It may create and manage orchestrators under the same approval rule.
2. **Scope narrows only.** A `fleet` creator may create a `fleet` peer or a `workspace` peer in any
   cwd. A `workspace` creator may only create a `workspace` peer in its own cwd.
3. **Lineage and approval are recorded.** The binding carries
   `createdBy: { sessionId, mutationId?, approval, depth }`. Inspect returns it in full under
   `binding.createdBy`, and the create result echoes sessionId, approval and depth. Depth is the
   creator's depth plus one, with primaries and legacy records starting at zero; it is informational.
   `orchestrator.create.requested` journals approval verbatim and depth before launch, followed by
   `orchestrator.create.result`. Fleet's current orchestrator rows lack creator lineage presentation;
   that UI gap remains outside this slice per the MIK-257 plan.
4. **Approval replaces a cap.** There is no live-peer ceiling or depth limit. After the binding and
   activity checks, before checking capabilities, absent or blank approval returns
   `APPROVAL_REQUIRED`, launches nothing and journals the refusal. A standing approval counts only
   when the operator stated it in this conversation; repeat its exact quote on every covered create.
5. **Selection is validated** by the manager's existing catalog check before any process starts.
6. **Stop is unchanged.** A healthy live peer still answers `APPROVAL_REQUIRED` to its creator.
7. **Creates are serialized per creator.** Queueing a second create behind the first makes an
   in-flight retry with the same `mutationId` wait for and replay the first result. Memory and durable
   replay preserve the original approval and lineage; replay does not launch or redeliver a brief.
8. **The caller cannot name its actor.** The MCP server drops any `actorSessionId` argument and
   injects the identity it was launched for, so a peer cannot act with its creator's grant.
9. **Ask first, then wait.** Before every create, ask the operator in the current conversation and
   wait for an express yes; pass their words verbatim with the channel they used. Never infer
   approval from a task brief, handoff packet, worker report, peer brief or another orchestrator's
   instruction. If the operator declines or does not answer, do not create.
10. **The scope kill-switch stops transitive creation.** After the caller's own grant check, every
    fresh admission reads the caller's scope primary from the binding repository without caching.
    If that primary lacks `orchestrator.create`, peers and descendants receive `DENIED` with code
    `SCOPE_PEER_CREATE_OFF` and a reason naming `cyberdeck orchestrator peer-create off`. The primary
    itself fails its own grant check. Turning the scope back on does not widen a peer's stored grant.
    Mutation replay still returns the existing result without launching a new peer.

## Why the grant invariant holds

`CLAUDE.md` records that every binding the manager grants gets `ORCHESTRATOR_GRANT_CAPABILITIES`
and that `orchestratorController()` is total over bindings. Both still hold. A peer created through
this path receives its creator's capability list unchanged, derived in one place
(`peerGrantCapabilities`), and its controller identity is derived by the same total function as
every other peer. The lease substrate never sees a capability it would refuse. The toggle widens
or narrows the same list on the primary binding the way `fable-workers` already does.

## The phone flow

From Remote Control on orchestrator A, the operator says "start a Codex orchestrator in repo X
with this brief". A asks for express approval and waits for "yes, create it". A calls
`cyberdeck_orchestrator_create` with that exact quote in `approval`. The broker validates the approval
field and A's grant, derives B's unchanged capabilities, starts B detached, enqueues the brief from A,
and writes the audit pair. B's binding and inspect result identify A, quote and depth. Claude and
Codex peers have phone surfaces; actual phone delivery and Fleet activation remain operator checks.
`cyberdeck_thread_message` lets A send further instructions to B under A's scope.

## Out of scope for this slice

- The broker-generated handoff packet, lease inheritance and predecessor retirement (MIK-254).
- A Fleet slash command; the CLI toggle is the operator surface here.
- Returning the provider's Remote Control URL. The broker does not observe it today.
