# Current native lifecycle result — 2026-11-14

At source `bdaaa757083e8d1d42299516d5f5c76ea7131b4b`, the approved isolated r06
lifecycle observed the complete mechanics: 600,514 ms idle, no-checkpoint recovery,
ordinary input and native worker-result delivery with attention state migration,
three planned renewals,
confirmed process exit with service reopen, and a matched ordinary-session baseline
with six native replies. The physical resident high-water was one. All eight owned
provider processes exited and the isolated daemon stopped. This is
**MECHANICS OBSERVED; SEMANTICS UNQUALIFIED**, not full release qualification.

Codex 0.169.0 used `gpt-6.1-sol/high` in the selected Strigoi worktree. All CI jobs
passed at that source: macOS, Linux x64/arm64, five distro jobs, and WSL. Local
check passed; the full suite had 4,233 passes, 27 skips and one ten-second timeout
in the fsync-after-committed succession case. The complete affected file then
passed all 60 tests unchanged; build passed. Original failure evidence is retained.
Source snapshots matched across the full run.

The independent whole-branch review remains **source APPROVED with limits** at
`64b1dfb`; subsequent readiness fixes have controller review and regression/live
evidence, without a new independent-review claim. Two nonblocking P3 retry findings
remain in [the review](strigoi-review.md). Human grading of the seven semantic pairs,
complete upstream request counting, passive controller-crash/native orphan cleanup,
automatic attention-wake delivery, and production capacity remain unqualified.
Attention was armed and migrated, but its final record has no wake receipt.
Zero encoded prompts and canonical
turns during idle do not establish zero upstream inference.

See [native attempts](strigoi-live-attempt.md) and the
[evidence manifest](strigoi-evidence-manifest.json) for provenance and historical
failures. Private transcripts remain outside Git.

The run started at `2026-11-14T18:16:24.464Z` and finished at `2026-11-14T18:53:12.259Z`.
The matched baseline recorded six canonical native completions. Across the run,
18 canonical completions were recorded; 17 calls passed through the observed
input encoder (initial worker input uses launch construction). Neither count is
an upstream inference-request count. Renewal adoption durations were approximately
145, 303, and 356 seconds; they are observations, not a capacity guarantee.

Private result: `/tmp/sg14r06/gate-result.json`.
SHA-256: `481c5d51ea0fff3b5da5c669aba42749b054ff37dad5b97bb69ee82082fd5c2d`.

The sections below preserve earlier failures and their remediation. Their pending
or unresolved statements describe those historical attempts, not the current result.

## Started native work and the completion deadline

At source `576c2f3`, full check/test/build passed (4,226 tests; 27 skips), all
source snapshots matched, and every CI job including macOS and WSL passed. The
approved r05 lifecycle passed 600,676 ms idle, no-checkpoint recovery, ordinary
input, and native worker delivery. First planned renewal then reached the fixed
120-second adoption hold while reading nine evidence pages. Its exact native
completion arrived after approximately 151 seconds. All provider processes exited;
the first isolated daemon-stop call timed out, and the subsequent scoped stop
confirmed `notRunning`. Original result and cleanup failure remain preserved.

The next remediation distinguishes unknown submission from observed native work.
Unknown execution and hung submission retain the 120-second bound. An exactly
bound native start/end after the rendered input permits at most ten minutes for
the durable semantic receipt, measured from the original persisted attempt start.
This observation cannot acknowledge adoption, transfer coverage, or cause replay.
Stale, unbound, unreadable, and timestamp-free evidence cannot extend the bound.
Typecheck and 53 focused checks pass, including restart and no-replay regressions.
A fresh r06 full lifecycle is explicitly approved; its result is pending.

## Work-cycle remediation and fresh qualification

The delayed-redraw defect below now has a failing-before/passing-after regression.
Codex explicit work-cycle notifications fence one working interval; repeated redraws
do not create newer work. A cycle must close and an exactly bound native completion
must remain current before admission. New remote cycles, local input, generation
changes, modals and unannounced positive work still fence older completions.

The matched native streaming diagnostic at `/tmp/sg14r04/admission-probe-06`
completed both turns with native provenance and admitted the second instruction
once. Its owned process exited and isolated daemon stopped. Typecheck and 108
focused tests passed. This fixes the reproduced admission scenario; full lifecycle
qualification is still pending in the separately approved fresh `/tmp/sg14r05`.

CI at `317a537` passed Linux x64/arm64, all five distro jobs and WSL. macOS failed
one test during fixture deletion with `ENOTEMPTY` after late Scout trace output.
The fixture now waits for outstanding trace writes before deleting its directory;
the affected Scout tests pass. Results at earlier heads remain historical evidence.

# Readiness continuation: 2026-11-14

At source `833a7a44aee27b524ef3a69413a3787783e9ed40`, all CI checks and the
full local check/test/build passed (4,219 tests, 27 skips). The approved isolated
`/tmp/sg14r04` run completed the full ten-minute idle interval and recovered through
an exact-marker native adoption. This resolves the earlier missing-marker failure
described below. Normal input subsequently remained queued as `provider-busy`;
the lifecycle run failed before worker, renewal, and matched-baseline stages.

A bounded streaming diagnostic in the same approved native home reproduced the
admission failure independently of Strigoi. In `admission-probe-05`, Codex recorded
`task_complete` at `2026-11-14T17:00:13.117Z`, while its terminal continued to report
working redraws until `17:00:14.534Z`. The engine banked one canonical completion,
but its native activity view became historical/unknown because `lastWorkingAt`
was later than the native completion timestamp. The second instruction stayed
queued, even after the terminal showed ready. No submitted prompt was retyped.
The owned provider exited and the isolated daemon stopped.

This is an unresolved readiness blocker. A fix must distinguish delayed redraws
from actual newer provider work while preserving input, generation, and stale
completion fences. No full lifecycle or semantic qualification is claimed.

A separate discovery fix excludes inspected rollouts carrying exact foreign actor
markers when deciding whether this actor's source is missing. It never binds a
foreign result. Unknown or unmarked rollouts still hold admission. Typecheck and
50 binding/source-policy tests pass. A reused-home passive probe remained held by
an unmarked rollout from an earlier aborted launch; that is not a live pass for
the discovery change.

Private diagnostic artifacts remain under `/tmp/sg14r04/admission-probe-01`
through `admission-probe-05` and the worktree's
`handoffs/strigoi-continuation-20261114/`. Historical evidence below is preserved.

# Bounded live acceptance attempt — 2026-11-14

The operator approved the selected isolated campaign with a ten-minute total limit.
The first lifecycle invocation at source `6bc9f7361ae850a07d4a8b72897aae14256cb03d`
failed before native session launch with `ORCHESTRATOR_SELECTION_UNSUPPORTED`.
The sequential campaign stopped at that first failure; nine later cases are NOT RUN.

The specified PATH resolved `/opt/homebrew/bin/codex` to **codex-cli 0.153.2**.
Its first-party model query omitted the selected `gpt-6.1-sol`. The interactive CLI
is `/Users/brandon/.local/bin/codex`, **codex-cli 0.169.0**; a subsequent read-only
query against the same isolated home listed `gpt-6.1-sol` with `high` effort.
No model substitution or later live retry was performed during that bounded attempt.

The failed controller ran from 13:24:40.082Z to 13:24:40.944Z. Its ownership journal
contains only the controller: zero provider processes, zero encoded submissions,
and an empty canonical-turn inventory. Registry cleanup completed. This does not
supply an upstream inference-request counter or any native continuity qualification.
Private evidence remains in `/tmp/sg14c00`; it was not deleted or uploaded.

A process-local deadline guard was used to route lifecycle inspection into the
runner's existing cleanup path by the nine-minute mark, reserving one minute for
shutdown. The ten-minute idle requirement was not shortened. It was never reached.
The source tree was unchanged; this attempt does not invalidate the passing source gates.

A corrected retry must pin the 0.169.0 CLI ahead of Homebrew on PATH and use a fresh
state directory. The full lifecycle needs ten minutes of idle observation **plus**
startup, ordinary use, renewals and cleanup, so it cannot qualify within a ten-minute
total campaign. Human semantic grading, complete request counting, native orphan
cleanup and capacity qualification remain outstanding.

Evidence SHA-256 (`gate-result.json`): `6507357bd4a593642969b60d358a5c785cdc9c8eaeea6c2df02f75880421296c`.

## Full-lifecycle retry with corrected CLI

The operator subsequently approved pinning the version and running full lifecycle
qualification, superseding the earlier ten-minute total cap. Source remained
`915171300a45b49e06597a489428196f3c0489a4`.

Codex 0.169.0 launched one resident in `/tmp/sg14r00`, then held at a native
permission modal before any prompt submission. An observation-only repetition in
`/tmp/sg14r01` captured the exact structured `workspace-trust` dialog. It says
trusting the selected worktree applies to repository root
`/Users/brandon/code/personal/cyberdeck`, and folder settings may execute code
automatically. Available answers are “Trust and continue” and “Back to Agent
Command Center”. No answer or trust-setting change was made.

Both runs retained zero prompt submissions, observed their one resident exit,
and completed isolated daemon shutdown. Both stopped before the idle gate.
Private evidence directories remain preserved. Explicit approval was requested
to save repository trust only inside the next fresh isolated acceptance home;
that decision was subsequently approved for the trusted run below. No primary-home
configuration or broker was changed.

The version mismatch is resolved. These startup attempts did not qualify
lifecycle/renewal/recovery or semantic acceptance.

## Trusted full-lifecycle attempt

The operator approved repository-root trust in the isolated acceptance home. It was
written only to `/tmp/sg14r02/native/cyberdeck-orchestrator/config.toml`. The source
was `45c7a549c4bb21d1d9b986622d4ab3f2ea17cebe`, with unchanged reviewed implementation
bytes. The run used Codex 0.169.0, `gpt-6.1-sol/high`, and the selected worktree cwd,
from 13:39:37.181Z through 13:51:51.746Z.

The full idle observation lasted **600,749 ms**, with zero encoded prompt submissions
and zero canonical turns. Two terminal fallback records contained startup screens;
they are not native completion evidence. Complete upstream inference counting remains
unavailable, so this is not a zero-inference qualification.

After confirmed predecessor exit, one successor launched and received one adoption
prompt. Its native transcript records the selected model/effort and a `task_complete`
frame containing the adoption response. However, the native developer records contain
no Cyberdeck actor marker. Read-only replay through the production
`CodexConversationDiscovery` returns `NATIVE_CONVERSATION_UNBOUND`, and the broker
completion ledger remains at zero. After the 120-second adoption deadline, the run
failed with **`adoption-outcome-unresolved`**. No prompt was blindly repeated and no
binding was manufactured. Launch construction supplies the developer-instruction
override; the precise point at which it is omitted from the native conversation is
not yet established.

The physical resident high-water was one. Both owned resident processes confirmed
exit, registry cleanup completed, and the isolated daemon stopped. Evidence remains
in `/tmp/sg14r02`; trust and private transcripts were not copied to the primary home.
Normal conversation, worker/result/attention, three planned renewals, later recovery,
and the matched ordinary baseline were **NOT RUN** after the first failed recovery
gate. Full lifecycle qualification has therefore **failed**, not passed with limits.
The two separate crash cases, seven semantic pairs, human grading and capacity gates
also remain outstanding.

Evidence SHA-256:

- `gate-result.json`: `bc7c3e8293d904e031c53de02a48e12327681508d4de797b7306ed2e419b3f8c`
- Native transcript: `bbceae0cf66622046150edc35747212f33c5d009e21882a6fb1d8acacf24b9e9`
