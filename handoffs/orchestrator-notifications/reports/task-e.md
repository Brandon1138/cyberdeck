Task E implemented. `pnpm check` passed; provider/architecture Vitest passed: 21 files, 219 tests. No commit. No broker wiring or live delivery proof.

Worktree: `/Users/brandon/code/personal/cyberdeck-worktrees/onf-task-e`

```bash
cd /Users/brandon/code/personal/cyberdeck-worktrees/onf-task-e
```

Base HEAD: `83b8159f35b7d22edf8ee95e549fbd475301401c`.

Files changed, final line counts:

- `src/providers/claude.ts`: 366
- `src/providers/claude/launch-settings.ts`: 62
- `src/providers/claude/notice-hooks.ts`: 31 (new)
- `src/providers/cursor/mcp-hosting.ts`: 148
- `src/providers/cursor/session-adapter.ts`: 196
- `src/providers/notice-hook-command.ts`: 41 (new in this worktree)
- `src/providers/shell-quote.ts`: 4 (new in this worktree)
- `tests/providers/claude-adapter.test.ts`: 988
- `tests/providers/claude-launch-settings.test.ts`: 102
- `tests/providers/cursor-adapter.test.ts`: 715
- `tests/providers/cursor-notice-hooks.test.ts`: 104 (new)
- `tests/providers/notice-hook-command.test.ts`: 23 (new)
- `handoffs/orchestrator-notifications/reports/task-e.md`: 95 (new report)

Claude: orchestrator-only PostToolUse/PostToolUseFailure (`matcher: ".*"`) and Stop (no matcher), merged with unchanged SessionStart and endpoint pin. Same MCP nodePath/cliPath/stateDirectory and installable guard. Workers/top-level settings unchanged. No asyncRewake.

Cursor: orchestrator-only version-1 `hooks/hooks.json` inside existing session plugin. postToolUse/postToolUseFailure only; no stop. Private launch-file writer, pretty JSON, trailing newline. Rewritten on launch/resume; stale file removed for workers/top-level sessions or missing MCP/stateDirectory. MCP files preserved. Constructor adds optional `stateDirectory`.

All notice commands use shared `noticeHookCommandLine`/`noticeHookEntryPath`; all notice timeouts use `NOTICE_HOOK_TIMEOUT_SECONDS` (2). Existing SessionStart timeout remains 5. Exact JSON, guards, resume rewriting, stale removal, permissions, entry paths and shell quoting covered. Dependency/file-size ratchets passed; no baseline edits. `git diff --check` passed. Codex, transcript-hook.ts, broker, CLI, MCP, domain and docs untouched.

Prerequisite discrepancy: base lacks three task-named files. Provider helpers copied verbatim from `/Users/brandon/code/personal/cyberdeck-worktrees/orchestrator-notification-feed/src/providers/`; `cmp` confirmed both identical. CLI `notice-hook-entry.ts` read there only; absent here. Orchestrator must retain/merge its CLI entry and notice reader before runtime activation. These tests prove generated launch configuration, not live hook delivery or fault handling.

Setup: `pnpm install --prefer-offline` passed. Host uses Node v26.7.0; package requests `>=24.18.0 <25`. Gates passed despite engine warning; supported-Node proof remains unverified.

`pnpm check` exit 0, verbatim output tail:

```text
[WARN] Unsupported engine: wanted: {"node":">=24.18.0 <25"} (current: {"node":"v26.7.0","pnpm":"11.5.0"})
Already up to date
Done in 279ms using pnpm v11.5.0
[WARN] Unsupported engine: wanted: {"node":">=24.18.0 <25"} (current: {"node":"v26.7.0","pnpm":"11.5.0"})
$ tsc -p tsconfig.json --noEmit
```

`pnpm exec vitest run --configLoader runner tests/providers tests/architecture` exit 0, verbatim output tail:

```text
 RUN  v4.1.11 /Users/brandon/code/personal/cyberdeck-worktrees/onf-task-e


 Test Files  21 passed (21)
      Tests  219 passed (219)
   Start at  18:39:07
   Duration  5.15s (transform 6.24s, setup 0ms, import 9.38s, tests 8.66s, environment 2ms)

```

Exact proposed `src/broker/main.ts` patch, not applied:

```diff
diff --git a/src/broker/main.ts b/src/broker/main.ts
--- a/src/broker/main.ts
+++ b/src/broker/main.ts
@@ -230,7 +230,7 @@
     allowsWorkspaceTrust: (source) => modalAnswerPolicy.allowsWorkspaceTrust(source),
     adapters: { codex: new CodexProviderAdapter({ mcp, workspaceTrust: grantGatedTrust(codexTrust) }),
       claude: new ClaudeProviderAdapter({ mcp, stateDirectory, workspaceTrust: grantGatedTrust(claudeTrust) }),
-      cursor: new CursorProviderAdapter({ mcp }), antigravity: new AntigravityProviderAdapter() },
+      cursor: new CursorProviderAdapter({ mcp, stateDirectory }), antigravity: new AntigravityProviderAdapter() },
     lookupSession: (id) => { try { return registry?.get(id); } catch { return undefined; } },
     submitEvent: (input) => workerEvents.submit(input),
   });
```

Docs must state:

- Claude requires MCP plus stateDirectory; Cursor requires same plus session plugin. Hooks install only for orchestrators.
- Claude success/failure events cover every tool; Stop uses entry-point `stop_hook_active` guard. No asyncRewake (D17).
- Cursor Shell failures use postToolUseFailure; MCP `isError` uses postToolUse. No plugin stop hook (D14).
- Dedicated command targets `cli/notice-hook-entry.<ext>` beside CLI entry, with explicit actor/state/format/event arguments (D15).
- D16 sidecar/quiet-interval semantics supersede spike's earlier read-only repeat-until-drain wording. Task E changes configuration only.
- Codex remains universal channels only (D12). No shared operator/workspace hook files written.

## ORCHESTRATOR: run these

Both requested gates ran successfully. Apply proposed wiring patch and merge CLI prerequisites before launch acceptance; live delivery remains separate proof.

Worker reporting blocked: CLI returned `connect EPERM /tmp/cyberdeck-501.sock`; MCP fallback returned `MCP tool call requires approval, but approval policy is never`. No event delivery confirmed. Submit from host:

```bash
cd /Users/brandon/code/personal/cyberdeck-worktrees/onf-task-e
cyberdeck event submit --worker d04f4331-72fa-48ee-8004-31f745916ede --kind PROGRESS --summary 'Task E implemented; pnpm check passed; provider/architecture Vitest 21 files, 219 tests passed. Cursor needs main.ts stateDirectory patch. Report: handoffs/orchestrator-notifications/reports/task-e.md. No commit or live activation.' --event-id task-e-complete-20261007
```
