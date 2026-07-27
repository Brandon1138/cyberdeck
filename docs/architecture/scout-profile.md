# Tier 1 Scout worker profile

Scout is a profile on Cyberdeck's existing interactive worker lifecycle. It is neither a new
session kind nor a daemon. `cyberdeck_worker_start` and `cyberdeck_workers_start` accept
`profile: "scout"` with a structured brief:

- one `objective`;
- relative path/glob `scope` entries that cannot escape the worker cwd;
- lookup-shaped `questions`;
- a `stopCondition`;
- `budget.maxWallClockMs` and `budget.maxTokens`.

Profile resolution is fixed and observable in the durable session record:

```text
lifecycle worker
profile scout
tier 1
provider cursor
model composer
permissions read-only
approvalMode auto
leasePolicy expire-and-discard
```

`leasePolicy` is the plain `expire-and-discard | orphan-for-adoption` enum. This slice records it
only; no lease expiry, adoption, or heartbeat behavior is implemented.

## Launch boundary

The Scout cwd must be a Git working tree because the denied-write canary compares exact
`git status --porcelain` state before and after the provider turn.

Cursor still launches with `--workspace <cwd> --sandbox enabled --mode plan --model composer`.
Cyberdeck then performs three broker/provider controls before dispatching the brief:

1. Cursor config, data, compile-cache, and temp writes are redirected under one private
   session drop-box root outside the worktree.
2. User and project MCP identifiers are read, then disabled in that isolated Cursor data directory.
   Global/project configuration files are never edited, and `--approve-mcps` is never emitted.
3. `/run-everything` is committed and read back as enabled. Composer then receives a canary turn
   that attempts one built-in repository-file creation. Launch fails unless the tool refusal is
   visible, the exact canary path remains absent, and
   `git --no-optional-locks status --porcelain=v1 --untracked-files=all` is unchanged.

This canary is deliberately behavioral. Launch flags or Composer's own mode label are not accepted
as sufficient evidence.

## Canonical drop-box report

Composer emits one report between Cyberdeck framing markers. Broker captures marker content to:

```text
<Cyberdeck state>/scouts/<session-id>/report.json
```

The provider never receives a repository-write exception. Cyberdeck owns the only report write, so
plan mode remains intact. A complete report must validate as:

- one or more findings, each with evidence references containing a path and a symbol or line range;
- coverage listing what was searched and which methods were used;
- uncertainties/areas not inspected;
- suggested follow-up probes.

The file is canonical. A valid framed report completes target 1 even when terminal idle/completion
detection stalls. Terminal completion remains corroboration only. Recovery re-reads the file so a
completed result remains collectable after broker restart. Reports are capped at 96 KiB and Scout
PTY replay is raised to at least 256 KiB, preventing a valid report frame from aging out before its
closing marker arrives.

## Budgets and parallelism

Wall-clock timer starts when validated brief is submitted, after launch verification. Rendered
Composer token usage is baselined at that boundary, then checked against brief token cap on every
PTY update. Crossing either cap sends `SIGTERM` immediately, records terminal state
`budget_exhausted`, and lets any already-queued partial report write finish before result collection
settles.

Batch dispatch uses concurrent independent starts while registry reserves capacity during provider
preflight, retaining existing 64-worker fleet limit without oversubscription. Every Scout has
isolated state and drop-box paths; no shared pane, manual approval, provider arbitration, escalation,
synthesis, or lease mechanics are added.
