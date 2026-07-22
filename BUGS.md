# Known bugs

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
