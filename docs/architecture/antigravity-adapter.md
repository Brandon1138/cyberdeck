# Antigravity (`agy`) adapter

B4 adds an ownership-isolated Antigravity command builder and bounded `JobDispatchAdapter` through
the canonical provider id `antigravity` and evidence-backed executable `agy`. It exports
`ANTIGRAVITY_PROVIDER_DESCRIPTOR` for A1's neutral registry seam and never self-registers.

No installed `agy` executable was resolved or spawned while implementing or testing this adapter.
The command surface below comes from committed B1 evidence and the historical read-only help
record. Actual prompt delivery, output, exit semantics, authentication, and model behavior remain
live-unverified because proving them would require a provider/model call.

## Exact commands and process ownership

Interactive command construction, suitable for a broker-owned PTY:

```text
agy --mode plan --sandbox [--model <explicit>]
```

Bounded/headless command construction:

```text
agy --print <instruction> --mode plan --sandbox [--model <explicit>]
```

For both forms, process `cwd` is the explicit request `cwd` and environment is inherited unchanged
unless a test injects a controlled environment. The interactive builder adds no prompt. The
headless instruction is the value of `--print`; stdin is empty and closed immediately because
`agy` documents no stdin prompt format. The headless process owns piped stdout/stderr. An
interactive provider process would remain broker-PTY-owned; tmux must never own it.

The old Phase 1 interactive session union remains closed to `codex | claude`. B4 therefore exports
the PTY-ready builder but does not widen A-owned contracts or claim interactive broker registration.

## Sandbox, model, and agent mapping

| Cyberdeck request | Mapping | Status |
| --- | --- | --- |
| `read-only` | `--mode plan --sandbox` | Help-advertised, fixture-proven, live-unverified |
| `workspace-write` | rejected with `ANTIGRAVITY_WORKSPACE_WRITE_UNSUPPORTED` | `accept-edits` exists, but evidence does not prove it is workspace-write without automatic approval |
| explicit `model` | `--model <value>` | Forwarded exactly once |
| omitted `model` | no model flag | No default or automatic selection |
| `role` | not forwarded | Opaque control-plane label |
| agent | not forwarded | The shared request has no explicit agent field |

An explicitly named Fable model and an option-shaped model value are rejected before process
construction. The adapter never emits `--agent`, `--dangerously-skip-permissions`, `--force`,
`--yolo`, continuation/conversation, resume, output-format, fallback, retry, routing, or automatic
selection flags.

## Plain-text and terminal behavior

`agy` documents no structured output format. Stdout and stderr are retained as bounded UTF-8 text;
partial byte chunks are joined before decoding, JSON-looking text remains untrusted text, and
malformed UTF-8 or overflow fails the job. The default bound is 1 MiB independently for stdout and
stderr.

A clean zero exit is not structured proof of successful completion. The default interpreter fails
closed with `DISPATCH_REJECTED`. Only an explicitly injected, validated result interpreter can map
a clean zero exit plus plain stdout/stderr to a neutral result. Non-zero exit, signal, process
error, malformed output, and overflow fail before interpretation. Missing usage remains absent and
is never fabricated as zero.

Cancellation and timeout send `SIGTERM`, wait for the injected process terminal event, bypass the
provider interpreter, and settle as `cancelled` or `timedOut`. Process error and output overflow
also terminate and clean ownership. Duplicate dispatch is rejected before a second process is
constructed, and the settled guard suppresses duplicate terminal events. EOF/close with no
validated interpreter fails closed. Resume, continuation, durable conversation, structured
streaming, routing, fallback, retry, model pools, and automatic model/agent choice are unsupported
or live-unverified rather than emulated.

## Evidence boundary

- Committed B1 evidence: provider id/executable, advertised prompt/mode/model/conversation/sandbox
  surface, lack of an output-format flag, and the observed possibility of `agy` self-update during
  metadata inspection.
- Deterministic B4 fixtures: exact argv/cwd/env/stdin construction, plain-text collection, bounds,
  cancellation, timeout, process errors, cleanup, and duplicate protection.
- Live-unverified: real interactive/headless execution, prompt arity in the current installed
  version, output and exit semantics, authentication, model behavior, resume, and continuation.

Tests inject the existing recording fixture through an explicit Node executable with an empty
`PATH`; they cannot resolve or spawn installed `agy` and make no provider, model, network, auth, or
Fable call.
