# Known bugs

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
