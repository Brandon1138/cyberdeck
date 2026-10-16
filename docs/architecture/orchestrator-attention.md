# Explicit orchestrator attention waits

Slice 1 implements durable waiting and explicit consumption. Attention scheduling,
the liveness floor, model evaluation, and live activation remain later review gates.
Existing notification wakes continue to use their existing policy.

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
explicit consumption. Evaluated, noticed, submitted, and consumed coverage are separate
from captured coverage. Decision and wake-intent fields are only a persistence contract
in this slice; no model or wake producer writes them.

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

## Compatibility and next gate

Existing callers that omit attention fields keep their cursor acknowledgement and
result-delivery semantics. Their acknowledgements do not imply attention consumption.
The existing notification JSONL format already supports selective IDs; its schema,
worker coordination journals, instruction records, and binding grants are unchanged.
Previously handled legacy reports may conservatively appear on the first attention
read because they have no attention consumption receipt.

Slice 2 must connect this state to the existing instruction queue, persist a decision
and stable pending wake ID before enqueueing, apply epoch/binding/lease fencing at
execution, and distinguish rendering, observed submission, turn initiation, explicit
consumption, and later progress. It must enforce group settlement and review deadlines,
reconcile every relevant authority/source change, preserve human/composer/modal gates,
and prove recovery with simulated providers. It begins only after independent review
of slice 1. No live JEV, broker activation, or autonomous provider proof is claimed here.
