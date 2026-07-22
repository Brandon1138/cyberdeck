# Cursor Agent adapter

B3 adds Cursor's bounded `JobDispatchAdapter` and an interactive command builder through the
evidence-backed canonical provider id `cursor` and executable `agent`. It does not self-register or
alter shared contracts: composition registers `CURSOR_PROVIDER_DESCRIPTOR` through A1's open
`ProviderRegistry` seam and registers `CursorJobDispatchAdapter` through A2's adapter seam.

The interactive session contract now consumes the same open provider identity and registers
`CursorProviderAdapter` in the broker. `session.start`, Fleet slash launches, and orchestrator
`worker_start` therefore accept the explicit `cursor` provider. Provider-native resume is still
unverified and fails with `SESSION_RESUME_UNAVAILABLE` rather than creating a different chat.

## Commands and permissions

The current `agent --help` metadata observed on 2026-07-21 documents `--workspace`, `--sandbox
enabled|disabled`, `--mode plan|ask`, `--print`, `--output-format stream-json`,
`--stream-partial-output`, and `--model`. It documents the initial instruction as a positional
`prompt`; it does not document a stdin input format.

Interactive, with an optional explicit initial prompt:

```text
agent --workspace <cwd> --sandbox enabled [--mode plan] [--model <explicit>] [prompt]
```

Bounded/headless:

```text
agent --print --output-format stream-json [--stream-partial-output] \
  --workspace <cwd> --sandbox enabled [--mode plan] [--model <explicit>] <instruction>
```

Both the process `cwd` and `--workspace` are the explicitly requested directory. The interactive
initial prompt and bounded instruction are final argv operands. Headless stdin is immediately closed. `role` stays an opaque
control-plane label and is not forwarded.

| Cyberdeck sandbox | Cursor mapping | Evidence/status |
| --- | --- | --- |
| `read-only` | `--sandbox enabled --mode plan` | help-advertised; fixture-proven argv; live-unverified |
| `workspace-write` | `--sandbox enabled`, no read-only mode | `--print` advertises write/shell tools and sandbox is explicit; fixture-proven argv; live-unverified |

Cursor advertises only `plan` and `ask` as read-only modes, so B3 does not mislabel them as
workspace-write. It also does not emit `--force`, `--yolo`, `--auto-review` (Smart Auto),
`--approve-mcps`, `--trust`, worktree flags, API keys, automatic model selection, fallback, resume,
or continuation. A caller-supplied model is forwarded exactly once; omission stays omission.

## Output, cancellation, and evidence boundary

`CursorStreamDecoder` proves newline-delimited JSON framing mechanics against deterministic B1
fixtures: split frames, multiple frames, malformed lines, and truncated tails. The field schema and
terminal-result fields inside real Cursor `stream-json` remain live-unverified. The default result
interpreter therefore fails closed rather than fabricating completion. A validated neutral
`JobReport` is emitted only from an explicitly injected interpreter once those mechanics are
established. A non-zero exit, signal, process error, or malformed/truncated frame is always a failed
neutral result and cannot be overridden by the interpreter.

Cancellation marks the job before sending `SIGTERM`; the exit handler emits exactly one cancelled
report and removes the job from active tracking. An optional positive timeout likewise sends
`SIGTERM`, then reports `timedOut` on exit without interpreting provider frames. Duplicate job IDs
are rejected before a second process is constructed. No provider-native resume/continue behavior
or durable conversation continuity is claimed.

Automated tests inject `tests/fixtures/recording-agent.mjs` or an in-memory process handle. They
never resolve or spawn the installed `agent`, never authenticate, and make no network or model call.
Interactive prompt submission and terminal behavior therefore remain live-unverified.
