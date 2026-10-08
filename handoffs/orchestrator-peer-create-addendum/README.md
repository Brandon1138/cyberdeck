# Peer orchestrators addendum (MIK-257): approval instead of a cap

Prepared 2026-10-08. Planning artifact only: nothing here changed code, configuration or the live
broker. Linear: [MIK-257](https://linear.app/mikoshi/issue/MIK-257) (parent MIK-254). Builds on
MIK-256 / PR #129, merged to main as `f1619a5`.

```sh
cd /Users/brandon/code/personal/cyberdeck/handoffs/orchestrator-peer-create-addendum
```

Read in order:

1. [00-spec.md](00-spec.md): what PR #129 bounds, the operator's rule, the decisions, the tool contract.
2. [01-implementation-plan.md](01-implementation-plan.md): file-by-file deliverables, order, gates.
3. [02-acceptance.md](02-acceptance.md): behaviours that must hold, evidence per layer, operator activation.
4. [03-orchestrator-prompt.md](03-orchestrator-prompt.md): copyable worker and reviewer prompts.

## The one-paragraph version

PR #129 let an orchestrator start a peer orchestrator from the phone, but bounded it two ways: at most
two live peers per creator (`PEER_LIMIT`), and a peer whose grant lacks `orchestrator.create`, so
orchestrators cannot delegate orchestration. Both bounds were a stand-in for a human in the loop. The
operator's rule replaces them: no cap, and every create is preceded by asking the operator in chat;
their express approval, quoted verbatim, is what authorizes the call. The broker cannot read the chat,
so it enforces what it can (a required, bounded, journaled `approval` argument on every create, lineage
and approval on the peer's binding, visible in inspect and Fleet, and the existing per-scope
kill-switch) and the prompt contract carries the rest. Peers keep the full creator grant, so a created
orchestrator can create and manage orchestrators under the same rule.

## Recommended execution shape

One Orc, one implementation worker, one read-only reviewer, Codex or Claude only (Cursor workers block
on approval prompts). The change is contained: one domain file, one service, the MCP tool entry, the
prompt text, docs and the MIK-256 test file. The worker runs in a Cyberdeck-provisioned worktree on a
branch cut from `origin/main` at or after `f1619a5`; commits happen on the host with the full gate
green. No broker restart: activation is the operator's separate step (02-acceptance.md).
