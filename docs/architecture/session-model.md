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

The original Phase 1 contained no role catalog, model recommendation, workflow, automatic fallback,
or semantic memory. Later orchestration layers preserve the same neutrality: a role remains opaque,
while typed orchestrator bindings and capability grants carry actual authority. Cyberdeck still does
not rank providers, infer models, or route to fallbacks.

## Process ownership and tmux

The broker process owns each provider child process and PTY. The Unix-socket protocol exposes session control, replay, and observation. tmux owns no provider process: the cockpit is only a dashboard pane plus an ordinary shell pane, and any agent pane a user opens is merely a Cyberdeck client attached to the broker.

Consequently, closing a tmux pane or the whole cockpit detaches presentation but leaves the provider running. Stopping the Cyberdeck session terminates the provider even if a tmux view is still open.

## Phase 1 durability boundary

Durability in Phase 1 means a session survives client detach, terminal closure, and tmux-pane closure while the broker stays alive. Session metadata is journaled, and recent terminal output is available from the broker replay buffer.

The broker is still the process owner. If the broker dies or is deliberately shut down, its active
PTYs and provider processes end. The durable session catalog reconstructs conversation records, not
live processes. Unverifiable active ownership becomes `Interrupted`; explicit open resumes the exact
provider-native conversation.

## Durable thread feed

The PTY replay buffer remains bounded presentation state. A separate append-only thread transcript
stores prompts, provider output, orchestrator instructions, and lifecycle events under the local
Cyberdeck state directory. Every event receives a global monotonic cursor. An orchestrator reads
only events after its previous cursor instead of scraping panes or diffing terminal screens.

Ordinary worker result collection does not read this raw feed. Cyberdeck tracks provider terminal
activity in the broker, idles until each requested completion target settles, and returns only a
bounded useful result tail. Batch start and blocking wait keep fan-out to two compact semantic tool
calls. Raw reads are limited to 100 events and the agent-control boundary rejects a cursor older
than that orchestrator's last consumed cursor.

Prompt bodies deliberately do not enter the metadata journal, but they do enter this local
transcript. The transcript file is created with user-only permissions. This privacy boundary is
required for durable summaries after the operator returns.

## Orchestrator and agent authority

An orchestrator binding references a normal broker-owned provider session and separately records its
provider, model, scope, and capability grant. The free-form `role` string grants nothing. The stdio
MCP adapter carries the calling session ID to broker RPC, where scope and capability are checked.

Orchestrator startup is deliberately zero-turn: the provider TUI is opened without a positional user
prompt. Cyberdeck supplies its guidance through the provider's native instruction channel
(`developer_instructions` in Codex configuration or Claude's `--append-system-prompt`) and injects
session-scoped MCP configuration. The session record carries that provider guidance, so a
provider-native resume reconstructs the same guidance and MCP arguments without submitting a turn.

The binding registry is append-only and treats a reset record as a tombstone for the latest binding.
`cyberdeck orchestrator reset` refuses while the bound broker session is active, preventing an
orphaned provider; the operator must stop that exact session first. Once inactive, reset makes the
scope unbound without rewriting history, and an explicit different provider/model writes a clean new
latest binding. Model strings remain opaque and provider-native: no alias translation or fallback is
performed.

Worker steering passes through a durable instruction queue. A human control attachment has absolute
writer priority. If a controller exists, the message remains queued; controller release causes the
broker to retry complete logical messages in FIFO order. No orchestration path emits tmux
`send-keys`.

Workflow messages are passive mailbox entries unless `wake` is explicitly true. Workflow
membership, message IDs, causal hops, maximum messages, maximum wake turns, and cancellation are
persisted and broker-enforced. Cancelling a workflow does not stop its participants.

## Cockpit presentation

Everything above describes process ownership and remains unchanged. The cockpit projects the
interactive Fleet beside a controlling attachment to the selected broker-owned orchestrator. It does
not move provider ownership into tmux.

Cockpit preflight runs `tmux -V` and selects presentation mode before orchestrator ensure/create.
Outside tmux it uses `attach-session`. When `$TMUX` is present, it uses `switch-client` in the
inherited tmux server, never a separate Cyberdeck socket, so Ghostty and other named-server clients do
not attempt a forbidden nested attach. Cockpit session names remain workspace-namespaced.

Presentation and orchestrator creation form a transaction across the CLI boundary. A pane or final
attach/switch failure removes only a cockpit session created by that invocation. A pre-existing
cockpit, the user's `main` session, and the server are preserved. The broker reports whether
orchestrator ensure created or reused the session; presentation failure stops only a newly created
orchestrator, which also ends its provider-owned MCP child, while a reused orchestrator remains
active. Cleanup errors are secondary context on the original presentation failure.

### Fleet and diagnostics

`cyberdeck dashboard` is the operator-facing fleet. It groups durable sessions by canonical working
directory and shows friendly model/effort identity, attention status, normalized assistant preview,
and meaningful recency. Enter on an empty composer or Right opens the selected native provider TUI.
For an active thread this attaches directly to the existing broker-owned PTY. For a terminal thread,
the broker first launches the provider's exact conversation-resume command, then attaches to the new
PTY. Claude resumes the UUID Cyberdeck assigned at initial launch; Codex resolves its separately
generated native UUID from local session metadata. Left (or `Ctrl+]`) detaches back to the fleet
without closing the shared broker connection or stopping the provider.

Control attachment is valid only while the provider PTY is active. Provider exit releases the
controller and all watchers, sends an explicit terminal notification to attached clients, and
returns the interactive fleet client to its list. An already-terminal PTY therefore cannot acquire
a controller lease or strand a later open attempt behind `SESSION_ALREADY_CONTROLLED`.

The persistent bottom composer creates a new thread. `/model` opens one flat explicit model list,
then the provider-supported effort list. The final choice applies immediately, persists per project,
and remains visible with sandbox and working directory. The full task body is forwarded as one initial positional provider argument and
is not added to the durable session record; a normalized 72-character title is retained as the
session `name` for the fleet. This path does not trigger provider selection, model selection,
routing, or fallback inside Cyberdeck.

An empty Fleet can be bootstrapped without leaving the view: choose `/model`, choose effort, then
enter the task. Provider follows the explicit model catalog entry; no provider command syntax,
implicit default, ranking, or fallback participates.

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
confirmation before it sends `session.delete`; pending confirmation says exactly
`Delete thread? press ctrl+x again` in red.

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

tmux owns no provider process. `src/tmux/cockpit.ts` emits no `kill-pane`, `kill-server`,
`respawn-pane`, or `send-keys` verb. Its only `kill-session` path is rollback of the exact
workspace-namespaced cockpit created by the current failed invocation. Detach uses only
`detach-client`, and pane inspection uses only a read-only `list-panes -F` query.

This was verified operationally on 2026-07-21: killing the entire tmux server left the broker healthy
on the same pid with its state intact. Closing a pane is never a way to stop work. `cyberdeck stop
<id>` and the fleet's `Ctrl+X` control go through the broker.
