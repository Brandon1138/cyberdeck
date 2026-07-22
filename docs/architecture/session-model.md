# Session model

Cyberdeck is a neutral broker for durable Claude and Codex terminal sessions. It owns provider processes and their pseudo-terminals for the lifetime of the broker; it does not decide what provider, model, or role a user should choose.

## Session, not job

A session is a live provider process, its PTY, metadata, replay buffer, and attachment state. It may receive several prompts over time. Phase 1 does not define a bounded job abstraction, completion contract, queue, retry policy, or reusable workflow.

## Independent dimensions

Each session records independent fields:

- `provider` is the explicitly selected runtime: `claude` or `codex`.
- `model` is an optional provider-native model string. Omitting it leaves selection to the native runtime; Cyberdeck does not rank or route models.
- `role` is an optional opaque, user-defined string. It grants no capabilities and implies no workflow.
- `sandbox` is the requested permission boundary, independent of provider, model, and role.
- execution state describes whether the provider process is active or exited.
- attachment state describes presentation: attached/interactive or detached/headless.

Headless is not a provider category. It is the detached presentation state of the same durable session:

```text
attached/interactive <-> detached/headless
```

Detaching does not stop, suspend, or restart the provider process.

## Controllers and watchers

A session permits one controlling attachment at a time. The controller receives replay plus live output and can send input. Additional read-only watchers may receive replay plus live output without gaining input authority. Closing either client removes only that view. `cyberdeck stop` is the explicit operation that terminates the underlying session.

## Provider and model policy

Every top-level start and every delegation requires an explicit provider. Cyberdeck performs no automatic routing, provider ranking, model selection, or fallback.

Fable has one narrow policy boundary: a top-level Fable start is allowed only as an explicit human action, while delegation of Fable is rejected before a provider process starts. Phase 1 never starts Fable through delegation or automation. Opus has no special broker restriction and is treated like any other ordinary Claude model permitted by the session configuration.

Cyberdeck supplies `DISABLE_UPDATES=1` to every Claude process. It otherwise preserves the native provider's model behavior. In particular, an omitted model is not proof that the native default is non-Fable; the operator must know or explicitly choose the intended provider model.

Phase 1 contains no role catalog, model recommendation, workflow, automatic fallback, semantic memory, worktree orchestration, Cursor adapter, or Antigravity adapter. Those omissions keep the broker neutral and avoid encoding future assignments as current product policy.

## Process ownership and tmux

The broker process owns each provider child process and PTY. The Unix-socket protocol exposes session control, replay, and observation. tmux owns no provider process: the cockpit is only a dashboard pane plus an ordinary shell pane, and any agent pane a user opens is merely a Cyberdeck client attached to the broker.

Consequently, closing a tmux pane or the whole cockpit detaches presentation but leaves the provider running. Stopping the Cyberdeck session terminates the provider even if a tmux view is still open.

## Phase 1 durability boundary

Durability in Phase 1 means a session survives client detach, terminal closure, and tmux-pane closure while the broker stays alive. Session metadata is journaled, and recent terminal output is available from the broker replay buffer.

The broker is still the process owner. If the broker dies or is deliberately shut down, its active PTYs and provider processes end. Phase 1 does not reconstruct a live PTY after broker failure or restart.

## Cockpit presentation

Everything above describes process ownership and remains unchanged. The v1 cockpit adds an
interactive fleet projection plus explicit deletion of terminal thread records. It does not move
provider ownership into tmux.

### Fleet and diagnostics

`cyberdeck dashboard` is the operator-facing fleet. It groups durable sessions by canonical working
directory and shows provider/model identity, user-defined role, lifecycle status, replay-derived
preview, and recency. Enter on an empty composer or Right opens the selected native provider TUI.
For an active thread this attaches directly to the existing broker-owned PTY. For a terminal thread,
the broker first launches the provider's exact conversation-resume command, then attaches to the new
PTY. Claude resumes the UUID Cyberdeck assigned at initial launch; Codex resolves its separately
generated native UUID from local session metadata. Left (or `Ctrl+]`) detaches back to the fleet
without closing the shared broker connection or stopping the provider.

Control attachment is valid only while the provider PTY is active. Provider exit releases the
controller and all watchers, sends an explicit terminal notification to attached clients, and
returns the interactive fleet client to its list. An already-terminal PTY therefore cannot acquire
a controller lease or strand a later open attempt behind `SESSION_ALREADY_CONTROLLED`.

The persistent bottom composer creates a new thread. Its launch context is copied from the selected
row and displayed before submission: provider, explicit model or `native-default`, sandbox, and
working directory. The full task body is forwarded as one initial positional provider argument and
is not added to the durable session record; a normalized 72-character title is retained as the
session `name` for the fleet. This path does not trigger provider selection, model selection,
routing, or fallback inside Cyberdeck.

An empty fleet can be bootstrapped without leaving the view. `/codex task`, `/codex:MODEL task`,
and `/claude:MODEL task` name the provider (and Claude model) explicitly, use the dashboard's visible
current working directory, and fail closed to the read-only sandbox. An unqualified Claude command
is rejected because its local native default is not safe to infer.

`cyberdeck diagnostics` preserves the detailed control-plane panels. It renders sessions and jobs
separately because they are different things:

- A **session** is a live broker-owned PTY that may run indefinitely, so its runtime mode is `interactive`.
- A **job** is bounded work with a terminal outcome, so its runtime mode is `headless`.

`interactive` and `headless` remain runtime/presentation distinctions, never provider categories.
Headless is one-shot per job for every provider: a bounded job is a fresh invocation claiming no
conversation continuity. A detached active session remains the same broker-owned PTY and can be
steered from the fleet. A terminal interactive thread can be reopened only through its explicit
provider-native conversation identity; this never changes provider or chooses a fallback.

### Stop and delete

Stopping and deleting are distinct broker operations. `session.stop` terminates a live provider but
retains the thread record and replay. `session.delete` refuses active or still-stopping providers and
refuses parents whose child thread records still exist. The fleet requires an additional visible
confirmation before it sends `session.delete`; pending confirmation replaces the selected terminal
status with red `press ctrl+x again to delete` text.

### What the cockpit refuses to imply

The fleet and diagnostics derive every field from broker contracts. They never rank providers,
badge quality, mark a default, or suggest a model.

Where a fact is unknown it says so instead of substituting a plausible value:

| Situation | Rendered as | Why not the alternative |
| --- | --- | --- |
| No explicit model | `native-default` | The native default is not knowable from the record, and on Claude it may be Fable. |
| No role | `unassigned` | Role is opaque and grants nothing. |
| Provider reported no tokens | `unknown` | Absence and a genuine zero are different facts. |
| No reconciliation pass yet | `never reconciled` | An empty finding list would read as a clean pass. |
| Broker did not answer a query | `unavailable` | "No jobs" and "the job surface is unavailable" are different facts. |
| Reconciliation findings | operator actions | Reconciliation never deletes, kills, resumes, or retries; it must not appear to have repaired anything. |

Diagnostics states the one-controller/many-watcher invariant but does not display a watcher count,
because the session contract carries none. It does not invent one.

### tmux ownership, restated operationally

tmux owns no provider process. `src/tmux/cockpit.ts` emits no `kill-session`, `kill-pane`,
`kill-server`, `respawn-pane`, or `send-keys` verb; detach uses only `detach-client` and pane
inspection uses only a read-only `list-panes -F` query.

This was verified operationally on 2026-07-21: killing the entire tmux server left the broker healthy
on the same pid with its state intact. Closing a pane is never a way to stop work. `cyberdeck stop
<id>` and the fleet's `Ctrl+X` control go through the broker.
