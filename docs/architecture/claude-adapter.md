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
claude --session-id <uuid> --name <name> --permission-mode <plan|manual|auto> [--model <explicit>] \
       --settings <per-session transcript-hook settings>
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

The table is the unchanged default. Interactive semantic worker starts may explicitly request the
provider-neutral `approvalMode: "auto"`, which maps to Claude's documented `auto` permission mode
for Opus and the other explicitly selected Claude models. `bypassPermissions` and `dontAsk` are
never emitted.

## Which file the conversation is in (MIK-46)

`--session-id` is Cyberdeck's own session id, so before anything moves, the transcript is
`~/.claude/projects/<cwd-slug>/<session-id>.jsonl` and needs no signal at all. `/clear` breaks that:
Claude starts a new native conversation under a new id and writes subsequent turns to a new file,
while the Cyberdeck session record, the PTY and the actor binding all stay alive. Nothing fails —
capture simply stops.

**The identity signal is Claude's own SessionStart hook.** Every Claude session is launched with
`--settings <per-session file>` installing one hook on `startup|resume|clear|compact`:

```
<node> <cyberdeck cli> transcript rebind --actor-session <cyberdeck session id> --state-directory <dir>
```

Claude passes `session_id`, `transcript_path` and `cwd` on the hook's stdin; the Cyberdeck session id
comes from the command line, fixed at launch and unreachable from inside the conversation. That
split is the whole point: **the payload says which file, the argv says which worker.** Several
workers can share one worktree and each writes its own binding, so neither can be mistaken for the
other. `--settings` *adds* a settings source, so the operator's own hooks still run.

The binding is one small JSON file per session under
`<state>/threads/claude-conversations/<session-id>.json`, written by the short-lived hook process and
read by `ThreadTranscriptStore`. It is on disk before anything in Cyberdeck has to be listening, so a
broker that is down, restarting or resuming loses nothing and needs no replay.

### Failure behaviour: closed, and never silent

`ThreadTranscriptStore` reports a per-session `claudeTranscriptStatus`, and a fallback turn recorded
while it is not `bound` carries the same value in its `data`. Silence is therefore distinguishable
from health, which is what the original bug was not.

| Status | Cause | Behaviour |
| --- | --- | --- |
| `bound` | A transcript is being read for this session. | Native turns and previews. |
| `cleared-unbound` | The bound file ends in a `/clear` frame and no binding names its successor. | No native read. Turns fall back to terminal replay, labelled. |
| `foreign-cwd` | A binding names a different working directory than the session's. | No native read. |
| `attribution-conflict` | Another session claims the file this one resolved to — through its own durable binding, or by already being read from it here. | No native read for *any* claimant, whichever read first. |

`/clear` is also detected **in-band**, independent of the hook: Claude writes the command as the last
user frame of the file it abandons, so the file states its own death and the store reads it on the
pass it already makes. That detector is what makes a missing hook fail closed instead of pinning the
transcript to a file that will never grow again. A frame is only that marker when its whole content
opens with `<command-name>/clear</command-name>` and it carries no `toolUseResult` — a session that
greps its own transcripts quotes the same literal in a tool result.

There is deliberately **no cwd-only and no newest-file** search for a successor. Workers share
worktrees, and one worker's conversation recorded as another's is worse than no capture: an
unresolved candidate stays unresolved.

The conflict check reads the **durable bindings**, not the broker's in-memory claims. Two bindings
naming one file — a restarted broker that has read neither yet — would otherwise let whichever
session was polled first capture the shared transcript and refuse only the other, making attribution
a function of read order. Every claimant is refused instead, including a session whose
launch-derived `<session-id>.jsonl` some other session's binding has named. A binding is therefore
also a claim that outlives its own thread, which is why deletion drops it: `session.delete` and
`sweepRetention` both retire the binding through `ThreadTranscriptStore.dropClaudeBinding`, the same
drop the startup retention pass makes, so no deleted thread leaves a file behind to refuse a live
session later.

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
