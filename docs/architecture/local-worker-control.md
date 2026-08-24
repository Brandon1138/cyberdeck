# Local worker control protocol

MIK-161 adds a versioned local telemetry and control boundary for native clients such as Ammo for
macOS. Cyberdeck remains authoritative for worker lifecycle, scoped budgets, consumption
accounting, and enforcement. A client renders broker state and submits a small validated command
set; it does not read Cyberdeck persistence or access provider processes directly.

## Transport and trust boundary

The interface uses the existing Cyberdeck broker Unix socket and newline-delimited JSON (JSONL).
It does not open a TCP port or add another daemon. `BrokerServer` creates the socket with mode
`0600`, limiting access to the current operating-system user. This is a local same-user boundary,
not a sandbox between mutually untrusted processes running as that user.

Every client request is one JSON object followed by `\n`:

```json
{"type":"request","id":1,"method":"local.worker.v1.snapshot","params":{"schemaVersion":1}}
```

Every request receives exactly one response carrying the same request ID:

```json
{"type":"response","id":1,"ok":true,"result":{"schemaVersion":1,"cursor":12,"generatedAt":"2026-08-24T10:02:00.000Z","workers":[]}}
```

Failures use the broker's ordinary error response:

```json
{"type":"response","id":1,"ok":false,"error":{"code":"INVALID_REQUEST","message":"..."}}
```

Clients must treat `schemaVersion` as a contract discriminator. Version 1 schemas are strict:
unsupported versions, unknown command actions, and unknown command fields are rejected rather than
silently ignored.

## Methods

### `local.worker.v1.snapshot`

Parameters:

```json
{"schemaVersion":1}
```

Result: one `LocalWorkerTelemetrySnapshot` as defined below. This method has no effect on worker
execution and does not subscribe the connection.

### `local.worker.v1.subscribe`

Parameters:

```json
{"schemaVersion":1}
```

Subscription is scoped to the requesting socket connection. The broker enables delivery before it
captures and returns the current full snapshot, so a state change cannot be lost between initial
read and subscription. Repeating the method on the same connection is idempotent.

Once subscription is enabled, relevant lifecycle or budget changes produce full snapshot frames:

```json
{"type":"local-worker-telemetry","snapshot":{"schemaVersion":1,"cursor":13,"generatedAt":"2026-08-24T10:02:01.000Z","workers":[]}}
```

Frames are full replacement snapshots, not patches. Because delivery is enabled before the method
returns, a newer frame can arrive before the request's response. Clients must correlate responses by
request ID, retain the snapshot with the greatest cursor, and may discard any snapshot whose cursor
is not newer than the last one observed during the current broker lifetime. A cursor is ordering
evidence, not a durable resume token; it may restart when the broker restarts. Reconnect by
subscribing again and using the returned full snapshot.

### `local.worker.v1.unsubscribe`

Parameters:

```json
{"schemaVersion":1}
```

Result:

```json
{"schemaVersion":1,"subscribed":false}
```

The method idempotently stops telemetry frames for that connection. Closing the socket has the same
subscription-cleanup effect and never pauses or stops any worker.

### `local.worker.v1.command`

Parameters are one strict v1 command object. Results are action-specific and described under
[Commands](#commands). Commands are validated and routed through broker-owned lifecycle and budget
services; this surface has no direct provider-process or persistence access.

## Snapshot read model

`LocalWorkerTelemetrySnapshot` contains:

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Read-model version. |
| `cursor` | non-negative integer | Monotonic snapshot ordering within the current broker lifetime. |
| `generatedAt` | ISO-8601 timestamp | Time the broker generated this projection. |
| `workers` | worker array | Broker-known worker sessions. Orchestrators are represented through parent links, not as worker rows. |

Each worker row contains:

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Worker-row version. |
| `sessionId` | UUID | Broker session and worker ID. |
| `parent` | object or `null` | Parent `sessionId` and `kind`: `worker`, `orchestrator`, or `unknown`. |
| `provider` | provider slug | Explicit provider identity. |
| `role` | string or `null` | Opaque worker role when present. |
| `model` | object | Model `value`, optional `effort`, provenance, and observation time. |
| `taskSummary` | string | Bounded display summary derived from broker session metadata. |
| `lifecycle` | object | Canonical worker truth, terminal flag, execution state, detail, start/end times, and elapsed milliseconds. |
| `budget` | object or `null` | Broker-owned scoped budget. `null` means no budget was declared. |
| `commands` | object | Per-row command capabilities safe for client presentation. |

`model.provenance` is `observed`, `launch`, or `unknown`. A `null` model value is unknown; it must
not be displayed as a provider default. The lifecycle object carries independent worker-truth
`state` and session `executionState`; clients must not infer one by rewriting the other.

Command capabilities are explicit:

```json
{
  "inspect": true,
  "stop": true,
  "extendBudget": true,
  "reduceBudget": true,
  "pause": false,
  "resume": false,
  "open": false
}
```

`inspect: true` means row contains inspectable broker state, not permission to attach to a PTY.
Clients should disable controls when their capability is false. Server validation remains
authoritative if state changes after a snapshot.

## Budget projection

Budget record lives on worker's durable `OwnershipSubject` in existing fsynced
`orchestration/worker-coordination-v1.jsonl` transaction log. No client owns or reconstructs it,
and no second session-record budget copy exists. Missing budget preserves prior worker behavior.

A non-null budget contains:

| Field | Meaning |
| --- | --- |
| `revision` | Positive allocation revision used for compare-and-swap updates. Consumption observations do not increment it; allocation changes do. |
| `resource` | `weekly` or `session`, naming the allowance the declaration protects. |
| `unit` | `percent`, `tokens`, or `wall-clock-ms`. |
| `allocatedAmount` | Current broker-owned allocation in `unit`. |
| `consumedAmount` | Best compatible broker measurement, or `null` when unknown. |
| `remainingAmount` | `max(0, allocatedAmount - consumedAmount)`, or `null` when consumption is unknown. |
| `measurement` | Source, accuracy, observation time, freshness, and optional unknown reason. |
| `providerRemaining` | Provider-wide remaining allowance when available, otherwise explicit unknown state. |
| `policy` | Soft and hard thresholds, actions, and trigger times. |
| `enforcement` | Current broker state (`active`, soft pending/notified, or hard reached/stop requested), allocation revision, threshold time, and completed-action time. |

Measurement sources are `provider-telemetry`, `terminal-token-counter`, `wall-clock`, and
`unavailable`. Accuracy is `exact`, `approximate`, or `unknown`; freshness is `fresh`, `stale`, or
`unknown`. Provider telemetry can be delayed or approximate. `null` consumption or provider
remaining means unavailable or incompatible, never zero.

Cyberdeck does not convert tokens or wall time into provider percentages. Arithmetic is exposed
only when measurement and allocation use the same unit. Clients must show accuracy, freshness, and
reason alongside numbers where those qualifiers matter, and must not promise exact percentage
accounting.

For percentage budgets, first provider allowance observation establishes scoped baseline;
subsequent decreases in provider remaining usage accumulate as worker consumption. Provider window
resets never subtract prior scoped consumption. First-turn usage before baseline and delayed
provider updates explain `approximate` accuracy. `wall-clock-ms` measures elapsed time since worker
creation, not CPU time.

Soft policy action is `wrap-up`. When compatible consumption reaches its threshold, Cyberdeck
persists the transition and sends a broker-owned wrap-up instruction through the durable worker
instruction queue. Hard policy action is `stop`. At the hard threshold, Cyberdeck persists the
transition, blocks further worker consumption paths, and uses the existing broker stop lifecycle.
Ammo cannot bypass either policy by disconnecting or by issuing a budget command: enforcement and
all mutation validation stay inside Cyberdeck.

## Commands

Every command includes:

- `schemaVersion: 1`
- `workerId`: target worker UUID
- `reason`: non-empty operator reason, at most 500 characters
- `mutationId`: stable non-empty retry identity, at most 200 characters

### Stop

```json
{
  "schemaVersion": 1,
  "action": "stop",
  "workerId": "11111111-1111-4111-8111-111111111111",
  "reason": "operator requested stop",
  "mutationId": "ammo:stop:11111111:1"
}
```

Result:

```json
{
  "schemaVersion": 1,
  "action": "stop",
  "workerId": "11111111-1111-4111-8111-111111111111",
  "mutationId": "ammo:stop:11111111:1",
  "status": "accepted",
  "revision": null
}
```

`status` is `accepted` or `already-terminal`. Stop uses the existing `SessionRegistry.stop()` path.
It is safe to retry because an already-terminal worker stays terminal.

### Extend budget

```json
{
  "schemaVersion": 1,
  "action": "extend-budget",
  "workerId": "11111111-1111-4111-8111-111111111111",
  "reason": "allow final verification",
  "mutationId": "ammo:extend:11111111:1",
  "expectedRevision": 2,
  "amount": 5
}
```

### Reduce budget

```json
{
  "schemaVersion": 1,
  "action": "reduce-budget",
  "workerId": "11111111-1111-4111-8111-111111111111",
  "reason": "tighten remaining allocation",
  "mutationId": "ammo:reduce:11111111:1",
  "expectedRevision": 2,
  "amount": 1
}
```

Both budget actions return:

```json
{
  "schemaVersion": 1,
  "action": "extend-budget",
  "workerId": "11111111-1111-4111-8111-111111111111",
  "mutationId": "ammo:extend:11111111:1",
  "status": "updated",
  "revision": 3
}
```

`amount` is positive and uses the budget's existing unit. `expectedRevision` is required. A stale
revision fails with `BUDGET_REVISION_CONFLICT`; the client should fetch a new snapshot before
deciding whether to retry. A reduction that would make allocation invalid, including non-positive
allocation, fails with `BUDGET_ADJUSTMENT_INVALID`.

Extension remains available after a hard-cap stop. It clears exhausted policy state but does not
resume or launch the worker; resume remains an explicit action through an existing Cyberdeck
surface. Reduction is refused for terminal workers.

Budget mutation receipts are durable. Retrying the identical operation with the same `mutationId`
returns `status: "idempotent"` and the committed revision. Reusing that ID with a different target,
direction, amount, expected revision, or reason fails with `MUTATION_ID_COLLISION`.

Commands also reject unknown sessions, orchestrator targets, terminal budget reductions, and
budget changes for unbudgeted workers. Errors are broker responses; no rejected command mutates
worker or budget state.

## Client independence and deferred controls

Telemetry is an optional observer. Never starting Ammo, closing it, losing a subscription, or
throwing from one subscriber does not affect provider output, lifecycle reconciliation, durable
budget accounting, soft-limit instruction delivery, or hard-limit enforcement. A later client can
always recover current state with `local.worker.v1.snapshot` or `local.worker.v1.subscribe`.

Version 1 deliberately omits `pause`, `resume`, and `open` commands. Current provider/session models
do not share a safe suspension primitive, session resume can restart a terminal conversation, and
raw PTY attachment grants broader control than this interface intends. Rows therefore advertise
all three capabilities as `false`. Future support requires a new reviewed broker-mediated contract;
clients must not emulate it through persistence access, process signals, or the existing attachment
protocol.
