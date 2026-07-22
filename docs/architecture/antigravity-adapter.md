# Antigravity (`agy`) adapter

B4 adds an ownership-isolated Antigravity command builder and bounded `JobDispatchAdapter` through
the canonical provider id `antigravity` and evidence-backed executable `agy`. It exports
`ANTIGRAVITY_PROVIDER_DESCRIPTOR` for A1's neutral registry seam and never self-registers.

The current installed `agy` 1.1.5 help and model catalog were inspected without submitting a model
turn. A promptless TUI launch in an already trusted workspace confirmed the exact
`gemini-3.6-flash-low` identity and idle footer; it was exited without a prompt. Actual prompt
delivery, output, exit semantics, and model behavior remain live-unverified.

## Exact commands and process ownership

Interactive command construction, suitable for a broker-owned PTY, with an optional initial prompt:

```text
agy [--prompt-interactive <instruction>] --mode plan --sandbox [--model <explicit>] [--effort low|medium|high]
```

Bounded/headless command construction:

```text
agy --print <instruction> --mode plan --sandbox [--model <explicit>]
```

For both forms, process `cwd` is the explicit request `cwd` and environment is inherited unchanged
unless a test injects a controlled environment. The interactive initial prompt uses the documented
`--prompt-interactive` flag. The headless instruction is the value of `--print`; stdin is empty and closed immediately because
`agy` documents no stdin prompt format. The headless process owns piped stdout/stderr. An
interactive provider process would remain broker-PTY-owned; tmux must never own it.

The interactive session contract now consumes the open provider identity and registers
`AntigravityProviderAdapter` in the broker. `session.start`, Fleet slash launches, and orchestrator
`worker_start` accept the explicit `antigravity` provider. Provider-native resume remains unverified
and fails with `SESSION_RESUME_UNAVAILABLE` rather than creating a different conversation.

## Sandbox, model, and agent mapping

| Cyberdeck request | Mapping | Status |
| --- | --- | --- |
| `read-only` | `--mode plan --sandbox` | Help-advertised, fixture-proven, live-unverified |
| `workspace-write` | rejected with `ANTIGRAVITY_WORKSPACE_WRITE_UNSUPPORTED` | `accept-edits` exists, but evidence does not prove it is workspace-write without automatic approval |
| explicit `model` | `--model <value>` | Forwarded exactly once |
| omitted `model` | no model flag | No default or automatic selection |
| explicit interactive `effort` | `--effort low\|medium\|high` | Forwarded exactly once; other values rejected |
| `role` | not forwarded | Opaque control-plane label |
| agent | not forwarded | The shared request has no explicit agent field |

An explicitly named Fable model and an option-shaped model value are rejected before process
construction. The adapter never emits `--agent`, `--dangerously-skip-permissions`, `--force`,
`--yolo`, continuation/conversation, resume, output-format, fallback, retry, routing, or automatic
selection flags.

Autonomous workers are limited to the installed effort-suffixed IDs
`gemini-3.6-flash-low`, `gemini-3.6-flash-medium`, and `gemini-3.6-flash-high`; the
separate effort field must match the suffix. The incomplete `gemini-3.6-flash` string is rejected
instead of allowing Antigravity to resolve a different default.

Before an otherwise valid interactive launch, Cyberdeck atomically adds only the canonical request
`cwd` to Antigravity's existing `trustedWorkspaces` setting. Parallel starts are serialized and
existing settings are preserved. This preflight does not emit `--dangerously-skip-permissions`,
approve later tool actions, trust a parent directory, or weaken the requested read-only sandbox.

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
- Metadata/promptless live evidence: installed 1.1.5 effort flag, effort-suffixed model IDs, exact
  low model identity, authenticated promptless startup, and idle footer. No model prompt was sent.
- Live-unverified: interactive/headless prompt execution, output and exit semantics, model behavior,
  resume, and continuation.

Automated tests inject the existing recording fixture through an explicit Node executable with an
empty `PATH`; they cannot resolve or spawn installed `agy` and make no provider, model, network,
auth, or Fable call. Workspace-trust tests use isolated temporary settings files.
