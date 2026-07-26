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
