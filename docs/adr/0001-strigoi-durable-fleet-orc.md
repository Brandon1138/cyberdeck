# ADR 0001: Strigoi as a durable Fleet Orc

Date: 2026-11-14.
Status: accepted by the operator on 2026-11-14 as the basis for implementation planning; not implemented.

## Context

The operator wants a resident Fleet Orc started with the broker, with regular Orc
capabilities and reliable continuity across context renewal and failure. One
conversation cannot be its permanent identity. Context cleanliness, retained
judgment, and recovery are the core engineering concerns.

The name is Strigoi. Alfred is its conversational alias and the reference for how
it should develop: knowledgeable about the house and its machinery, attentive to
the operator's projects and agents, willing to propose help, ask, and take initiative.
Long-term it may orchestrate other Orcs and their workers through project completion.
The first release establishes the durable resident; it does not implement that
future management system.

The operator explicitly rejected a maintained charter and a compulsory monitoring
assignment. Responsibility is understood through conversation, state, and inference.
Existing grants, leases, and operator controls still govern executable authority.

## Approaches considered

| Approach | Benefit | Limitation |
| --- | --- | --- |
| Keep resuming one ordinary Orc conversation | Small initial lifecycle change | Does not establish controlled context renewal or semantic succession |
| Create an ordinary peer for each successor | Reuses peer creation | Peer identity includes its session; ownership, inbox routing, and continuity would repeatedly move between controllers |
| Dedicated resident binding with successive conversations | Separates Strigoi's lifetime from provider sessions; keeps one ownership identity | Requires explicit succession, admission fencing, and recovery integration |

The operator approved the dedicated resident binding with the design on 2026-11-14. The detailed
protocol deliberately permits a short interruption between incarnations.

## Decisions

1. **One resident per broker state domain.** A dedicated Strigoi binding coexists
   with the current Fleet primary and peers. It does not replace or take over any
   existing Orc. Every incarnation is a regular broker-owned orchestrator session.
   Extend the existing binding model and its one `orchestratorController()` derivation;
   do not invent a parallel controller or capability system.

2. **Presence is independent of inference.** Local lifecycle code maintains the
   resident. Enabled startup reconstructs state and provider availability without
   submitting a greeting, inspection task, or health-check prompt. Normal work and
   recovery use inference when needed. No periodic model heartbeat is introduced.

3. **Serialized succession first.** At a safe boundary, checkpoint understanding
   and capture mechanical state, retire the predecessor, then activate the successor.
   Maintain at most one incarnation admitted to ordinary actions; a visible gap is
   acceptable. Activation has one durable commit point. Restart resumes the recorded
   transition instead of guessing from processes or re-running creates.

4. **Preserve understanding and original evidence.** A handoff contains the current
   understanding, rationale, outstanding commitments, uncertainties, and references
   to original conversations and artifacts. Broker state supplies identities,
   receipts, pending deliveries, and ownership facts. Neither a recursively compressed
   summary nor a model-written task list becomes the sole source of truth.

5. **Recover effects conservatively.** Reuse instruction receipts, mutation IDs,
   worker coordination, and attention machinery. Binding replacement alone is not
   handoff. Known completed effects are not repeated; uncertain external effects
   require reconciliation. Exactly-once execution of arbitrary shell or remote
   actions is not promised. The admission barrier enforces Cyberdeck-controlled
   mutations; provider-native and other connected tools are not universally fenced.

6. **Ordinary Orc authority.** Strigoi gets the regular grant through the existing
   derivation, with applicable operator toggles preserved across succession. Its
   name and Fleet position grant no ownership over other Orcs. Enabling resident
   lifecycle is durable authorization for Strigoi's own restoration/replacement,
   not authorization to create arbitrary peers or widen grants.

7. **Deliberate stop wins.** Operator suspension is durable and suppresses automatic
   resurrection. Unexpected loss invokes bounded recovery. Missing credentials,
   rate limits, unavailable models, or corrupt state produce a visible hold; they
   do not trigger silent provider changes or endless inference retries.

8. **Canonical naming.** Display and code name remain Strigoi. Instructions teach
   the resident to recognize Alfred as an address to itself. No separate alias
   identity, credentials, lifecycle, or management surface is created.

## Current foundations and gaps

Inspected on 2026-11-14 in a dirty working tree based on commit
`54c9234a41bad511f19e6370b3ed83f22a585e4b`. These are source observations, not live
runtime acceptance; several relevant files already contain unrelated local changes.

- [OrchestratorManager](../../src/orchestration/orchestrator-manager.ts) can ensure
  a primary or create peers, persists bindings during activation, and supplies
  regular Orc guidance. It has no resident succession protocol.
- [Binding/controller identity](../../src/domain/orchestrator.ts) and the
  [directory](../../src/orchestration/orchestrator-controller-directory.ts) already
  separate controller identity from session routing. Peer keys nevertheless include
  the session ID; a resident needs an explicit compatible representation.
- [The binding store](../../src/persistence/orchestrator-store.ts) keeps latest
  bindings in an append-only journal. It does not currently provide an atomic
  succession compare-and-swap transaction across the surrounding services.
- [Attention](../../src/orchestration/orchestrator-attention-control.ts) currently
  cancels an armed wait when its binding's session changes. Succession must preserve
  pending meaning and consumption coverage through explicit recovery.
- [Liveness](../../src/orchestration/orchestrator-session-liveness.ts) observes
  session death, while [lease token custody](../../src/broker/worker-lease-credential-custodian.ts)
  is process-local and intentionally lost on restart. A stable controller ID alone
  does not restore actionable ownership.
- [Peer creation](../architecture/orchestrator-peer-create.md) requires operator
  approval and explicitly excludes full succession. Resident restoration needs its
  own bounded lifecycle entry point, not a forged approval quote on peer creation.
- [Provider startup](../architecture/session-model.md#orchestrator-and-agent-authority)
  documents zero-turn guidance for Codex and Claude, and a first-turn exception for
  Cursor. Zero-inference support must be proven for each enabled resident adapter.

## Consequences and scope

The first release includes real lifecycle work, not merely a persistent name and
prompt. It must account for in-flight actions, session-addressed inputs, retained
context, attention waits, and owned worker recovery. It may be briefly unavailable
during renewal. Recovery cannot promise to keep broker-owned worker processes alive
through broker death.

Routine conversation, cutover arrivals, owned-worker results, unsubmitted worker
instructions, and attention waits must continue automatically after planned renewal.
A visible hold cannot substitute for that acceptance. The specifically accepted
workflow limitation is a pending reply tied to the archived session: preserve and
surface it for explicit continuation through existing operations. Generic workflow
participant migration is deferred; do not advertise seamless workflow succession.

Provider-neutral contracts are desirable, but the approved first acceptance target
is Codex, which has a native instruction path and semantic conversation records.
The actual model and effort are explicit operator configuration at enablement;
this ADR does not pick or launch one. Other providers require the same evidence
before being advertised as resident-compatible.

Alfred-like development is supported by retaining conversations, commitments, state
access, and a role prompt that encourages thoughtful agency. Usage awareness,
cross-project management, and subordinate recovery can be added later through the
established capability system. Do not implement speculative plugin frameworks now.

See the [product brief](../design/strigoi-brief.md) and
[approved design](../superpowers/specs/2026-11-14-strigoi-design.md). A functioning
process, written packet, or successful acknowledgement alone is insufficient proof
of Strigoi's durability.
