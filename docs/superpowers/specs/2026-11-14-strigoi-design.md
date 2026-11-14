# Strigoi: durable resident Orc design

Date: 2026-11-14.
Status: approved by the operator on 2026-11-14 as the basis for implementation planning; source implementation and fixture acceptance recorded; live qualification NOT RUN.
Approval does not enable a live resident or select a live model.
Product intent: [brief](../../design/strigoi-brief.md).
Architecture decision: [ADR 0001](../../adr/0001-strigoi-durable-fleet-orc.md).
Implementation plan: [Strigoi plan](../plans/2026-11-14-strigoi.md) (separate execution review).

## Scope and approaches

Build a persistent Fleet Orc started with the broker, with regular Orc capabilities,
quiet residence, planned context renewal, and recovery after unexpected loss.
Display/code name: Strigoi. Alfred is a conversational alias for the same resident.
The operator works with it naturally; there is no required monitoring assignment,
charter, or new project-management feature.

Continuously resuming one conversation leaves renewal unresolved. Replacing it with
ordinary peers changes controller identity on every handoff. The recommended approach
is a dedicated resident binding with a stable controller and successive conversations.
The operator approved this engineering choice with the design on 2026-11-14.
See the ADR for alternatives, consequences, and the Alfred development intent.

## Identity and authority

One configured resident exists per broker state directory, under the existing broker
singleton ownership. This does not promise a machine-wide singleton across independent
brokers. Multiple broker coordination and shared state across hosts are out of scope.

Introduce an explicit resident binding representation with a reserved Strigoi key;
do not occupy the existing `fleet` primary or fabricate a peer suffix. Extend
`OrchestratorBinding`, central scope/family mapping, and `orchestratorController()`
together so every granted binding remains a valid controller. Keep existing primary
and peer identities unchanged. Strigoi's family must not absorb unrelated Orcs.

The resident records an increasing incarnation number. An incarnation names one
session and its provider process generation. Provider conversation IDs and resumes
are implementation details; they do not decide who is the active resident. All
session-addressed entry points must resolve and validate the current binding.

Reuse the regular Orc grant and existing operator toggles. Recovery must carry the
latest effective grant, not reconstruct default capabilities from an old packet.
No authority comes from the role string, the Alfred alias, or model-written memory.
Existing peer-create approval and directed-worker-handoff policies continue to apply.
Resident enablement authorizes only its own lifecycle and renewal until disabled.

During succession, one shared admission barrier prevents new ordinary Cyberdeck
mutations from the retiring incarnation and drains already-admitted broker mutations before cutover.
Recheck the current incarnation at the final side-effect boundary, including delayed
instruction submission. Updating the binding after an early permission check is not
sufficient fencing. Keep this lifecycle rule centralized rather than adding independent
controller-identity derivations to tools.

This is a guarantee about Cyberdeck-controlled operations. A regular Orc also has
provider-native shell/file tools and may have other connected MCP services. Those
are not universally intercepted by this barrier. Recovery instructions require
reading and reconciliation before consequential action, but that instruction is not
a security sandbox. Do not claim global side-effect fencing or add a general tool
isolation project to this release. Confirmed predecessor retirement prevents two
live provider incarnations; uncertain external effects remain subject to explicit
reconciliation and semantic evaluation of the successor's behavior.

## Lifecycle and startup

Proposed operator controls: enable/configure, inspect, suspend/resume, and renew.
Exact command syntax and Fleet placement are left to implementation planning. No new
keybinding is necessary. Enablement explicitly selects a supported provider/model,
effort, and launch cwd; record these independently of project ownership. The launch
cwd grants no automatic responsibility for that repository.

Approved first provider acceptance target: Codex. Support only provider adapters that
prove passive startup and the required semantic recovery path. No automatic provider
fallback. Provider expansion is subsequent work, not a condition for first release.

On broker startup, recover existing registries and queues, then reconcile Strigoi's
persisted desired state and succession record before admitting its operations. Start
or restore its process once, with no initial user prompt. Its role and pointer to
durable continuity material use the provider's native instruction channel. Process
startup and reconciliation are bounded and must not prevent the rest of Fleet from
becoming usable if this provider is unavailable.

When no work is pending, startup and idle residence make zero model inference calls.
Recovery reasoning is deferred until an actual pending obligation, incoming message,
or explicit renewal requires it. That first turn adopts the continuity material before
ordinary action. Passive process availability must not be presented as proven semantic
readiness. If startup discovers unfinished work, an attributable recovery turn is
allowed and measured separately from passive startup.

Distinguish at least: disabled, starting, available awaiting context adoption, ready,
busy, renewing, recovering, suspended, and unavailable with reason. These are resident
lifecycle facts combined with existing session truth, not replacements for worker
truth. A status read or opening Fleet must not wake the model.

An explicit operator stop of the resident durably suspends automatic restoration;
broker shutdown itself preserves desired enablement. Unexpected process loss uses
bounded restart attempts and backoff; repeated failure reaches a visible hold. Stop
during any handoff phase prevents later activation until explicit resume. Deleting
history is separate from stopping; do not erase conversations or handoff artifacts
as lifecycle cleanup.

## Durable continuity material

Use a versioned manifest and immutable, integrity-checked packet artifacts under the
broker's private state, following existing persistence/artifact primitives. Do not
turn the repository or this design document into live resident memory. Normal
retention must preserve referenced transcripts, pending instructions, receipts, and
artifacts while required for recovery; release references deliberately after they
are no longer needed. Do not silently depend on default session retention.

Separate mechanically recorded facts from model-written understanding:

| Material | Source and meaning |
| --- | --- |
| Identity and transition | Resident key, incarnation, session/process generation, desired state, transition ID and phase |
| Conversation coverage | Exact source IDs/cursors and packet coverage boundary; original operator messages remain retrievable |
| Understanding | Current intent, relevant preferences and boundaries, decisions with rationale, commitments, uncertainties, expected next steps |
| Work and effects | Existing worker/controller IDs, mutation IDs, instruction receipts, known effects, ambiguous effects needing reconciliation |
| Pending attention | Unconsumed source references, waits/deadlines, notifications, pending replies; observed is distinct from handled |
| Provenance | Packet version, hash, author incarnation, creation time, source references and freshness |

The human-facing understanding is flexible prose, not an operator-maintained charter
or a new executable permission matrix. Mechanical fields exist to deliver, recover,
and verify the conversation. Original instructions prevail over interpretations.

Refresh understanding during useful turns and at material changes in commitments,
using a small checkpoint operation within the existing turn. No extra inference
loop exists just to rewrite memory. Preserve raw semantic turns and action receipts
even when a model checkpoint has not yet been written. Abrupt recovery reconstructs
the uncovered tail explicitly; it cannot claim to recover unrecorded thoughts.

Packets are bounded entry points with references to deeper evidence. Repeated renewal
must not recursively summarize only the previous packet. Read original instructions
and decision evidence when needed; distinguish a remembered fact from a current
observation. The broker does not judge semantic quality from packet length or a hash.

## Planned succession protocol

The first version chooses serialized succession and accepts a brief availability gap.
No second freely acting incarnation is prepared alongside the incumbent.

1. **Record intent.** Create one durable transition ID with the expected incarnation,
   reason, and desired provider settings. A repeated request returns this transition.
   Conflicting requests serialize; a stale request cannot replace a newer incarnation.
2. **Reach a safe boundary.** Hold new ordinary turns while accepting their inputs
   durably. Let the current turn complete and produce continuity material; if needed,
   request one bounded checkpoint turn. Respect operator input and provider modal
   gates. Freeze ordinary Cyberdeck mutation admission and drain accepted operations.
   If quiescence cannot be established, remain visibly held rather than pretending
   it is safe to rotate. Explicit abort can reopen the unchanged incumbent.
3. **Seal the packet.** Persist its hash and exact conversation/action coverage before
   retirement. New arrivals after that boundary remain a pending tail. Unresolved
   effects are included explicitly and block their own automatic retry.
4. **Retire the predecessor.** Revoke its admission to further actions and confirm
   termination of the broker-owned provider execution. Drain tracked child operations
   or mark their effects uncertain. Broker fencing cannot undo an already-issued
   external request. Do not launch a freely acting successor while predecessor
   execution ownership is unresolved. Archive rather than delete its history.
5. **Prepare and commit the successor.** Persist its assigned session identity before
   launch so interrupted launch can be reconciled. Launch passively, with ordinary
   Cyberdeck mutation admission closed. Atomically advance the resident binding to incarnation
   `g + 1`, recording the transition ID, predecessor, and packet hash in the same
   authoritative commit. Projection updates can replay after that commit. This is the
   only cutover; independent metadata and binding writes cannot each claim authority.
6. **Adopt and reconcile.** Run a bounded recovery turn when work or explicit renewal
   requires it. The successor reads the sealed packet and uncovered tail, examines
   current ownership and effect receipts, and records an acknowledgement tied to the
   packet hash and source coverage. Read/recovery operations are available while
   ordinary Cyberdeck mutations remain held. Native/external tool behavior follows
   the recovery instruction and the limitations stated above. New arrivals cannot be silently included in
   an acknowledgement of an earlier snapshot. A malformed acknowledgement is not
   acceptance. Inspect semantic behavior separately from this mechanical receipt.
7. **Release normal work.** Reconcile required lease, instruction, and attention state,
   then admit ordinary Cyberdeck mutations for the committed incarnation. Preserve pending work
   outside acknowledged coverage. Mark the handoff complete and report it briefly
   when useful. If adoption fails, remain recovering/unavailable with the same
   transition identity; do not run an unbounded chain of successor attempts.

For initial startup with no predecessor, create the empty resident once and omit
packet succession. For passive recovery with no actionable work, steps requiring
inference wait for the next meaningful turn. Inspection must expose that distinction.

## Commit, replay, and failure rules

Use the existing binding persistence authority, extended for resident transition
metadata and compare-and-swap under serialization. Write packet artifacts first;
the binding commit references immutable content. Transition preparation has no power
to change the active binding. Orphaned preparation artifacts confer no authority.
An implementation plan must map each phase to an fsynced record and recovery action.

| Interruption point | Required recovery |
| --- | --- |
| Before packet seal | Incumbent remains authoritative if alive; recover original records if it died |
| Packet sealed, before confirmed retirement | Reconcile/drain incumbent execution; no concurrent acting successor |
| Incumbent retired, before commit | Finish the recorded transition; no arbitrary rollback that resurrects old authority |
| Launch outcome unknown | Reconcile the assigned session and owned execution before retry; never blindly create another |
| Cutover committed, projections incomplete | Binding commit wins; rebuild routing, liveness and lifecycle projections idempotently |
| Successor consumed packet, acknowledgement lost | Replay acknowledgement against the same packet/coverage; do not replay work |
| Ordinary external effect has uncertain outcome | Inspect evidence or ask the operator; do not automatically reissue the effect |
| Corrupt or unsupported resident state | Hold Strigoi with diagnostics; preserve evidence and other Fleet functionality |
| Suspend races with any step | Durable suspension wins admission; no automatic activation or inference |

After abrupt loss, use the latest valid packet plus original records after its coverage
boundary. If no model packet exists yet, use the recorded conversation and broker
facts, with uncertainty made explicit. Exactly-once admission/idempotency must be
defined for broker-controlled operations; arbitrary external effects cannot inherit
that guarantee. A stopped provider process is not proof that a remote action failed.

## Existing subsystems that succession must reconcile

- **Binding and grant:** one current incarnation; old sessions cannot inherit the new
  grant. Revalidate delayed and in-flight calls at their final execution boundary.
- **Worker ownership:** retain the stable controller identity, but check actual lease
  state and current ownership. Use the existing coordination recovery/adoption path
  for eligible workers previously held by Strigoi, with fresh credentials as needed.
  Never take a worker now owned elsewhere, including one moved during succession.
  Broker restart loses current token custody; never reconstruct tokens from prose.
  Preserve worker results even when broker death also ended worker processes.
- **Liveness:** serialize/discard obsolete predecessor observations so late death
  events cannot orphan the successor's authority. Process identity is observed, not
  inferred from a persisted PID.
- **Attention:** current code cancels waits on session replacement. Preserve the old
  statement and consumed coverage, then explicitly reconstruct eligible waits under
  the new actor/epoch, rechecking worker lease versions. Cancelled-by-operator waits
  stay cancelled. Never claim an old actor's receipt as a new actor's consumption.
- **Incoming messages:** an address to Strigoi resolves to the resident at delivery,
  with a durable logical message ID. Keep immutable original addressing and delivery
  receipts. Messages explicitly targeting an archived session are not silently
  redirected as if the original recipient had handled them. Inputs arriving during
  a transition remain retained and visibly pending.
- **Outgoing instructions:** preserve original actor, message ID, delivery and turn
  receipts. Unsubmitted work may be explicitly continued by the successor after
  revalidation; do not rewrite history to make it look originally successor-authored.
  Submitted or ambiguous instructions require receipt reconciliation before retry.
- **Workflows and pending replies:** inventory outstanding obligations on renewal.
  For APIs tied to the predecessor session, explicitly continue through existing
  service semantics or surface a recoverable hold. Never silently transfer workflow
  identity or mark pending replies complete just because the binding changed.

These are required continuity seams, not an invitation to build a second notification
queue, lease system, generic workflow migration platform, or model-usage service.

### Minimum automatic continuation contract

The following routine cases must continue without operator repair after planned
renewal; a hold in a case with valid state and unchanged authority is a test failure:

- The ongoing conversation, including an unresolved question and an accepted user
  message arriving during cutover.
- Live workers already owned by Strigoi, their existing results, and results arriving
  during renewal. The successor can act on them using current valid lease credentials.
- A queued, not-yet-submitted worker instruction; continuation preserves its logical
  identity and issues it once. A completed instruction whose acknowledgement was
  lost is recognized from existing evidence rather than issued again.
- An armed attention wait, its deadline, and pending wake/results with exact consumed
  coverage. Reconstruction under a new actor must not require the operator to re-arm it.

Broker restart must automatically restore conversation continuity, retained results,
pending accepted inputs, and eligible prior Strigoi ownership through the existing
recovery path. It need not recreate worker processes killed with the broker or
automatically rerun their potentially consequential work. Missing/conflicting evidence
is exposed and the resident reasons about the next step after reconciling state.

Accepted first-release holds are specific: an uncertain external effect, changed
ownership or grant, unavailable provider, missing/corrupt required evidence, failure
to confirm predecessor retirement, and a workflow whose participation/reply identity
is inseparably tied to the archived session. For that last case, retain the original
workflow and pending reply, surface the exact blocked obligation, and let the operator
and Strigoi explicitly continue or replace it through existing workflow operations.
Do not fabricate a migrated reply, silently drop it, or advertise seamless workflow
succession. A new generic workflow migration mechanism is deferred. These exceptions
do not excuse a hold in the routine cases above.

## Renewal triggers and costs

First-release renewal supports an operator request, Strigoi's own request at a safe
boundary, and unexpected process loss. Add a configurable context-headroom trigger
only where the provider exposes a trustworthy measurement. Never derive context
occupancy from transcript file size. If measurements are unavailable, show unknown
and retain explicit renewal; do not invent a percentage.

Do not select an arbitrary universal compaction count as a quality guarantee. The
implementation plan should reserve headroom for checkpoint/recovery and evaluate
the trigger against the chosen provider. Keep a manual route for context cleanliness
even when a token threshold has not been reached.

Record transition reason, phase timings, packet size/coverage, inference turns,
provider-reported usage when available, and retry/hold reasons. No hidden summarizer
turns on startup. Usage unknown is not zero. Monitoring the resident's own handoff
cost is in scope; collecting provider subscription balances is not.

## Acceptance

All items below are NOT RUN. Documentation is not acceptance evidence.

| Dimension | Required evidence |
| --- | --- |
| Passive residence | Enabled cold start, repeated startup/reconciliation, idle interval and Fleet inspection create one resident and zero model turns when no work is pending |
| Normal use | Real selected provider conversation; regular Orc tools work; "Alfred" is understood as self-address while display/code identity remains Strigoi |
| Planned succession | Renew during a multi-turn task; preserve an unresolved decision and its evidence; successor continues with a correct useful action |
| Repeated succession | At least three successive renewals on one case without losing an original constraint, rationale, pending commitment, or unresolved doubt |
| Crash matrix | Inject failure before/after every durable phase and relevant effect boundary; retry/restart converges to one active incarnation or a truthful hold |
| Concurrent inputs | Operator message, worker result, and cancellation race with cutover; each remains accounted for with exact acknowledgement coverage |
| Ownership | Owned worker survives planned renewal; transfer away during renewal remains effective; lost restart credentials recover only eligible ownership |
| Effects | Completed dispatch is not duplicated after lost response; ambiguous external effect is reconciled/held rather than blindly repeated |
| Attention and instructions | Active wait, pending wake and queued instruction automatically continue in the routine cases above; hold is a failure |
| Session-bound workflows | Pending reply remains durable with exact original identity; an unsupported continuation produces the specifically accepted hold and an actionable recovery path |
| Operator control | Suspend at each transition phase, restart broker, and verify no resurrection or inference until resume |
| Failure visibility | Missing credentials/model, provider rejection, bad packet and lost source records show accurate holds; unrelated Fleet remains usable |
| No collateral changes | Existing Fleet primary/peers, unrelated leases, operator inputs, native history and dirty work remain intact |

Semantic evaluation uses recorded cases with original instructions, expected outstanding
commitments, decisions/rationale, deliberate stale information, and a next actionable
step. Score intent retention, correct uncertainty, evidence use, appropriate initiative,
and action choice against a no-handoff continuation. Critical failures include silently
expanding responsibility, losing an explicit constraint, treating uncertain work as
complete, or repeating an already completed consequential action. Do not pass a case
because the successor repeats the packet or says it understands. The operator reviews
representative continuations; fixture checks and semantic judgment are reported
separately. Set and record the case rubric before running the comparison.

Report exact cases, failures/holds, provider/model, costs and timing; do not infer a
production reliability percentage from a small successful sample. Unit and fault
injection tests establish mechanical behavior. Live provider and restart exercises
are separate release gates.

## Implementation boundaries and remaining choices

Follow the existing dependency rule: domain contracts in `src/domain`, lifecycle
coordination in `src/orchestration`, persistence in `src/persistence`, provider work
behind adapters, and composition in `src/broker/main.ts`. Deliver minimal Fleet/CLI
inspection and controls through existing surfaces. Do not edit unrelated in-progress
Fleet hierarchy or model discovery changes as part of this feature.

The builder selects concrete schemas, file layout, command spelling, packet bounds,
retry constants, test harness details, and narrow APIs. The implementation plan must
resolve atomic binding commit, launch reconciliation, admission barrier coverage,
lease recovery, message continuation, and retention before coding those paths.
Prove a minimal real-provider lifecycle/renewal vertical slice before adding polish.

Choices approved with this design: dedicated resident binding, serialized handoff
with a visible gap, and Codex as the first provider to qualify. Exact live
model/effort/cwd are chosen at enablement, not inferred from this
document. There is no automatic live activation as a consequence of approving docs.

Implementation evidence: [source/fixture acceptance and remaining live gates](../../setup/strigoi-acceptance.md). Historical pre-implementation observations above retain their original baseline.
