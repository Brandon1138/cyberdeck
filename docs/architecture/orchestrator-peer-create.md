# Orchestrator-created peers

> **Status: SPEC, implementing.** Slice 1 of MIK-254. Tracks `cyberdeck_orchestrator_create`
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

What is missing is an orchestrator-reachable, grant-gated path to that method.

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
  "grant": ["thread.list", "thread.read", "thread.enqueue", "worker.start", "orchestrator.inspect", "orchestrator.stop", "workflow.run"],
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
them: `DENIED` (no capability, inactive caller, scope outside the caller's), `PEER_LIMIT` (with the
live peer ids), `SELECTION_UNSUPPORTED` (with the catalog message), `LAUNCH_FAILED`.

## Policy the broker enforces

These rules live in `OrchestratorPeerService`, never in the prompt.

1. **No amplification.** The peer's grant is the creator's grant minus `orchestrator.create`.
   A created peer cannot create peers. The feature is non-transitive by construction; a depth
   counter is a later decision, not a default.
2. **Scope narrows only.** A `fleet` creator may create a `fleet` peer or a `workspace` peer in any
   cwd. A `workspace` creator may only create a `workspace` peer in its own cwd.
3. **Lineage is recorded.** The binding carries `createdBy: { sessionId }`. Inspection reports it,
   and the broker journal gets `orchestrator.create.requested` and `orchestrator.create.result`,
   the same pair shape the stop path writes.
4. **Live-peer cap.** A creator may hold at most `MAX_LIVE_PEERS_PER_CREATOR` (2) non-terminal
   peers. Past that the call returns `PEER_LIMIT` naming them.
5. **Selection is validated** by the manager's existing catalog check before any process starts.
6. **Stop is unchanged.** A healthy live peer still answers `APPROVAL_REQUIRED` to its creator.
7. **Creates are serialized per creator.** The cap is read from the binding log and the new
   binding is written during launch, so two concurrent creates from one actor would both pass;
   queueing the second behind the first makes it see the first's binding, or its recorded result
   when it carries the same `mutationId`.
8. **The caller cannot name its actor.** The MCP server drops any `actorSessionId` argument and
   injects the identity it was launched for, so a peer cannot act with its creator's grant.
9. **Live means running.** A peer counts against the cap only while its execution state is
   `starting` or `active`. An `errored` session keeps `exitCode: null` while its dead process
   lingers and must not hold a slot; neither does a deleted peer, whose session the registry no
   longer knows.

## Why the grant invariant holds

`CLAUDE.md` records that every binding the manager grants gets `ORCHESTRATOR_GRANT_CAPABILITIES`
and that `orchestratorController()` is total over bindings. Both still hold. A peer created through
this path receives a *subset* of that list, derived in one place (`peerGrantCapabilities`) by
removing one named entry, and its controller identity is derived by the same total function as
every other peer. The lease substrate never sees a capability it would refuse. The toggle widens
or narrows the same list on the primary binding the way `fable-workers` already does.

## The phone flow

From Remote Control on orchestrator A, the operator says "start a Codex orchestrator in repo X
with this brief". A calls `cyberdeck_orchestrator_create`. The broker checks A's grant, derives B's
narrower grant, starts B detached, enqueues the brief from A, and writes the audit pair. B shows up
in the phone's session list and in Fleet with A as its creator.

## Out of scope for this slice

- The broker-generated handoff packet, lease inheritance and predecessor retirement (MIK-254).
- A Fleet slash command; the CLI toggle is the operator surface here.
- Returning the provider's Remote Control URL. The broker does not observe it today.
