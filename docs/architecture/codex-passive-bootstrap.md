# Passive Codex startup with existing history

A passive remote Codex actor does not necessarily materialize a rollout before its first
prompt. Unattributed historical rollouts must remain unbound; they cannot establish that
actor's identity, idle boundary, or completion.

The actor's private remote bridge correlates its marker-injected `thread/start` with the
native reply. It publishes a private first-input receipt containing the exact actor, native
thread, and cwd. It monotonically revokes that receipt before forwarding input or lifecycle
mutations, on native work notifications (including another client's activity), and when
either transport closes. Publication and deletion are serialized across both directions.

For a generation-one passive launch with no previous input or completion, the turn engine
can request a separate bootstrap observation. This requires that receipt, no existing
transcript binding, and a successful exact-thread metadata read reporting idle and direct
input capability, empty preview, no fork, and unchanged creation/update timestamps. The
receipt must still match after the read. Metadata alone is insufficient: its empty `turns`
array does not represent history. Codex daemon 0.169 rejects `includeTurns:true` with
`list_turns is not supported yet`, so bootstrap uses the correlated fresh start and
continuous bridge subscription rather than an unsupported history read.

The current screen, empty composer, generation, and revision gates still apply. Startup
Working titles do not permanently invalidate fresh native proof. A single operator Escape
at a recognized pristine hook-review prompt advances the revision without counting as a
model prompt; other keys retain ordinary input fencing. This never trusts hooks.

Succession refreshes that same input-admission gate before creating a bounded recovery
attempt. Fleet's readable idle projection alone cannot spend a checkpoint or adoption retry.

Before writing actual prompt bytes, the engine invalidates bootstrap admission synchronously.
Bootstrap does not create a transcript binding, native completion, or fallback receipt.
All subsequent inputs require normal native attribution. Conflicting, corrupt, or missing
existing bindings remain holds.

Fleet preference replay separately recognizes historical preview-only `attention`, `runtime`,
and `projects` view values. It retains the last supported view and all reply/lifecycle
watermarks without rewriting the journal or accepting those values through the write API.
