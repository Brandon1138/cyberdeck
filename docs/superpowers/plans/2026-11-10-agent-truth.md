# Fleet agent visibility and truthful status implementation plan

Goal: make launched workers discoverable and give current activity, human attention, draft safety and observation availability distinct meanings.

Execution: inline in an isolated worktree; final independent review. Deadline: 2026-11-10 12:45:46 UTC; deliver an open PR.

1. Discover native Codex children through exact conversation bindings and native parent/child edges. Project them read-only, without creating leases or claiming broker process ownership. Preserve observed children when their source becomes unavailable.
2. Recognize all supported Codex effort footers. Render drafts as Idle, actual blocking prompts as Needs you, and unknown activity as Unavailable with the last confirmed observation where known. Preserve delivery and completion fences.
3. Use a flat current-session view for the updated broker, stable names/order, project filtering, explicit parent/source information, and separate history. Keep compatibility with older snapshots.
4. Test the reported status sequence, exact native lineage, source loss, readonly controls, snapshot deltas and current-view membership. Run typecheck/build/full suite and an isolated wire/render check. Publish the tested branch as an open PR.

Ruling: this plan records the user-approved conversation directly; no additional approval gate or implementation-agent dispatch is needed.

Execution record:
- Regression tests reproduced the max/ultra footer, draft attention, missing native rows and read-only control failures before implementation.
- Native discovery was checked read-only against the running Codex data: exact binding resolved four distinct children with independent working/idle events. The shared broker and TUI were not restarted.
- Independent review identified malformed-source handling, binding loss, picker/draft interaction, last-confirmed visibility, inventory bounds and filter focus. The author fixed these in one pass; regressions cover corruption, lost binding, large output, picker entry, draft spaces and filter palette cleanup.
- Ruling: native rows are observation-only and never enter the broker registry or lease substrate. Their process presence stays unconfirmed; native lifecycle events establish activity only. Cost: parent-owned controls remain in the provider.
- Ruling: discovery is bounded to 500 bound roots, 2,000 children and 4 MiB per transcript read. Current children sort before closed history; truncation is explicit and previously discovered omitted rows are retained as unavailable. Cost: larger fleets need pagination for complete discovery.
- Node 24.18.0 compile and asset build passed. Focused tests passed; final host socket/full-suite results are reported in the PR. Sandbox socket failures are not treated as application failures or live acceptance.
