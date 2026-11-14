# Bounded live acceptance attempt — 2026-11-14

The operator approved the selected isolated campaign with a ten-minute total limit.
The first lifecycle invocation at source `6bc9f7361ae850a07d4a8b72897aae14256cb03d`
failed before native session launch with `ORCHESTRATOR_SELECTION_UNSUPPORTED`.
The sequential campaign stopped at that first failure; nine later cases are NOT RUN.

The specified PATH resolved `/opt/homebrew/bin/codex` to **codex-cli 0.153.2**.
Its first-party model query omitted the selected `gpt-6.1-sol`. The interactive CLI
is `/Users/brandon/.local/bin/codex`, **codex-cli 0.169.0**; a subsequent read-only
query against the same isolated home listed `gpt-6.1-sol` with `high` effort.
No model substitution or later live retry was performed.

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
that decision is pending. No primary-home configuration or broker was changed.

The version mismatch is resolved. Native workspace trust is the current blocker;
lifecycle/renewal/recovery and semantic acceptance are still unqualified.
