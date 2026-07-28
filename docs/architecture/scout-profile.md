# Tier 1 Scout worker profile

Scout is a fixed profile on Cyberdeck's existing durable Worker/session lifecycle. It is not a
daemon, secondary orchestrator, or separate job plane. Its purpose is to let a costly Orc fan out
cheap Cursor Composer investigations without admitting raw exploratory streams into the Orc's
context.

`cyberdeck_worker_start` and `cyberdeck_workers_start` accept `profile: "scout"` with:

- one `objective`;
- an optional `hypothesisId` used to group a wave;
- relative path/glob `scope` entries that cannot escape the worker cwd;
- lookup-shaped `questions`;
- a `stopCondition`;
- an optional `budget` (15-minute wall-clock default; `maxTokens` is optional).

Profile resolution is fixed and durable:

```text
lifecycle worker
profile scout
tier 1
provider cursor
model composer
permissions read-only
approvalMode auto
transport headless-stream-json
leasePolicy expire-and-discard
```

`leasePolicy` remains the plain `expire-and-discard | orphan-for-adoption` record. This slice does
not add expiry, adoption, or heartbeat behavior.

## Durable operator grant

Cursor source egress fails closed until the operator grants one exact canonical Git repository
root:

```sh
cyberdeck scout-egress status --root /absolute/repository
cyberdeck scout-egress on --root /absolute/repository
cyberdeck scout-egress off --root /absolute/repository
```

The append-only grant ledger is box state, not an Orc-binding capability. It therefore survives
broker restarts and replacement of Sol/Fable, while revocation blocks future Scouts. It is fixed to
Cursor, the Scout profile, and read-only access. No MCP tool can mutate it, and a grant for a root
does not cover a subdirectory, parent, sibling repository, or other worktree. Paths are resolved
through `realpath`, so aliases of the same canonical root have one grant identity.

## Provider-native noninteractive transport

After the grant check, Cyberdeck invokes Cursor's documented one-shot transport:

```text
agent --print --output-format stream-json
      --workspace <root> --sandbox enabled --mode plan --trust
      --model composer <prompt>
```

The prompt is redacted from durable launch metadata. No prompt paste, readiness glyph, slash menu,
synthetic keypress, `/run-everything`, PTY completion scrape, `--force`, or `--yolo` participates.
The process has no writable stdin and closes after one result.

Before spawn, Cyberdeck:

1. redirects Cursor config, data, compile cache, and temp writes into the Scout's private state
   directory outside the repository;
2. disables configured MCP servers in that isolated Cursor state without editing user/project
   configuration;
3. records a SHA-256 fingerprint of HEAD, porcelain status, the binary tracked-file diff, and
   nonignored untracked file contents.

Plan mode plus Cursor sandboxing is the provider enforcement boundary. After process exit,
Cyberdeck recomputes the repository-state hash. Any observable mutation, missing baseline, or
verification error makes the Scout failed even if Composer emitted a plausible card.

Launch, initialization, execution, and verification failures remain durable Fleet records with a
session ID, phase, message, sanitized launch record when available, and private artifacts. Failed
launches are not erased and can be inspected or explicitly deleted later.

## Output designed for an Orc

Cursor's stream JSON is transport telemetry, not a model-authored result schema. Cyberdeck keeps
three private artifacts:

```text
<Cyberdeck state>/scouts/<session-id>/card.md
<Cyberdeck state>/scouts/<session-id>/evidence.md
<Cyberdeck state>/scouts/<session-id>/trace.jsonl
```

`trace.jsonl` is the bounded full provider stream (8 MiB). `evidence.md` is deeper support (512
KiB). Neither enters normal wait results. The compact `card.md` (96 KiB maximum) uses stable prose
headings:

```text
QUESTION
...
VERDICT
SUPPORTED | REFUTED | MIXED | INCONCLUSIVE | BLOCKED | NEW_FINDING
BASIS
direct-test | direct-source | history | corroborated | inference | speculation | none
FINDING
...
EVIDENCE
- ...
COVERAGE
...
CAVEAT
...
NEXT PROBE
...
```

A card frame alone does not complete a Scout. Target 1 completes only after exit code zero, durable
card capture, and unchanged repository state. Nonzero exit, a missing/invalid card, trace failure,
or mutation is `failed`; a budget kill remains `budget_exhausted`. Restart recovery promotes only
results already verified complete, while still reading legacy `report.json` results created by the
older interactive profile.

For a multi-Scout wait, Cyberdeck deterministically groups cards by `hypothesisId` (or normalized
question), promotes supported/refuted disagreement as `CONFLICT`, calls out `NEW_FINDING`, and
returns compact per-Scout belief updates. Drill-down handles have the form:

```text
scout://<session-id>/card
scout://<session-id>/evidence
scout://<session-id>/trace
```

An Orc resolves one with `cyberdeck_scout_read`, continuing from the returned byte cursor. This is
an explicit attention decision; ordinary collection never injects raw exploratory branches.

## Budgets and parallelism

The wall-clock guard begins after the one-shot process is adopted. If `maxTokens` is supplied,
Cyberdeck reads cumulative token usage fields from stream JSON rather than terminal decoration.
Crossing either ceiling sends `SIGTERM`, records `budget_exhausted`, and lets queued trace/card
writes settle.

Batch dispatch retains the existing 64-worker admission ceiling and reserves capacity during
preflight. Every Scout has isolated Cursor state and artifacts. No pane interaction, manual provider
approval, provider arbitration, or synthesis model is added.
