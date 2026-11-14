# Strigoi final source review

Reviewed source: original base `54c9234a41bad511f19e6370b3ed83f22a585e4b` through
`64b1dfbd3ed2626d1a57d102ba9fc9e53afd395e`. Independent reviewer verified all 32
remediation source/test hashes and reverse-checked the recorded patch
`c24829864d0387d3b4c2a642bc38fe8a13aefb4213f398393de4925495b0eaf4`.

Verdict: **source APPROVED with limits; live NOT QUALIFIED**. No blocking source
defect found in the reviewed paths. This is approval for an open draft PR, not
production capacity or release approval.

Controller final gates on identical source bytes: typecheck/build passed; **311 files /
4,216 tests passed**, with 1 file / 27 deliberate skips. The controller committed
unchanged source while tests ran; all 858 tracked source/test/script/configuration
hashes match before and after. All ten live invocations also passed validation only.

## Nonblocking findings

- **P3: stale scheduling preparation.** `src/orchestration/orchestrator-attention-control.ts:211`
  retains `snapshot` across preparation retries. Prepare an armed snapshot, cancel
  under binding authority before CAS, then retry against the cancelled record:
  the old armed snapshot is returned. An in-memory production-callback probe
  reproduced unnecessary stale decision evaluation. Scheduler epoch/input checks
  and final wake admission prevent obsolete provider effects. Proposed fix: reset
  the attempt-local snapshot at callback entry.
- **P3: stale successor final check.** `src/orchestration/orchestrator-attention-succession.ts:78`
  retains `finalCheck` when a retry returns early. Prepare migration, cancel the
  wait and change grants before CAS, then retry: cancellation survives, but the
  discarded closure can throw `OWNERSHIP_LOST`. A second in-memory callback probe
  reproduced a spurious reconciliation hold; the next invocation recovers.
  Proposed fix: reset `finalCheck` at every preparation entry, and similarly reset
  the cancellation metadata in `updateAttentionRefresh`.

These findings remain open. The review did not authorize enabling the resident.

## Verified remediation

Instruction/transcript writers acquire binding authority before their writer
queues. Successful worker completion after sealing is recognized before process
recovery. Typed archive corruption preserves conservative pins while ordinary
publication continues. Archived participant obligations are inspected regardless
of workflow ownership. Packet v2 proofs authenticate against the packet root;
v1 remains readable. Continuity commits revalidate current identity, grants,
packet membership and state.

The journal overwrite fix invalidates after append, validates actual disk bytes,
and isolates returned projections. Archive replay checks chain links and the old
durable head. Ambiguous writes retain protection and require confirmation.

## Scaling and evidence limits

Archive post-append replay still runs inside capture authority; cumulative replay
reads are quadratic. The final 768-capture interval measured 63.06 seconds, versus
42.72 seconds on inherited remediation and 40.84 seconds on the older HEAD.
Reduced index writes (242 MB to 0.56 MB), inventory reads (153 to 17), and unrelated
binding delay during acknowledgement (485 ms to about 6 ms) do not establish
capture-time responsiveness. General resident capacity remains unqualified.

The reviewer used two small in-memory probes and inspected source/check evidence;
it did not run native providers or human semantic grading. Native lifecycle,
request-level inference counting, orphan cleanup, and all seven human semantic
comparisons remain separate acceptance gates. See [acceptance](strigoi-acceptance.md).
