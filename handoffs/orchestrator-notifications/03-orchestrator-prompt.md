# Execution directive: orchestrator notification feed

Paste the block below into a fresh Cyberdeck orchestrator.

```text
Implement the orchestrator notification feed planned in /Users/brandon/code/personal/cyberdeck/handoffs/orchestrator-notifications.

Start by reading, in order: README.md, 00-spec.md, 01-implementation-plan.md, 02-acceptance.md. The plan is decided except for items marked PENDING; those are yours to settle after the hook spike or your first read of the seam, and you record each decision in docs/architecture/orchestrator-notifications.md.

Goal: an orchestrator keeps working after cyberdeck_workers_start and is told, through a one-line notice, when a worker it controls settles, blocks, asks for a decision, or loses an instruction; it drains details with cyberdeck_notifications_read. Works for Claude, Codex and Cursor orchestrators and any worker provider.

Branch and workspace:
- Integration branch: feat/orchestrator-notification-feed, cut from current main (verify HEAD first; main was 60c2905 when the plan was written and the main checkout carries unrelated uncommitted edits you must not touch or stage).
- Every worker runs in a Cyberdeck-provisioned worktree on its own task branch cut from the integration branch (feat/orchestrator-notification-feed/<task>). Workers cannot commit inside linked worktrees: collect their diffs and commit on the host yourself, with full vitest, the dependency rule and the file-size ratchets green before each commit. Grant node_modules as a writable root when a worker needs to install.
- Never restart the live broker and never touch ~/Library/Application Support/Cyberdeck. Other orchestrators and fleets are live on this broker. Any test broker uses a separate state directory, socket and identity.

Team and order:
- Workers: Codex or Claude only; Cursor workers currently hang on approval prompts. Use cyberdeck_provider_capabilities for exact model ids. At most two implementation workers at once.
- Task S (provider hook spike) and Task A (domain + store) start together. S runs outside the broker with scratch hook configs only: --settings for Claude, a scratch CODEX_HOME for Codex, a scratch project directory for Cursor; it must not edit the operator's real hook files. S writes its matrix to docs/architecture/provider-parity.md and decides Task E.
- Then B (producer) and C (delivery), then D (control plane), then E (hooks) and F (prompt + docs). G (acceptance) last.
- You own src/broker/main.ts, src/mcp/server.ts tool registrations, src/protocol, shared domain schemas and the orchestrator prompt text in src/orchestration/orchestrator-manager.ts. Workers hand you patches for those files; nobody races edits in a shared checkout.

Invariants:
- One truth: every reported state comes from projectWorkerTruth, WorkerCoordinationService.projectEvents and instruction records.
- Notices only, never payloads unasked; notices ≤200 chars (≤400 with one inlined critical summary), summaries ≤512, drain pages ≤50.
- At-least-once with cursor acknowledgement; drops are counted and reported, never silent.
- Human control keeps priority on every delivery channel; wakes go only through the existing instruction queue, never tmux.
- Worker-side reporting tools stay unchanged. cyberdeck_workers_wait stays and must agree with the feed.

Done means: one PR from feat/orchestrator-notification-feed with feature, tests, prompt text, docs and CHANGELOG, plus the 02-acceptance.md table filled in for the scripted and test-broker layers. Do not run the live-broker acceptance step; stop and hand the operator the exact restart and launch commands, with scripted, test-broker and live evidence reported separately.
```
