# Standing constraints

Entries in this section are **not stale** and are not superseded by anything below. They describe
properties of the terminal, not decisions we are free to revisit. Everything after this section is a
dated Open/Resolved log and may well be out of date; these are not. Do not re-litigate them, and do
not accept a spec that violates one without saying so out loud to the operator first.

## `Ctrl+[` can never be bound to anything

A terminal transmits `Ctrl+[` as byte `0x1b`. That is the same byte Esc sends. Not similar — identical.
No amount of care in the decoder can separate them, because there is nothing to separate: by the time
the bytes reach us, the two keys have produced the same input. The same applies to `Ctrl+M`/Enter
(`0x0d`), `Ctrl+I`/Tab (`0x09`) and `Ctrl+H`/Backspace (`0x08`).

This was specified as the detach key, implemented, shipped, and reverted — see "Resolved: Esc and
Option+Enter were stolen from the attached provider" below for the damage. Every bare Esc ejected the
operator out of the attached provider, and because an `ESC`-prefixed byte below `0x20` is exactly how a
terminal encodes an Alt/Meta chord, Option+Enter and friends detached too.

The only mechanism that could distinguish them is the Kitty keyboard protocol (CSI-u), which the fleet
deliberately *pops* on entering its screen, and which would have to be forced on the attached Claude
Code or Codex TUI as well — breaking their input handling to buy one keybinding. Not a trade worth
making.

Detach and reattach are therefore both `Ctrl+]` (`0x1d`), deliberately. The two contexts are disjoint —
`Ctrl+]` in the fleet list attaches, `Ctrl+]` while attached detaches — so the overload is never
ambiguous in practice. Confirmed with the operator on 2026-07-29 as the preferred behaviour, with the
constraint understood.

# Dated bug log

## Open: Fleet learns about provider progress only by asking, every 500 ms

Found on 2026-08-14 while fixing the dancing caret. Fleet's loop collects a whole snapshot, renders
it, and then waits 500 ms before doing it again — an idle cadence under 2 FPS. Nothing a detached
provider writes wakes that loop: `waitForRefresh` is resumed by a key, by a chunk of `!` shell
output, by `SIGWINCH`, by an attach transition, and by the transport closing — and by nothing else.
A worker that finishes between two ticks is on screen up to half a second later, and there is no
path by which the broker can say so sooner.

The repaint itself no longer costs anything when nothing changed — an identical frame is not written
at all, so the pane is left as it stands rather than cleared and painted back — and the frame that is
written is atomic behind a hidden caret. That removes the flicker the cadence used to produce; it
does not make the cadence a subscription.

Not fixed here: waking on provider output means a broker-side event Fleet subscribes to, which is a
transport change rather than a rendering one, and the fix for the caret had no business carrying it.

## Open: a decision gate is cleared by an answer to any checkpoint, not the matching one

Found on 2026-07-27 by the worker-coordination integration matrix (MIK-55 Wave 2d). An
`OwnershipSubject` carries a single `decisionGate`, and `WorkerCoordinationService.requestCheckpoint`
overwrites it whenever a `decision-gate` checkpoint is opened. The answer path in `submitEvent`
clears the gate on any answered `decision-gate` checkpoint without comparing the answered
`correlationId` against `decisionGate.correlationId`.

Repro: open two `decision-gate` checkpoints (`gate:a`, then `gate:b`) on one worker, then submit a
CHECKPOINT event carrying `checkpointCorrelationId: "gate:a"`. Expected `decisionGate` to stay
`{ state: "decision-gate", correlationId: "gate:b" }`; actual is `{ state: "none" }` while `gate:b`
is still pending. A worker that is still blocked therefore reads as resumed. The current behaviour is
pinned by `tests/integration/worker-coordination-events.test.ts` so the fix has a failing assertion
to flip. Not fixed here: correcting it means deciding whether a subject may hold several gates at
once, which is a substrate design change rather than a minimal diff.

## Open: `inactive-controller` adoption is unreachable for a controller that died silently

Found on 2026-07-27 by the same matrix. The `inactive-controller` selector only returns subjects when
a `disconnected` liveness observation exists for that controller and the grace period has elapsed
since `observedAt`. A controller whose lease simply timed out — no observed disconnect — is swept to
`orphaned` by `expireLeases`, yet the selector still resolves to an empty set, so an adopter that
knows only the dead controller's id gets zero outcomes and no explanation.

Repro: register a worker under a controller, never report liveness, advance past the lease TTL, run
`expireLeases` (the worker becomes `orphaned`), then `adopt` with
`{ scope: "inactive-controller", controllerId }`. Expected the orphan to be selected; actual is
`outcomes: []`. The `group`/`single` selectors do recover the same worker, so this is a reachability
gap rather than data loss. Not fixed here: the selector's grace check exists to stop a live
controller being adopted out from under itself, and relaxing it correctly is a substrate decision.

## Resolved: every Fleet repaint was a chance at a black frame

Reported on 2026-08-15 by the operator: the fleet pane flashes fully black for about a frame, every
few seconds at idle and far more often while a worker streams. `writeFrame` painted by writing
hide-caret, `ESC[2J`, `ESC[H` and the whole new frame in one `write`. One write is not one screen
update — nothing stops the terminal from compositing after the erase and before the rows land, and
what it draws then is an empty pane. Every legitimate repaint could show one, so the flash tracked
whatever changed the frame: the relative-age column each second, snapshot and preview deltas while a
worker streams, the five-second confirmation expiry.

The repaint now overwrites the pane in place. Home, each row written over the row it replaces with
`ESC[K` taking the old row's tail with it, `ESC[0J` after the last row for anything a taller frame
left below. There is no instant in that sequence at which the pane is empty. A clear is still right
where there is nothing underneath to overwrite — the first frame on a screen, and the first after a
resize reflowed the pane — and both are exactly the cases that leave `paintedFrame` unset, so the
same field answers both questions. The frame dedup that fixed the dancing caret is untouched: an
identical frame is still not written at all.

Not done here: DEC mode 2026 synchronized output, which asks the terminal to hold the update rather
than removing the empty state. The operator chose the repaint over the mode — one depends on the
terminal honouring a private mode, the other cannot flash on a terminal that ignores everything.

## Resolved: a Cursor orchestrator's first turn outran its own grant

Observed on 2026-07-31 by the operator, and confirmed by review on the branch that introduced Cursor
as an orchestrator provider. The Cursor CLI has no system-prompt flag, so `providerInstructions` are
delivered the only way it accepts them: as the session's first message, submitted from
`CursorSessionAdapter.initializeSession`. That call runs *inside* `SessionRegistry.start`.
`OrchestratorManager.createBound` then built its `OrchestratorBinding` — the grant — only after
`start` had already resolved.

An orchestrator that has just been told what it is reaches for Cyberdeck's tools immediately, so the
opening move raced the record that authorizes it. `requireBinding` found nothing and answered
`ACTOR_NOT_AUTHORIZED`. The operator's report of the symptom was a model replying to the effect of
"I received the guidance but no work" and then spending a full reasoning turn against no objective,
which is what an orchestrator does when its first tool call is refused and it cannot see why.

Codex and Claude never exposed this. They carry guidance natively — `developer_instructions` and
`--append-system-prompt` — so no model turn starts inside `start` for them at all (see "cockpit
startup leaked an invisible tmux session and a failed orchestrator" for why orchestrator startup
emits no positional initial prompt). Cursor is simply the first provider whose instructions have to
be a turn.

Resolved by making the grant durable *during* the start rather than after it. `SessionRegistry.start`
takes an optional `activate` callback and runs it once the pty is adopted and before
`adapter.initializeSession`, and `createBound` persists its binding from inside that callback. The
call sits within the existing initialization `try`, so an `activate` that throws tears the session
down on exactly the path a failed initialization already used — a session is never left live but
unauthorized, and no new error path was added. Because the window is closed in the registry rather
than in the Cursor adapter, it is closed for every provider, including any future one that also has
to be instructed by message.

Rollback needed care in one place. A start that fails after the grant is already durable would
strand a binding pointing at a session that never lived, so `createBound` restores the binding it
replaced, exactly as it was, instead of resetting the key. A blanket reset would destroy a healthy
existing orchestrator whenever a rebind failed.

The worker start path was checked for the same ordering and does not have it: a worker holds no
grant of its own, its authority is the parent orchestrator's grant checked before `registry.start` is
called, and the worker-facing event channel resolves through the in-memory session map that is
populated before initialization begins.

## Resolved: one failed append poisoned every later write to the coordination log

Found on 2026-07-27 by the same matrix. `WorkerCoordinationStore` serialises appends through a
`writeTail` promise chained with `.then(write)`. A single transient failure — a full disk, a state
directory replaced out from under the broker — left `writeTail` rejected forever, so every subsequent
`append` re-threw the original error without ever attempting a write, and the broker could never
recover without a restart even after the underlying fault was repaired.

Resolved by chaining on settle rather than on success (`this.writeTail.then(write, write)`), matching
the error-tolerant serialisation the service already uses for its own mutation queue. A failed
mutation still rejects to its caller and still leaves no in-memory or on-disk trace; the next
mutation now runs.

## Resolved: Esc and Option+Enter were still wrong after the attach-layer fix

Observed on 2026-07-26, after `4cb2b93` had already made `src/client/attach.ts` forward Esc and every
Alt chord to the provider. That commit was correct and remains correct — it was simply not the whole
input path. Two other layers consume the same bytes before or after an attachment.

**Fleet's own decoder.** `FleetKeyDecoder` resolved `ESC` plus a following byte as two keys: an
`escape` and then whatever the second byte named. In the fleet composer, Option+Enter (`0x1b 0x0d`)
therefore cleared the draft and then acted on Enter, which opens the selected thread — the reported
"minimizes my conversation or enters my conversation", both from one keypress. Whether both halves or
only the first arrived depended on whether the two bytes landed in the same read, which is what made
the same gesture behave differently on different attempts. An Esc prefix is now resolved into the one
chord it names, and a chord the fleet does not bind does nothing rather than decaying into its halves.

**A keyboard protocol left switched on.** A provider TUI can enable a mode that reports ordinary keys
as `CSI <code> ; <modifiers> u`, and that mode outlived the attachment because `ENTER_FLEET_SCREEN`
reset mouse and focus reporting but not the keyboard protocol. Every such report then fell through
the decoder's anonymous-CSI branch and was dropped, so after visiting one provider Esc did nothing at
all in the fleet, while after visiting another it worked. The lone `\u001b[13u` special case in the
decoder was the visible scar of this. The fleet now pops the keyboard protocol and bracketed paste on
entering its screen, and decodes CSI-u reports by name for the case where a terminal keeps them on.

**tmux held the bytes first.** The cockpit's tmux session ran with the default `escape-time` of
500ms. tmux waits that long before deciding a bare Esc is not the start of a sequence, so inside the
cockpit Esc reached the agent half a second late — indistinguishable from being swallowed — and the
same window decided whether Option+Enter arrived as one Meta chord or as an Esc followed by a
separate Enter that submitted. The cockpit now sets `escape-time` to 10ms, which still reunites a
sequence split across reads.

Disambiguating a bare Esc from the first byte of a sequence is unavoidable, and both remaining
decoders resolve it the same way: bytes are consumed as they arrive, and a wait happens only when a
read *ends* on a strict prefix of something longer. Arrow keys, function keys, CSI-u reports and
pastes all complete within their own read and are forwarded with no delay. Only a bare Esc that is
the last byte of a read waits, for one 25ms window. Pastes are now opaque in `attach.ts`: a `0x1d` or
a Left Arrow inside pasted text is data, not a detach chord.

# Known bugs

## Resolved: Esc and Option+Enter were stolen from the attached provider

Observed on 2026-07-25 with Claude Code attached from Ghostty. Detach was bound to `Ctrl+[`, which a
terminal transmits as byte `0x1b` — the exact byte Esc sends. The two keys are indistinguishable at
the byte level, so every bare Esc ejected the operator to Fleet instead of interrupting the turn,
steering mid-flight, or leaving a picker.

The same handler also treated `ESC` followed by any byte below `0x20` as a standalone `Ctrl+[`. That
is precisely how a terminal encodes Alt/Meta chords when Option-as-Meta is enabled, so Option+Enter
(`0x1b 0x0d`), Alt+Ctrl+<letter>, Alt+Tab, and Alt+Backspace-as-`^H` all detached as well.

Resolved by moving detach to `Ctrl+]` (`0x1d`) for every attachment kind. That byte was already
consumed as a strict no-op while attached, so the provider loses nothing it could previously receive,
and no new byte is taken from a TUI. `Ctrl+[` and every `ESC`-prefixed chord are now forwarded
verbatim. Left Arrow remains the directional return from a worker; an orchestrator keeps Left Arrow
for its native TUI and detaches with `Ctrl+]`. The 25ms escape-coalescing window survives only to
reunite a Left Arrow split across reads, and its expiry now forwards the pending bytes to the
provider, so a slow or remote link degrades to a real keystroke instead of a surprise detach.

## Resolved: cockpit startup leaked an invisible tmux session and a failed orchestrator

Observed on 2026-07-22 from a Ghostty shell already running inside a named tmux server. Two
independent failures combined:

- Cyberdeck inherited `$TMUX`, created its workspace cockpit in that server, then called
  `attach-session`. tmux rejected the nested client and left the new `cyberdeck-*` session detached
  and invisible.
- The supplied Codex model string used an unsupported short alias; the exact local catalog identifier
  is `gpt-5.6-sol`. Because orchestrator guidance was passed as the positional initial user prompt, the
  provider attempted a model turn immediately and received a 400 before the cockpit was visible.

Resolved transactionally. Cockpit preflights native tmux before provider ensure, uses
`switch-client` when `$TMUX` is set and `attach-session` otherwise, and rolls back only a tmux session
created by the failing invocation. Orchestrator ensure reports created versus reused; presentation
failure stops only a newly created provider session, allowing its session-scoped MCP child to exit,
and preserves a reused session. Cleanup errors are appended to the original presentation failure.

Orchestrator startup now emits no positional initial prompt. Codex receives guidance through native
`developer_instructions`; Claude receives `--append-system-prompt`; provider-native resume retains
the same guidance and MCP configuration. The append-only binding registry now supports
`cyberdeck orchestrator reset`, refuses to orphan an active orchestrator, and permits a clean explicit
rebind after reset. Cyberdeck still treats model identifiers as opaque and performs no alias mapping
or fallback.

## Resolved: mouse movement wrote terminal coordinates into the Fleet composer

A provider TUI could leave SGR mouse-motion reporting enabled after detachment. Fleet re-entered its
alternate screen without reclaiming those terminal modes, and its per-chunk decoder interpreted the
printable suffix of reports such as `ESC[<35;103;24M` as task text.

Resolved by disabling inherited mouse/focus modes every time Fleet becomes active and by replacing
the per-chunk decoder with a buffered CSI decoder. Complete and fragmented mouse reports are now
consumed atomically instead of reaching the composer.

## Resolved: `cyberdeck send` did not submit prompts in current interactive providers

Observed on 2026-07-22 with broker-owned Claude Code 2.1.216 and Codex CLI 0.144.6 PTYs.

```bash
cyberdeck send SESSION_ID "Reply with exactly CYBERDECK_HAIKU_PING_OK"
```

The command writes the prompt into the provider's editor, but does not submit it. Attaching to the
same session and pressing Enter submits the queued prompt successfully.

The CLI currently appends LF (`\n`) in `src/cli.ts`, but an interactive TUI's submit key is not a
portable newline byte:

- Claude accepted CR (`\r`) as Enter; LF only populated its editor.
- Codex enabled the Kitty keyboard protocol; LF and CR only edited its prompt, while the encoded
  Enter key (`CSI 13 u`) submitted it.

Resolved in the v1 fleet implementation by adding a logical `session.submit` operation. Provider
adapters now encode the observed terminal Enter contract: CR for Claude and `CSI 13 u` for Codex.
Focused regression tests cover both encodings, and raw `session.send` remains available to attached
PTY controllers.

Historical workaround: run `cyberdeck attach SESSION_ID`, press Enter, then detach with `Ctrl-]`.
