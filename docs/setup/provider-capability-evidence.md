# Provider capability evidence

Captured on 2026-07-21 in Europe/Bucharest on darwin 27.0.0 arm64.

**No provider or model session was started.** No prompt was sent, no `--print`
or `--prompt` mode was used, no model was selected, no authentication was
changed, and no install or update command was issued. Every command below is
metadata only: it prints a version, prints help, reports authentication status,
or prints a listing the installed CLI documents.

Fable was not started, called, listed as a target, or used as a fallback. It
appears below only as a string inside `agent models` output, which is a listing
the CLI printed on its own.

## Three kinds of evidence

This document keeps them separate and never promotes one into another.

| Kind | Meaning |
| --- | --- |
| Observed now | What a read-only command actually printed on this machine on this date. |
| Help-advertised | A flag or mode the CLI's own help text mentions. Not proof it works. |
| Unverified runtime | Behaviour that would require starting a session or making a model call. Not established. |

## Exact commands run

```bash
claude --version
claude --help
claude auth --help
claude auth status
agent --version
agent --help
agent status
agent models
agy --version
agy --help
agy models
agy agents
```

These are also the eleven entries in `PROVIDER_PROBES` in
[scripts/probe-provider-capabilities.ts](../../scripts/probe-provider-capabilities.ts)
(`claude auth --help` was an inspection step, not a probe entry).

## Observed now

| Provider | Executable | Version | Auth status |
| --- | --- | --- | --- |
| Claude Code | `/opt/homebrew/bin/claude` | `2.1.215 (Claude Code)` | `loggedIn: true`, `authMethod: claude.ai`, `subscriptionType: pro` |
| Cursor Agent | `/Users/brandon/.local/bin/agent` | `2026.07.17-3e2a980` | `✓ Logged in` |
| Antigravity | `/Users/brandon/.local/bin/agy` | `1.1.4`, then `1.1.5` (see side effects) | no auth-status command documented |

Drift from [runtime-baseline.md](runtime-baseline.md), which recorded
2026-07-20: `claude` 2.1.214 → 2.1.215, `agent` 2026.07.16-899851b →
2026.07.17-3e2a980, `agy` 1.1.4 → 1.1.5. Cyberdeck issued no update command;
these runtimes update themselves.

### Listings printed by the CLIs

`agent models` printed model ids including `composer-2.5` (marked `(current)`),
`auto`, several `gpt-5.x` and `claude-opus-4-*` ids, and two `claude-fable-5-*`
ids. Printing that list is not selecting or calling any of them.

`agy models` printed Gemini, Claude, and GPT-OSS ids. Between the two runs its
output changed from display names such as `Gemini 3.5 Flash (Medium)` to ids
such as `gemini-3.5-flash-medium`, because the binary changed underneath.

`agy agents` printed `Available agents:` with an empty list.

## Observed side effect: antigravity updates itself

The `agy` binary replaced itself on disk during this capture while only
metadata commands were run.

- `agy --version` reported `1.1.4` at 07:45 and `1.1.5` at 07:53.
- `/Users/brandon/.local/bin/agy` mtime moved to `2026-07-21 07:47:34`.
- `agy models` output format changed between the two runs.

No update command was issued. Causation is not proven — this may be a scheduled
self-update rather than one triggered by the metadata calls — but the
correlation is recorded so that no one later claims an `agy` probe leaves the
installation untouched. `claude` (mtime 2026-07-20 16:45:30) and `agent`
(mtime 2026-07-21 07:26:18, before the first command here) did not change during
the capture.

This is tracked in code as `OBSERVED_PROBE_SIDE_EFFECTS`.

## Help-advertised only

Advertised by help text, **not** verified live by anything here.

| Provider | Advertised | Note |
| --- | --- | --- |
| Claude | `-p/--print`, `--output-format text\|json\|stream-json`, `--input-format`, `--include-partial-messages`, `--session-id <uuid>`, `--permission-mode`, `--model`, `-n/--name` | `--model` help names `fable` as an alias, so an omitted model is not safe by default |
| Cursor | `-p/--print`, `--output-format text\|json\|stream-json`, `--stream-partial-output`, `--mode plan\|ask`, `--resume [chatId]`, `--model`, `--sandbox enabled\|disabled` | `--print` help states it "has access to all tools, including write and shell" |
| Antigravity | `--print`/`--prompt`, `-i/--prompt-interactive`, `--mode accept-edits\|plan`, `--model`, `--conversation`, `--sandbox` | help documents no output-format flag |

## Unverified runtime behaviour

Tracked in code as `UNVERIFIED_RUNTIME_CAPABILITIES`.

- Claude `stream-json` frame **schema** — the format is named in help, but its
  fields are undocumented there and would need a live `--print` run to observe.
- Claude model listing — no read-only model-list command is documented.
- Claude native default model — the recorded baseline observed the native
  default displaying Fable. Adapters must therefore always pass an explicit
  ordinary non-Fable model. Broker policy does **not** prevent this: it can
  reject only an explicitly supplied model string, so an omitted model still
  passes.
- Cursor headless `stream-json` frame schema — emitting a frame requires a model
  call.
- Cursor `--mode plan|ask` runtime behaviour — advertised as read-only, but
  confirming it starts a session.
- Antigravity authentication status — no command documented.
- Antigravity print-mode output shape — undocumented and requires a model call.

## Fixture contract

Fixtures under `tests/fixtures/` prove Cyberdeck mechanics only. They are
synthetic and are **not** provider-shaped evidence.

- `tests/fixtures/recording-agent.mjs` — records argv, cwd, allowlisted env
  vars, and stdin; replays canned stdout/stderr and an exit code; supports
  `interactive` and `headless` modes. Configured entirely by environment so argv
  stays exactly what the adapter under test produced.
- `tests/fixtures/stream-frames/*.jsonl` — newline-delimited JSON framing cases
  (well-formed, malformed, truncated). Newline-delimited framing is what the
  CLIs document; the **field names are invented for these fixtures**
  (`kind: "fixture-frame"`), precisely so they cannot be mistaken for a real
  provider frame schema.

No fixture makes a network call, and none requires provider authentication.

## Reproducing

```bash
mise exec -- pnpm exec tsx scripts/probe-provider-capabilities.ts --read-only
```

The script refuses to run without `--read-only`. `assertReadOnlyProbe` rejects
any argv token that is not on a small read-only allowlist — including bare
prompt operands, `--model`, print/prompt modes, session continuation,
`login`/`logout`, and `install`/`update` — before anything is spawned.
