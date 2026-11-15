# Strigoi restart reliability

The invariant is one authorized, verified usable resident runtime when dependencies are healthy. A launch is not adoption. Unknown ownership blocks another launch; suspended and disabled residents stay suspended or disabled across restart. All ordinary instruction receipts and worker ownership still come from their existing journals.

## Incident and cause

Read-only `cyberdeck strigoi status` on 2026-11-15 reconfirmed revision 15, desired enabled, incarnation 2, generation 1, transition `d5448188-257b-49f2-a4e7-2d4c57b33ace` adopting/deferred, successor `0090d5c2-bcb8-4bdc-a8f1-61c8adfd73c4`, ownership unknown, exit code -1, pending adoption. Packet hash was `c8de789bc3dea033f1dcabb81c9c71109a32b6e33cc2d1ef7d25d27299c4e113`. This verifies lost ownership, not how the provider died or whether an orphan exists. General activity coverage was reported degraded in the incident; missing activity is not termination evidence.

The source explains three separate facts:

- `StrigoiSuccession.step` deliberately defers runtime-recovery adoption if current durable demand is absent. It does not send a startup greeting or invent a receipt. The historical demand decision cannot be reconstructed from missing activity records.
- `recoverRecord` reconstructs previously active records as interrupted with unknown exit -1. The new registry does not inherit process handles. A stored PID alone is not owned execution.
- Previously, any unavailable successor in committed/adopting/reconciling entered a permanent `successor-unavailable` hold, even after an exact observed exit. A terminal-only renewal path could not leave that transition. Fleet also partitioned the unavailable row into collapsed history/unconfirmed buckets.

## Recovery protocol

Host PTY transports publish their session/process-group identity with the durable generation record before resident activation. Retirement accepts an observed exact-generation exit, or a separately persisted host absence observation after both PID and process group return ESRCH. A present/reused PID, surviving process group, EPERM, missing record, generation mismatch, container identity or legacy record without this marker remains unknown. Probes send signal 0 only; recovered PIDs are never stopped or adopted. The original unknown exit code stays -1. Native descendants that escape the recorded host group and remote provider work are outside this OS probe's proof; no live Codex/orphan-cleanup acceptance is claimed.

Once retirement is confirmed, replacement is delayed by durable 1s/5s/30s backoff and limited to three replacements before usable recovery. Each link has a new transition ID, an explicit supersession edge and retained predecessor history/attempt IDs. A replay may follow only those edges; an unrelated renewal remains stale. The next packet combines captured originals with the retained latest packet. No ordinary input is retyped because a provider was lost, no completed receipt is fabricated, and no authority comes from packet prose. Existing reconciliation participants decide continuation from their journals. A new passive runtime can defer adoption again until meaningful durable input arrives; the control facade explicitly wakes reconciliation after accepting that input. Explicit resume resets an exhausted recovery episode after evidence checks.

Assigned-but-uncommitted launches remain reserved if outcome is unknown. A verified retired assigned runtime permits the existing bounded launch retry path; a reservation without process evidence remains held. This closes the safety gap without guessing that an interrupted spawn never ran.

Fleet treats an enabled canonical resident as current even when runtime presence is absent, retaining the honest presence value. Detail/status includes phase, ownership, last attempt and next action. Essential evidence (phase, packet, supersession, retry due time, attempt IDs, hold and host retirement observation) lives in fsynced canonical stores. General activity is best effort, emitted once per observed revision; its failure cannot block recovery.

## Validation and limits

Use Node 24.18.0. The added deterministic fixture suite covers interrupted replacement publication before/after a durable intent, repeated restart/backoff exhaustion, legacy/stale ownership, suspension/disable, packet/history retention, later adoption, stale-actor rejection and degraded activity. The isolated process suite forks separate controller processes with real production registry/lifecycle/stores and real host PTYs; it exercises graceful controller restart, forced controller SIGKILL, provider death, repeated death before adoption, and a surviving exact group. Model output and provider CLI use are absent in this suite. Existing production fault/delivery suites cover receipts, corrupt evidence, authentication, duplicate logical input and original durable boundaries. Check PR validation results for executed commands; a listed scenario is not by itself a passing result.

These tests do not prove a live provider, the full broker daemon shutdown/socket lifecycle, production rollout, remote app-server survival, inference semantics, hardware fsync under power loss or orphan cleanup. The currently stranded legacy runtime lacks the new process-group marker; deployment alone must not bypass its hold. PR #162 remained open at `9ea6e702bdbe54a74b921201a53ee5aeeb00a860`; Rust replay is not required for this protocol.

## Later rollout and rollback (operator approval required)

1. Review and merge the PR only after separate approval; build the exact approved revision with Node 24.18.0. Preserve the shared state directory and journals.
2. Record `cyberdeck strigoi status`, session/runtime identity and the exact broker binary revision. Investigate the legacy PID/group and any remote provider work read-only. If ownership is unresolved, keep the hold; do not patch state or signal a recorded PID. Any fencing/retirement of legacy work needs a separately reviewed concrete action.
3. Only after explicit approval for the shared restart/activation, stop through the normal broker lifecycle and start the approved binary. Verify desired state, exactly one owned active resident, retained packet/obligations and pending versus acknowledged adoption separately. Meaningful operator input should trigger adoption and exactly one logical delivery. Do not send a synthetic greeting as proof.
4. On regression, suspend through the resident lifecycle under explicit approval, preserve all new journal records, and return to the previous binary under the approved restart procedure. Older schema readers strip optional fields and cannot use new absence receipts; expect conservative holds rather than convergence. Do not edit/reset the state directory or replay ambiguous inputs.
