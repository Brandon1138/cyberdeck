# Strigoi and broker rollout dossier — 2026-11-15

This is a prepared procedure, not activation authorization. The Desktop handoff reserves merge, shared broker restart, legacy reconciliation and replacement-resident activation for separate approval. It also requires approval before unapproved real-provider inference or process termination. No such action was taken here; the specifically authorized old implementation peer retirement is recorded separately.

## Reverified state

- PR167 is merged at `35c5241a7fae7c749f9b8be50716523c34fd8d4c`.
- PR168 remains open/draft/mergeable at `ad12b26125d202ca494c1f55e4778d3a564e41bb`; all nine current CI checks succeeded. Its existing worktree is clean. Its patch applies cleanly on the broker repair candidate, and its changed source paths do not overlap the repair. This establishes patch compatibility, not combined runtime acceptance.
- Live Strigoi inspection still reports revision 15, desired enabled, incarnation 2, readiness held, adoption pending, phase adopting/deferred, hold `successor-unavailable`.
- Successor `0090d5c2-bcb8-4bdc-a8f1-61c8adfd73c4`, generation 1; predecessor `e50aa5ab-c3a3-4f29-8cf0-cd2519c84abf`; transition `d5448188-257b-49f2-a4e7-2d4c57b33ace`; packet SHA256 `c8de789bc3dea033f1dcabb81c9c71109a32b6e33cc2d1ef7d25d27299c4e113` remain unchanged.
- The legacy generation predates process-group identity markers. New absence probes do not retrospectively prove it retired. A merge must leave the hold intact.

## First approval: isolated native dispatch acceptance

Approve one new read-only Codex worker, model Sol/medium where supported, in a temporary fixture directory, with a private broker socket/state directory built from the exact reviewed broker revision. No new peer orchestrator is needed: a test controller uses the real broker's existing binding/control interfaces. Do not route this through the app-server job gate alone: that script does not establish the terminal worker follow-up path at issue here.

1. Record candidate SHA, Node/provider versions, private paths and generated session/message IDs before dispatch. No shared tmux/Fleet/nvim instance is started; nvim's checkout coupling and shared socket namespace remain out of scope.
2. Submit exactly one initial instruction through Cyberdeck-native worker dispatch: `Reply exactly CYBERDECK_NATIVE_ONE. Do not use tools.` Collect the canonical reply within a 120-second provider budget, using bounded wait segments. Record admission, enqueue, delivery attempt, submission, canonical result and RPC durations separately.
3. After canonical idle is observed, enqueue one new message with a fresh recorded messageId: `Reply exactly CYBERDECK_NATIVE_TWO. Do not use tools.` Collect a second distinct canonical reply under the same budget. Require exact attribution, no duplicate provider submission and bounded collection.
4. On transient read/busy, retain the same logical identity and inspect durable outcomes. On uncertain delivery, stop sending; do not create a replacement or replay the text. On a modal, report it. Answer only already-permitted modal choices; do not trust new hooks or widen permissions.
5. With approval covering cleanup of this one fixture worker, stop only its exact broker-owned generation through the supported lifecycle, then close the private broker. Preserve evidence on failure. Stop once after success; no automatic launch retry.

This requested gate is bounded to two useful provider turns plus private-fixture startup/cleanup. It does not authorize shared restart, legacy termination or Strigoi replacement. It is NOT RUN.

## Later isolated Strigoi gate

After native dispatch passes, build a combined candidate containing the approved broker repair and PR168 without modifying the dirty primary checkout. Request approval for the exact fixture broker/provider process identities and inference budget before running cold start, meaningful-input adoption, graceful controller restart, repeated pre-adoption restart and provider-loss recovery. Verify one authorized runtime, retained obligations, backoff/caps, no ordinary input retyping, durable canonical answers and distinct adoption acknowledgment. Existing real-process PR168 fixtures prove process/hold mechanisms, not live Codex convergence. This gate is NOT RUN.

## Legacy reconciliation before shared rollout

1. Capture the current immutable candidate revisions and read-only live Strigoi/session/launch records. Preserve state/journals and packet evidence; obtain a consistent backup under an approved lifecycle pause before any shared mutation. Do not infer process identity from PID alone.
2. Compare any surviving runtime's provider conversation, launch executable, start time, session/generation marker and process-group membership using supported inspection. Check remote app-server work separately. A reused PID, missing marker, inaccessible process or incomplete ancestry leaves ownership unknown.
3. If exact ownership cannot be established, keep the hold and stop this rollout. Do not synthesize a marker, edit receipts, clear state or signal guessed PIDs. Present the exact remaining identity evidence and supported reconciliation action for separate approval; the current evidence cannot yet justify a legacy retirement command.
4. Once reconciliation is proven and approved, specify the combined build revision, previous binary rollback path, affected session inventory and lifecycle commands. Only then request approval to merge/restart/activate. Preserve the primary checkout's dirty changes and the nvim config/version coupling; no blind pull/build there.

## Rollback

On duplicate ownership, lost obligations, ambiguous delivery, nonconvergence or new control-plane stalls, stop input and preserve all journals. Use supported Strigoi suspension only under the rollout approval, then return to the recorded previous binary through the approved broker lifecycle. Never restore an older state snapshot over new receipts. Older binaries may conservatively hold identities they cannot verify. Recheck every affected session and canonical receipt after rollback; a healthy broker PID is not acceptance.
