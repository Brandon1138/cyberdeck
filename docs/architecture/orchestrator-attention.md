# Explicit orchestrator attention waits

Slices 1 and 2 implement durable waiting, explicit consumption, and deterministic
attention scheduling through the existing instruction queue. Model evaluation and
live activation remain later review gates. Controllers without an attention record
retain their existing notification wake policy.

## Control and authority

`cyberdeck_attention_arm` takes an objective, unique worker session IDs with positive
completion targets, a next action, an optional UTC review deadline, and a stable
caller-generated UUID `mutationId`. It returns a broker-generated `epoch` immediately,
without joining workers. Idle alone never arms attention. The caller ends its turn
and continues using existing notifications or a deliberate synchronous join.

Both arm and cancel map to the existing `thread.enqueue` capability. Source reads and
receipt acknowledgements map to `thread.read`. Bindings, including peers, derive their
controller through `orchestratorController`; no new capability names or grants are
introduced. Arming requires each target to be a worker in the grant and held under
this controller's current active lease. Its lease version is captured and rechecked
after asynchronous source access. Worker text never supplies authority or changes the
wait statement.

Retry the same arm request with the same mutation ID. A changed request using that
ID is rejected. Replacing any prior wait, including a cancelled one, requires its
`previousEpoch` and a fresh mutation ID. A stale cancel or receipt cannot change a new
epoch. An authorized `ATTENTION_ALREADY_ARMED` conflict reports only the current
epoch/status, so a newly bound primary can discover its predecessor's tombstone and
explicitly retry the compare-and-swap. It does not silently take over the record.
`cyberdeck_attention_cancel` takes the exact epoch and an optional reason;
it does not stop workers, acknowledge reports, or change leases.

Operator stop, binding reset/replacement, and a durable cancelled Orc turn after
arming disarm attention. An older cancelled turn does not. Missing-process recovery
is held explicitly; this service never starts or resumes a process.
Loss of the current arm/read grant or target read scope cancels only that wait during
reconciliation, including startup. Authority is checked before and after source capture;
corrupt state and I/O errors still fail closed rather than becoming authority loss.

## One durable record

Each controller has one schema-v1 JSON file at
`orchestration/attention-v1/<sha256(controllerId)>.json` under the broker state directory.
The existing atomic private-file primitive writes a private temporary file, fsyncs it,
renames it, and syncs its directory. Cancelled waits remain as tombstones.

The record retains the statement, epoch and request identity, target authority,
source coverage, source gaps, latest decision slot, one pending intent slot, and
explicit consumption. Evaluated, noticed, scheduled, rendered, submitted, initiated,
and consumed coverage are separate from captured coverage. A decision and its one
stable-message pending intent are banked in the same atomic replacement before enqueue.
The latest wake retains instruction identity, holds, submission, attributed turn
initiation, explicit consumption, subsequent turn completion and observed dormancy.

Mutations serialize per controller and reread committed state before changing it.
An ambiguous write cannot leave cached authority that a retry might reuse. Committed
corrupt or unsupported records fail closed; startup does not substitute an empty wait.
Uncommitted `.pending` files are ignored and preserved.

## Source capture and receipts

Capture reads non-consuming worker-event projections, the existing worker truth, and
persisted completion ledgers. It does not call result delivery, notification drain,
or acknowledgement operations. Per-worker event ordinals, target completion receipts,
and semantic truth digests identify the snapshot. Registry updates, committed reports,
and directed handoffs trigger capture; unchanged semantic input does not rewrite state.
Startup and arm both reconcile after registration, covering reports or completions
that raced registration or never reached the notification inbox.

To read an armed wait, call `cyberdeck_notifications_read` with `attentionEpoch`.
The normal notification page is returned alongside `attention`, which includes the
statement, bounded worker reports and results, captured/consumed coverage, gaps, and
an opaque `receiptId`. Reading records a possible delivery, not consumption.
After receipt persistence, the broker rechecks the original actor's binding/grant,
target readability, and the persisted epoch/cancellation state before returning source
data. A refused delivery may leave an unacknowledged receipt; it never consumes sources.

After receiving and processing that page, call the same tool with its `attentionEpoch`
and `attentionReceiptId`. Do not combine this with `acknowledgeThrough`. The broker
first persists the receipt's exact source coverage as consumed, then selectively
acknowledges only the notification IDs that page returned. A crash between these steps
can safely replay the same acknowledgement. Arrivals during either step remain outstanding.
Filtered notifications and source reports beyond the page bound are never implicitly
consumed by a larger notification cursor.

Waits allow 32 workers. A source page returns at most 50 report summaries, each bounded
to 512 characters, and each exact completion result respects `maxResultChars`. Source
heads retain the full outstanding coverage; `moreReports` exposes unread backlog.
Missing workers, supervision loss, and unavailable exact completion receipts are explicit
gaps. A completion high-water without its target receipt never consumes that result.
Neither idle nor process exit establishes task success.

The latest eight read receipts are retained. An older receipt is refused conservatively;
read again to obtain a fresh receipt. A later acknowledgement of an older retained page
cannot regress source coverage or overwrite newer consumed truth. Source payloads remain
in their existing journals; this is not a second notification queue.

## Deterministic scheduling and recovery

The existing notification feed composes attention scheduling. Source, authority,
inbox-policy and instruction-lifecycle changes trigger serialized reconciliation;
nearby changes use the existing notification policy's coalescing interval. Review
deadlines use a broker timer and are reconstructed on startup. There is no polling
Orc, second notification queue, model adapter, or remote inference in this slice.

The group-wait reference policy defers ordinary progress, recovering errors and
partial results while awaited work can progress. Broker policy overrides deferral
for explicit intervention, source/supervision gaps, an unresolved oversized backlog,
all awaited work stopping, and the review deadline. Unknown activity never proves
work stopped or succeeded. Policy scans report metadata beyond the 50-summary read
page; after 1,000 reports per worker it conservatively surfaces the backlog. Deferral
never acknowledges or discards anything. Two failed/invalid local fixture decisions
fall back to a durable wake; unchanged semantic inputs are not evaluated again.

The attention record owns wake policy once the controller explicitly opts in. A
cancelled tombstone keeps idle from reviving that wait through the legacy wake path.
Legacy notices remain readable, and controllers that never used attention retain
legacy wakes. Existing queued legacy wakes become obsolete for an opted-in controller.
No ordinary instruction is withdrawn or granted different ownership.

One pending intent per epoch carries a stable message ID and source coverage.
Simultaneous arrivals coalesce into it; later developments remain outstanding and
cannot enlarge what a prior rendering/submission proved. Existing queue deduplication
is serialized per target, including concurrent enqueue retries. Startup recovers the
intent-before-enqueue and enqueue-before-bookkeeping crash gaps from that same queue.
Authoritative worker reports and completion receipts reconstruct inbox crash gaps and
overflow. No inbox cursor or shown hook notice establishes attention consumption.

Every attention wake delivery attempt, including a held queue flush, runs the same
control-plane authority transaction after native provider preflight. It holds epoch
serialization through the final binding lookup and provider write, rechecking grants,
stop state, missing-process recovery and current relevant lease state. Supervision-loss
wakes report the loss; they confer no authority over the transferred worker. A later
submit-verification retry re-enters that transaction and rechecks its own composer,
modal, process-generation and operator-quiet gates. Already rendered bytes cannot be
withdrawn, and rendering alone never proves submission, turn initiation or consumption.

Provider capacity, permissions, human input, composer/modal and ordinary-instruction
ownership gates remain in the existing admission machinery. Missing processes remain
durably held, with no start/resume call. Notification `wake: off` and hourly ceilings
hold the persisted intent; policy changes and the budget-expiry boundary retry it.
Attention counts existing durable wake instructions for its rolling ceiling across
restart. The unchanged legacy wake budget is still process-local.

Wake-off is checked synchronously at the final authority boundary, including retries
of already rendered text. It records a visible hold without cancelling the stable
intent. Temporary submit refusals use the existing eight-check/two-press bounds;
obsolete entries stop. Re-enabling a policy-held rendered wake re-arms that same
entry's verification even after its check window expired, retaining its press count,
generation fence and all admission gates. It never retypes the payload. Legacy wake
recovery excludes attention-epoch instructions on both inbox changes and startup.

An unrelated active Orc turn does not discharge the pending intent. Explicit receipt
acknowledgement clears it only when the consumed source coverage contains that intent;
partial pages retain it. An exact page read before banking can satisfy the same covered
obligation. New arrivals during reading/acknowledgement remain outstanding. Reading an
attention page also exposes the latest decision, pending intent and wake evidence so
delivery/recovery holds are visible without claiming receipt consumption.

## Compatibility and next gate

Existing callers that omit attention fields keep their cursor acknowledgement and
result-delivery semantics. Their acknowledgements do not imply attention consumption.
The existing notification JSONL format already supports selective IDs; its schema,
worker coordination journals and binding grants are unchanged. Instruction wakes add
an optional `attentionEpoch`; attention-only wakes allow an inbox cursor of zero when
authoritative sources exist without an inbox record. Legacy wakes still require a
positive cursor. Ordinary instruction records retain their existing interpretation.
Previously handled legacy reports may conservatively appear on the first attention
read because they have no attention consumption receipt.

Existing schema-v1 attention records load without migration; the scheduling fields
are optional. Slice-1-only readers reject extended records conservatively, so rollback
to those readers is not forward-compatible. The latest wake identity is retained when
an Orc explicitly re-arms; each epoch has fresh decision and pending-intent slots.

The simulated-provider lifecycle test uses the real session registry, feed, queue,
private-file/journal persistence and receipt API. A scripted provider reads a unique
worker value, writes a disposable artifact from it, explicitly acknowledges, completes
its attributed turn and re-arms. Provider observations are fixtures, including the
native-shaped transcript frames. This is source/fixture proof, not a live-model or
shared-broker/JEV canary. Slice 2 stops at independent review; snapshots/adapters and
active JEV/live proof belong to separately released slices 3 and 4.
