# Acceptance (MIK-257)

Layers: **unit** (vitest, scripted broker), **test-broker** (disposable state dir, socket and identity;
never the live broker), **live** (operator only, after activation).

| # | Behaviour | Layer | Evidence |
| -- | -- | -- | -- |
| 1 | Create without `approval` → `APPROVAL_REQUIRED`, nothing launched, refusal audited | unit | test name + audit record |
| 2 | Create with per-create approval → `CREATED`; `orchestrator.create.requested` carries the quote, kind, channel; binding carries `createdBy.{sessionId, approval, depth: 1}` | unit | test + binding log line |
| 3 | Peer holds the creator's full grant incl. `orchestrator.create`; peer creates a peer with its own approval; depth 2 | unit | test |
| 4 | Three live peers from one creator succeed; `PEER_LIMIT` absent from src/tests/docs | unit + grep | grep output empty |
| 5 | `peer-create off` → `DENIED` naming the toggle (unchanged) | unit | existing test |
| 6 | Scope narrowing, selection, brief delivery, memory and durable replay, replay under audit failure: unchanged | unit | MIK-256 tests green |
| 7 | Fleet creator can `thread.enqueue` to its peer orchestrator session | unit | new test |
| 8 | `cyberdeck_orchestrator_inspect` on a peer returns `createdBy` with approval and depth | unit or test-broker | result JSON |
| 9 | MCP `tools/list` shows `approval` on `cyberdeck_orchestrator_create`; description has no cap language | unit | schema assertion |
| 10 | Creator and peer prompts contain the ask-first rule | unit | prompt test |
| 11 | Full gate: `pnpm check`, full vitest, dependency rule, file-size ratchet | host | counts in the PR |
| 12 | Phone flow: from Remote Control the operator asks for a peer; the orchestrator asks; "yes, create it"; the call carries that quote; Fleet shows the peer with its creator; inspect shows the quote | live | operator transcript + inspect output |

## Operator activation (not the worker's job)

1. Merge the PR (main requires resolved conversations and linear history; squash).
2. The main checkout holds uncommitted Codex Remote Control work and sits at `b112758`. Move that work
   onto its own branch (commit, do not stash: the stash stack is shared) so `main` can fast-forward to
   the merge commit. The running broker keeps its current `dist` until step 4.
3. `pnpm build` in the main checkout with Node 24.
4. In a change window with every fleet idle: `cyberdeck broker restart && cyberdeck broker status`.
5. `cyberdeck orchestrator peer-create on --scope fleet` once for the pre-existing fleet binding.
6. Run row 12 from the phone against a fresh orchestrator. Rollback: rebuild from the previous commit
   and restart again.
