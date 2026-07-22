# Claude adapter

One provider, two execution dimensions. Interactive (durable PTY) and headless (bounded job) are
two ways of presenting the same Claude provider, not two providers. The broker/runtime still owns
processes.

- Interactive: `src/providers/claude.ts` implements A1's `ProviderAdapter`.
- Headless: `src/providers/claude/dispatch-adapter.ts` implements A1's `JobDispatchAdapter`.

## Launch safety

`evaluateClaudeLaunchSafety` runs at both spawn boundaries, before any argv exists:

- Interactive — inside `buildLaunchSpec`, which the session registry evaluates as the argument to
  its pty factory, so a refusal happens before the process is constructed.
- Headless — inside `buildClaudeHeadlessCommand`, before `spawn` is reached.

An **omitted** model is refused because it is not an explicit operator choice. An explicitly named
Fable model is valid on an operator start path. Autonomous worker starts pass through the separate
orchestrator capability boundary and require `worker.start.fable` before this adapter is reached.
Cyberdeck never selects, defaults, ranks, or substitutes a model, and never emits
`--fallback-model`. `role` is an opaque label and is never forwarded.

## Commands

Interactive:

```
claude --session-id <uuid> --name <name> --permission-mode <plan|manual> [--model <explicit>]
```

Headless:

```
claude --print --input-format text --output-format stream-json \
       --permission-mode <plan|manual> [--include-partial-messages] [--model <explicit>]
```

Both run with `DISABLE_UPDATES=1` and the caller's `cwd`. The instruction travels on **stdin**
(then closed) rather than as an argv operand, so a long or shell-sensitive instruction cannot be
mangled.

Sandbox mapping, confirmed against the installed CLI's `--permission-mode` choices
(`acceptEdits | auto | bypassPermissions | manual | dontAsk | plan`):

| Sandbox | Permission mode |
| --- | --- |
| `read-only` | `plan` |
| `workspace-write` | `manual` |

`bypassPermissions` and `dontAsk` are never emitted.

## Session persistence is not process lifetime

The headless path emits no `--resume`, `--continue`, `--fork-session`, `--from-pr`, or
`--session-id`. Provider-native conversation persistence and a Cyberdeck process lifetime are
different things, and the exact resume mechanics are unverified. A bounded job is a fresh
invocation and claims no continuity.

## Why the default interpreter fails closed

Stdout is decoded as newline-delimited JSON — the framing the CLI documents — into **opaque**
values. The *fields inside* a `stream-json` frame are not documented by help, and B1 recorded both
that schema and Claude's exit semantics as unverified.

Deriving `completed` or `failed` from either would fabricate provenance the provider never gave, so
`unverifiedClaudeResultInterpreter` is the default and refuses, settling the job `failed` with
`DISPATCH_REJECTED` and an explicit capability message. Callers inject a real
`ClaudeResultInterpreter` once the mechanics are verified against a live run. Cancellation is
exempt: it is Cyberdeck's own fact and settles as `cancelled` without provider interpretation.

No provider-native frame crosses A1's port. Only a validated, neutral `JobReport` leaves the
adapter, and `usage` is present only when actually reported — never fabricated as zero.

## Registration

The adapter is exported, not self-registering. Composition registers it through A2's
`registerAdapter(adapter)` seam.
