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

Use Node 24.18.0. The added deterministic fixture suite covers interrupted replacement publication before/after a durable intent, repeated restart/backoff exhaustion, legacy/stale ownership, suspension/disable, packet/history retention, later adoption, stale-actor rejection and degraded activity. The isolated process suite forks separate controller processes with real production registry/lifecycle/stores and real host PTYs; it exercises graceful controller restart, forced controller SIGKILL, provider death, repeated death before adoption, and a surviving exact group. A further full `runBroker` daemon test uses a private socket/state directory to prove that unknown-ownership holds survive graceful and forced daemon restarts without a provider launch. Model output and provider CLI use are absent in this suite. Existing production fault/delivery suites cover receipts, corrupt evidence, authentication, duplicate logical input and original durable boundaries. Check PR validation results for executed commands; a listed scenario is not by itself a passing result.

These tests do not prove a live provider, healthy live-provider broker-daemon convergence, production rollout, remote app-server survival, inference semantics, hardware fsync under power loss or orphan cleanup. The currently stranded legacy runtime lacks the new process-group marker; deployment alone must not bypass its hold. PR #162 remained open at `9ea6e702bdbe54a74b921201a53ee5aeeb00a860`; Rust replay is not required for this protocol.

## Later rollout and rollback (operator approval required)

1. Review and merge the PR only after separate approval; build the exact approved revision with Node 24.18.0. Preserve the shared state directory and journals.
2. Record `cyberdeck strigoi status`, session/runtime identity and the exact broker binary revision. Investigate the legacy PID/group and any remote provider work read-only. If ownership is unresolved, keep the hold; do not patch state or signal a recorded PID. Any fencing/retirement of legacy work needs a separately reviewed concrete action.
3. Only after explicit approval for the shared restart/activation, stop through the normal broker lifecycle and start the approved binary. Verify desired state, exactly one owned active resident, retained packet/obligations and pending versus acknowledged adoption separately. Meaningful operator input should trigger adoption and exactly one logical delivery. Do not send a synthetic greeting as proof.
4. On regression, suspend through the resident lifecycle under the approved rollback procedure and preserve all new journal records. Use only a tested rollback build that understands every persisted schema field. Older schema readers strip unknown fields before verifying journal hashes and can reject the advanced journal as corrupt; they do not necessarily start with a conservative hold. A rollback build with receipt-schema compatibility but without receipt-driven retirement can retain the records and safely hold. Do not edit/reset the state directory or replay ambiguous inputs.

## Explicit legacy retirement reconciliation

`cyberdeck strigoi reconcile-legacy` inspects an unavailable committed/adopting/reconciling host Codex successor without changing state. This Darwin-only migration is deliberately limited to a terminal, unknown-exit (`-1`) legacy PTY launch carrying the exact actor-session arguments and remote managed-daemon transport. It does not retrofit an automatic process-group marker.

An operator must audit two historical facts that current process inspection cannot establish: the original launch used the node-pty setsid contract (initial process group equals PTY PID), and the identified managed Codex home served that launch. An empty unrelated daemon is insufficient. If either attribution remains unknown, keep the hold.

After the approved suspension, inspect again and bind confirmation to the returned session, generation, PID, transition, revision and record hash:

```sh
cyberdeck strigoi suspend --mutation-id <stable-suspend-id>
cyberdeck strigoi reconcile-legacy
cyberdeck strigoi reconcile-legacy \
  --confirm-host-pty-provenance --confirm-managed-daemon-provenance \
  --managed-home <audited-absolute-managed-home> \
  --session-id <id> --generation <n> --pid <pid> \
  --transition-id <id> --expected-revision <revision> \
  --record-sha256 <hash> --mutation-id <stable-confirmation-id> \
  --provenance '<historical launch and managed-home evidence>'
```

Confirmation performs fresh bounded read-only checks: PID and process group absence, one managed daemon with matching PID/start time, ownership of its canonical control socket, a complete empty native loaded-thread roster, and unchanged daemon/socket identity afterward. Unknown, nonempty, changed or unavailable evidence fails closed. The authority lock and final identity/revision recheck fence stale confirmation. Retry an uncertain response with exactly the same mutation ID and payload; inspect the durable result before issuing another operation.

The receipt is separately appended to the Strigoi journal. Confirmation preserves suspended desired state, the hold, exit `-1`, missing process-group marker, selection, packet and prior history. It neither starts a provider nor sends inference. A later approved `strigoi resume` uses the existing backoff, successor creation, packet reconciliation and adoption path. The saved model/effort remain unchanged. Suspend and preserve advanced state on rollback; restoring a snapshot would erase later receipts and is not a rollback strategy.

Deterministic tests exercise the receipt through a fresh registry/controller, ordinary replacement and exactly one adoption, as well as stale identities, ambiguous writes and ownership races. Native socket and Darwin process tests cover incomplete rosters, daemon changes, extra servers and reappearing process groups. Live private-provider qualification and shared operational acceptance must be reported separately.

## Interrupted replacement attention

An interrupted A→B→C recovery can leave the durable worker-review wait owned by A until C reconciles it. Attention preservation and the missing-record check follow only explicit `supersededBy` links from the current transition, with exact adjacent session/incarnation/generation matches. Unrelated completed renewals and retained packet prose do not authorize a transfer. Invalid or ambiguous linked history fails closed.

The final successor rebinds the existing durable wait from its actual owner, preserving consumed coverage and pending-intent provenance. It rechecks the chain at the attention-store commit. Operator tombstones and native cancellation receipts remain authoritative; missing live wait evidence holds recovery instead of restoring a potentially cancelled archived wait. Production-method tests cover restart, cancellation, missing evidence and ancestry changes during capture; the driver integration also kills B before worker reconciliation and verifies C receives A's result obligation without redispatching the worker.
