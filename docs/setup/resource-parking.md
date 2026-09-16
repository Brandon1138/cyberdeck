# Resource-aware idle parking

`RuntimeParkingService` implements idle grace, parking intent, fenced wake and
restart reconciliation. It does not allocate memory, release reservations,
launch providers directly, infer controller identity or write instruction bytes.
Root broker composition remains responsible for enabling the service; no live
provider, broker or container was used to validate this implementation.

Create one concrete port with `registry.createParkingPort(options)` and supply:

- `facts(sessionId)`: the current canonical controller/lease epoch, durable
  instruction statuses, confirmed native conversation ID, demonstrated resume
  capability, and tracked outstanding tool/pending report counts. Unknown counts
  must be `null`. These are synchronous broker read models, not worker assertions.
- `onInputQueued(sessionId)`: call `service.inputQueued(sessionId)` synchronously
  and observe its returned promise/error. This latches intent before an async
  park/stop boundary can discard it. Also call it when the durable instruction
  queue accepts input, before attempting delivery.
- `flush(sessionId)`: the existing instruction queue's `flush`, preserving its
  IDs, ordinals, provider-readiness checks and durable delivery state.
- Optional `stopDeadlineMs` (default 30 seconds, maximum 60 seconds).

Then construct `RuntimeParkingService(port, store, {idleGraceMs})`. The store
implements synchronous `get` and durable `put`; persist it in the installation's
private state. Poll `consider(sessionId)` on a bounded broker cadence. Explicit
wake and queue arrival use `wake`/`inputQueued`. The service has no polling timers
or automatic restart loops; failed wakes require intervention/reconciliation.
The default wake-attempt bound is one, configurable up to three.
Call `forget(sessionId)` after ordinary retirement to discard volatile idle clocks;
it refuses an in-flight transition and leaves durable evidence retention unchanged.

The registry port refuses construction without the common `resourceExecution`
start gate. Wake invokes ordinary session resume through the existing assembly,
which obtains admission again before any replacement provider launch. A callback
rechecks the canonical claim after resource queueing and provider preparation.
The ordinary generation barrier retires old observations; successful wake must
advance exactly one generation and preserve workspace and native conversation.

Parking requires canonical idle truth, at least one native completed turn,
settled capture/commit barriers, no accepted/rendered/submitted instruction,
clear composer/modal state, zero known outstanding tools/reports, no operator
controller or watcher, and confirmed resume support. A `done` badge, screen-only
completion, unknown report/tool inventory or provider process liveness is not
enough. Any activity/revision change restarts idle grace.

The concrete registry port atomically compares the entire snapshot and installs
an input/attachment fence before parking intent is written. Input arriving
before stop cancels that transition. Input arriving after stop starts remains
queued, waits for provider exit and canonical terminal settlement, and wakes
once through admission. During a fence, `submitInstruction` returns queued with
the existing `provider-busy` hold. It never marks a parked worker's new input
undelivered. Attachments are refused while requesting wake; the caller retries
after resume. Raw input is never silently buffered as an invented instruction.

Graceful stop preserves an already completed outcome. No SIGSTOP/freeze is used.
`parked` means the provider runtime is stopped and resumable; it does **not**
prove its container or every descendant has terminated or that RAM was released.
The shared resource runtime remains sole owner of tree/container reconciliation
and reservation release. If that proof is unavailable, wake may wait for capacity
while the existing durable instruction remains queued.

Handoff before stop invalidates the old claim. A handoff while already parked
may wake the same worker using its new canonical epoch. Old-generation callbacks
cannot stop or wake a replacement. A changed native conversation/workspace,
unknown stop outcome, failed admission/auth renewal, failed durable intent, or
unexpected generation enters an explicit intervention state.

On restart, call `recover(sessionId)` for persisted non-active records **before
reopening input delivery**. Recovery restores the parked input fence only when
the exact recorded generation/workspace/conversation is already stopped. An
already completed wake is recognized only at generation +1 with matching
conversation, workspace and canonical epoch. Unknown running/stopping state is
intervention, not permission to kill or declare resources free. Terminal state
and queue evidence remain durable; do not erase them to bypass a failed wake.

Focused tests cover the service races and concrete registry input fence, ordinary
stop/resume, shared admission on wake, stale handoff while queued for admission,
and recovery. Live same-conversation Claude/Codex park/wake/report canaries,
measured memory release and container/helper cleanup remain acceptance gates for
root orchestration. No production activation is implied by these unit tests.
