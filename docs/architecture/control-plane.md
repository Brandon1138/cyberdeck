# Control-plane contracts

Phase 1 gave Cyberdeck durable, broker-owned Claude and Codex **sessions**: live PTYs that move
between attached and detached presentation for the life of the broker. Phase 2/3 adds a **control
plane** for bounded **jobs**: units of work with an immutable request, a lifecycle, and a terminal
result. This note defines the shared contracts, the ownership boundaries, the invariants they
enforce, and the dependency direction between layers. A1 defines only the contracts (types + Zod
validation + pure guards). It implements no job execution, adapter process, persistence, artifact
storage, App Server transport, worktree mutation, scheduler, budget enforcement, or reconciliation.

## Session is not job

A **session** (`src/domain/session.ts`) is a live provider process and PTY. It has execution state
and attachment state, may receive many prompts over time, and is not bounded.

A **job** (`src/domain/job.ts`) is bounded. It has one immutable `JobRequest` (an instruction, an
explicit provider, an independent sandbox, optional opaque model/role) and settles into exactly one
terminal outcome. The two are kept deliberately separate:

- `JobRecord.sessionId` is **optional**. A job MAY use a session/runtime, but one job is not one
  provider process, and a job MUST NOT redefine attachment state as job state.
- A job's lineage (`parentJobId`) is a job tree, distinct from a session's ancestry
  (`parentSessionId`).
- Session lifecycle uses the coarse `active` state; a job carries its own lifecycle union.

## Contracts (all under `src/domain/`)

| Module | Contract | Notes |
|--------|----------|-------|
| `control-plane.ts` | `CONTROL_PLANE_SCHEMA_VERSION`, `schemaVersionField`, branded ids (`JobId`, `DelegationId`, `CorrelationId`, `ArtifactId`, `LeaseId`), `SessionId`, `TimestampSchema`, `ControlPlaneErrorCodeSchema` | Shared primitives and the cross-process error vocabulary. |
| `provider-registration.ts` | Open `ProviderIdSchema` (lowercase slug), `ProviderDescriptorSchema`, `ProviderRegistry` port, `validateRegisteredProvider` | Extensible registration seam. Not closed to `codex \| claude`. |
| `job.ts` | `JobRequestSchema` (immutable), `JobLifecycleSchema`, `JobResultSchema`, `JobRecordSchema`, `JobReportSchema`, `JobErrorSchema` | Bounded job, its states, and the report-back envelope. |
| `delegation.ts` | `DelegationIntentSchema` | Explicit delegation intent + parent/correlation ids. |
| `artifact.ts` | `ContentReferenceSchema`, `ArtifactDescriptorSchema` | Structured descriptors and content references. No storage. |
| `lease.ts` | `LeaseStateSchema`, `WorktreeLeaseSchema` | Repository/worktree lease records. No lease behavior. |
| `budget.ts` | `ConcurrencyDeclarationSchema`, `BudgetDeclarationSchema`, `BudgetUsageSchema` | Declarations/usage. No scheduling. |
| `dispatch.ts` | `DispatchRequestSchema`, `DispatchAcceptedSchema`, `CancellationRequestSchema`, `CancellationResultSchema`, `JobDispatchAdapter` port | Provider-neutral dispatch/completion/cancellation port. |

## Invariants

**Neutrality (unchanged from Phase 1, extended to jobs).** Provider is always explicit. In the job
plane it is an open, runtime-validated slug that must be explicitly registered
(`validateRegisteredProvider`) — arbitrary strings are rejected until a descriptor is registered.
Model and role are optional opaque strings with no capabilities or routing semantics. Sandbox is
independent. There is no provider ranking, model recommendation, automatic provider/model fallback,
or role catalog anywhere in these contracts. `ProviderDescriptor` carries neutral identity metadata
only (id + display name); it has no rank, priority, or capability field.

**Extensible provider identity.** The shared provider type is a slug, not a `codex | claude` union,
so adding a provider does not reopen a closed type. `BUILTIN_PROVIDER_IDS` seeds the known providers.
Integrated B1 evidence finalizes the canonical provider ids as `cursor` and `antigravity`, with
observed executable mappings `cursor -> agent` and `antigravity -> agy`. They are listed as planned
ids by the shared registration module but remain unsupported until a concrete adapter is registered;
an id being canonical does not claim that its adapter exists. The Phase 1 session contract keeps its
closed `ProviderIdSchema` enum for now; reconciling the session enum to the open registration
contract is a scheduled integration task.

**A2 contract ratification.** A2 added optional `usage` to `JobReportSchema` so adapters can report
provider-neutral usage through the frozen dispatch/report port. This additive field is approved:
absence means unknown and must never be interpreted as zero. The `JobDispatchAdapter` interface
itself remains unchanged.

**A4 runtime interruption extension.** `RUNTIME_INTERRUPTED` is a neutral transport-loss error used
when a supervised runtime disappears before validated terminal completion. The control plane maps
that report to the existing durable `interrupted` lifecycle rather than fabricating a terminal
provider result. It retains correlation diagnostics and never redispatches. See
[`app-server-and-worktree-leases.md`](app-server-and-worktree-leases.md).

**Invalid lifecycle data is unrepresentable.** `JobLifecycleSchema` is a discriminated union where
only the `settled` status carries a `result`. A running job cannot hold a terminal result, a
recovered `interrupted` job must carry an interruption timestamp and reason, and a settled job
cannot omit its result. `JobResultSchema` pairs each outcome with exactly its required payload
(`failed` requires an error; `completed`/`failed` require an artifacts array). `CancellationResult`
cannot be a refusal without a code.

**Forward compatibility is deliberate.** Every cross-process envelope carries `schemaVersion`
(defaulting to the current version when omitted). Record schemas strip unknown keys rather than
rejecting them, so a newer producer's extra field is ignored by an older reader instead of being
fatal. `SchemaVersionSchema` accepts any positive integer so a reader can gate on a version it does
not yet understand and raise `SCHEMA_VERSION_UNSUPPORTED`.

**Identifiers are branded.** Control-plane ids are branded UUIDs, so passing a `LeaseId` where a
`JobId` is expected is a type error. They remain plain UUID strings at runtime. A `SessionId` is
left unbranded to interoperate with the existing `SessionRecord`.

## Fable / native-default-Claude safety (priority)

Phase 1's delegated-Fable rejection examines only an **explicitly supplied** model string
(`isFableModel(request.model)`), so an **omitted** Claude model — which the installed runtime
resolved to native-default Fable — is not prevented by the neutral start policy. **Current policy
does not close this gap, and this document does not claim it does.**

A1 keeps the two boundaries separate on purpose:

- **Neutral stored contract** (`evaluateStart`): `model` stays optional. Blocking omitted-model
  delegated Claude here would conflate stored neutrality with launch safety and would break the
  Phase 1 fake-adapter tests that legitimately delegate Claude with no model.
- **Live launch boundary** (`evaluateClaudeLaunchSafety`): a new, tested pure guard that treats a
  Claude launch with an **omitted OR Fable** model as unsafe (`CLAUDE_LAUNCH_REQUIRES_EXPLICIT_NON_FABLE_MODEL`)
  and leaves non-Claude providers unconstrained. It expresses the invariant as code but does
  **not** enforce anything until it is called at the real Claude process-spawn boundary.

**Safe live-launch invariant.** A live Claude start (top-level or delegated) is forbidden unless a
human operator supplies and has independently verified an explicit ordinary non-Fable model. An
omitted model is unsafe at the live Claude launch boundary. Until B2 wires
`evaluateClaudeLaunchSafety` at the actual spawn boundary and a human-launched Codex gate verifies
it, the plan hard-blocks all omitted-model Claude live checks.

## Ownership boundaries

| Area | Owner |
|------|-------|
| `src/domain/**`, `src/protocol/**`, `src/broker/**`, `src/config.ts`, persistence/recovery contracts | Agent A (control plane) |
| `src/providers/**`, `src/runtime/**`, `src/client/**`, `src/tmux/**`, dashboard/cockpit, provider-facing CLI UX, concrete dispatch/PTY adapters | Agent B (adapters/presentation) |
| Live broker/provider/tmux acceptance, both mandatory gates | Human operator (serialized, one at a time) |

A1 froze the shared ports (`JobDispatchAdapter`, `ProviderRegistry`) and registration seam. B1
supplied read-only capability probes and deterministic fixtures. A2 implemented the concrete
control-plane registry/service and canonicalized the evidence-backed planned ids; B2 consumes those
extension points and owns Claude launch-safety wiring at the real spawn boundary. No completed step
claims a B-owned production adapter exists yet.

## Allowed dependency direction

```
                 zod + node stdlib
                        ▲
                        │  (only)
                   src/domain/**            ← control-plane contracts, ports, pure guards
                        ▲
        ┌───────────────┼───────────────────────────┐
        │               │                            │
  src/broker/**   persistence/recovery        adapters (src/providers/**, src/runtime/**)
  control plane   (Agent A, later)            implement domain ports (Agent B)
        ▲                                            ▲
        └──────────────── presentation ─────────────┘
             (src/client/**, src/tmux/**, CLI — Agent B)
```

- `src/domain/**` depends only on `zod` and the Node standard library. It never imports broker,
  persistence, adapter, or presentation code.
- The broker/control plane and the future persistence layer depend on domain, not the reverse.
- Adapters (provider dispatch/PTY) depend on domain **ports** and are injected into the broker;
  the broker does not import concrete adapters.
- Presentation (CLI, tmux, dashboard) depends on the client/broker protocol, never on domain
  internals directly beyond the shared schemas.

## A3 durability boundary

Bounded jobs, terminal results, usage, idempotency keys, lineage, and report-back state are rebuilt
from a validated append-only store at broker startup. Unverifiable nonterminal work becomes
`interrupted`; it is never automatically redispatched. Live PTYs remain outside that boundary and
are not reconstructed. Structured artifact bytes and metadata live in a separate atomic,
content-addressed store. See
[`persistence-and-recovery.md`](persistence-and-recovery.md) for the file layout, corruption rules,
restart mapping, and artifact integrity guarantees.

## A4 App Server and lease boundary

Codex App Server is an explicit Codex job transport behind the unchanged `JobDispatchAdapter` port,
not a route or fallback. Durable canonical-path leases provide read-only sharing, exclusive
workspace-write ownership, expiry, heartbeat, and monotonically fenced replacement. Startup treats
unverifiable held leases as blocking orphans and never performs Git cleanup. Exact protocol and
operations behavior is documented in
[`app-server-and-worktree-leases.md`](app-server-and-worktree-leases.md).

Within domain, the contract module dependency direction is:
`control-plane → provider-registration`, `artifact → control-plane`,
`job → {control-plane, provider-registration, session, artifact}`,
`delegation → {control-plane, job}`, `dispatch → {control-plane, provider-registration, job}`,
`budget → {control-plane, provider-registration}`, `lease → control-plane`. There are no cycles.
