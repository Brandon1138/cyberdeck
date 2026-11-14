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
