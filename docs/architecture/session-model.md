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
