# Worker truth: one state machine behind every surface

MIK-64 and MIK-71 are the same defect reported twice. An instruction was reported `delivered` while
its whole text sat unsent in a worker's composer under `tab to queue message`; a wait then settled
that instruction's completion target from a turn that had finished before the instruction existed;
and `workers_wait`, `threads_list`, and `worker_events` each answered "what is this worker doing"
from their own private reading, so an orchestrator could be told a worker was done, active, and
blocked at the same moment.

The fix is not more heuristics per surface. It is one projection, `src/domain/worker-truth.ts`, that
every surface renders.

## Worker states

`projectWorkerTruth` collapses process state, PTY activity, composer observation, and provider
termination into one value:

```text
starting                      waiting for a recognized input surface in this process generation
working                       provider is running a turn
blocked-modal                 provider is holding a prompt the operator must answer
blocked-composer              input surface holds text the provider has not taken
idle                          at a prompt, nothing pending
stalled                       transcript and token count unchanged past workerStallSeconds
provider-limit  (terminal)    provider stopped itself: usage cap or over-long prompt
errored         (terminal)    provider fault
stopped         (terminal)    operator stop, or an exhausted scout budget
exited          (terminal)    process ended on its own
failed          (terminal)    process ended badly, or a scout failed
```

Precedence is deliberate and is the part worth reading twice. A provider-declared limit outranks the
process outcome that followed it, because "the process exited 1" is true and useless next to "the
account hit its usage cap at 3:00pm". `blocked-modal` outranks `working`, because a provider draws
its spinner underneath its own permission prompt and the spinner is the thing every naive scraper
sees. `blocked-composer` sits below `working` but above `idle`: unsent text is not a finished turn.

`terminal` is carried on the value rather than inferred by each caller. A `provider-limit` worker is
terminal with its process still alive — the slot and the "can accept input" claim are released, and
stopping it is still required.

A limit belongs to the account, so it is durable: it is persisted on the record's `termination` and
rehydrated at recovery, because a broker restart folds `errored` into `failed` and reporting a
capped worker as a crashed one sends the operator to retry something that cannot run until the cap
resets. It is also generation-scoped: `resume` clears it, since the new generation has its own
budget and a stale cap would report a live worker as terminal for the rest of its life.

`completedTurns` counts turns the broker settled. `canonicalTurns` counts how many of those had a
provider transcript behind them rather than a terminal scrape. Two Codex workers stamping identical
completion seconds with zero semantic turns — the MIK-71 report — is now visible as
`completedTurns: 1, canonicalTurns: 0` instead of being indistinguishable from real work.

## Instruction lifecycle

An instruction has its own state machine, and it never runs backwards:

```text
accepted --deliver attempted, boundary unsafe--> queued
accepted/queued --bytes written to input surface--> rendered
rendered --provider observed consuming the payload--> submitted
submitted --provider turn started--> acknowledged
acknowledged --canonical turn for expectedTurn completed--> completed
accepted/queued/rendered/submitted/acknowledged --worker reached terminal--> undelivered
accepted/queued --withdrawn--> cancelled
```

Precise meanings, because the incident was caused by two of these being used interchangeably:

- **accepted** — the broker holds the instruction and has not attempted delivery. Durable; survives
  a busy worker.
- **queued** — delivery was attempted and refused. `holdReason` names which boundary refused it:
  `provider-starting`, `provider-modal`, `composer-occupied`, `provider-busy`, `human-controller`, `worker-terminal`.
  Everything behind a hold is queued with the blocker's reason rather than left reading as
  `accepted`. A held instruction is retried automatically at the next safe boundary; nothing else
  retries it. `provider-busy` is the ordinal boundary: an instruction written into a turn that was
  already in flight would be given that older turn's ordinal, and the answer to a question asked
  before it existed would settle the wait about it.
- **rendered** — the bytes are in the provider's input surface, and `expectedTurn` is fixed at the
  turn ordinal that will answer it. This is the strongest claim an enqueue call may return. It is
  explicitly *not* delivery: at a permission modal these are exactly the bytes the operator found
  sitting in the composer.

  A rendered instruction is also *verified* (`worker-submit-verification.ts`, MIK-260). A provider
  can take the text and drop the Enter — Codex's paste-burst heuristic did exactly that — so 1.5 s
  after the write the engine reads the composer again. If the composer's own content matches the
  head of the message the engine wrote, nothing is running and no dialog is up, it presses the
  provider's bare Enter again, at most twice, and records each press in the thread transcript as
  broker input. A draft the broker did not write is never submitted; a hint-only reading ("tab to
  queue message" with no readable line) is never enough; after the last press the entry stays
  `rendered` and the transcript says so.
- **submitted / acknowledged** — the provider was observed taking the payload and starting a turn.
  `submittedAt` is the only timestamp a delivery claim may cite.
- **completed** — the canonical turn for `expectedTurn` finished. `completedAt` is stamped here.
- **undelivered** — the worker exited, errored, or hit a provider limit with the payload still
  unconsumed. Reported, never silently dropped.

`delivered` is gone from the vocabulary. Records written before the rename are read as `rendered`,
which is the honest translation: bytes were written and nothing stronger was ever observed.

Automated interactive input also requires positive startup evidence from the current process:
a recognized empty composer, outside a modal and a running turn. Blank output and idle titles are
insufficient. The runtime observation adapter reads a bounded screen for this purpose, including
cursor positioning and erasure; incomplete synchronized redraws and unsupported screen edits hold
safely. Unknown startup remains `provider-starting` with the durable instruction queued. A wait
timeout never authorizes a write: inspect the provider if startup does not finish.

Launch and resume reset that evidence; callbacks from the replaced process cannot release it.
Startup repainting is not a model completion. Provider-native argv prompts and Cursor's direct,
suppressed initialization retain their existing transport and turn semantics. Claude headless
dispatch uses its native pipe/stream receipts and does not pass through this composer gate. This
does not promise compatibility with every future provider UI; a changed input surface needs a
verified parser update, rather than a speculative submission or trust decision.

## Waits

`settled` means every target reached a terminal result, not that time passed. A completion target
`N` settles only from the canonical completed turn for `N`:

- a turn that finished before the instruction was rendered cannot settle it — the floor is the turn
  count taken when the latest instruction was written;
- a replay of an already-delivered result is exempt from that floor, so re-waiting the same
  `sessionId` and `completionTarget` still returns `retrieval: "replay"` and stays idempotent;
- a composer holding unsent text is not a completed turn, so the idle timer refuses to increment
  `completedTurns` while one is observed. That reading has to know each provider's composer:
  Claude's is a box and prints `tab to queue message`; Codex's is a bare `› ` line, the same glyph
  it draws submitted prompts with, so it is recognised by position — the last `›` line with only
  the footer under it (`runtime/composer-state.ts`). Before MIK-260 the Codex composer was invisible
  to this reading, and an instruction the model never saw was banked as a scraped turn.

Delivery claims are backed by a provider turn or reported as undelivered. There is no third answer.

## Where it is projected

| Surface | Field |
| --- | --- |
| `cyberdeck_workers_wait` | `truth` on each result, plus `provenance` and `providerLimit` |
| `cyberdeck_threads_list` | `truth` and `termination` on each thread |
| `cyberdeck_worker_events` / `worker_ctl` | `truth` on the worker state summary |

They read the same `SessionRegistry.workerTruth`, which is what stops them contradicting each other.

