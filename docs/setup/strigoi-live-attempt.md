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
