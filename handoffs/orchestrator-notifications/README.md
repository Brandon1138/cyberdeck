# Orchestrator notification feed: planning handoff

Prepared 2026-10-07. Planning artifact only: no implementation, configuration change, broker restart or worker dispatch was performed. Other orchestrators were live on the broker while this was written; nothing here touched them.

Repository: `/Users/brandon/code/personal/cyberdeck` (main at `60c2905`, working tree carried unrelated uncommitted edits; this directory is new and untracked).

```sh
cd /Users/brandon/code/personal/cyberdeck/handoffs/orchestrator-notifications
```

Read in order:

1. [00-spec.md](00-spec.md): what Claude Code does natively, what each provider CLI exposes, what Cyberdeck already has, and the design.
2. [01-implementation-plan.md](01-implementation-plan.md): sequenced deliverables, source ownership, interfaces. Implementation details are deliberately left open where a spike has to answer first; those spots are marked **PENDING**.
3. [02-acceptance.md](02-acceptance.md): behaviours that must hold, fault cases, evidence to collect.
4. [03-orchestrator-prompt.md](03-orchestrator-prompt.md): copyable execution directive, activated only when the operator says so.

## The one-paragraph version

Claude Code lets an orchestrator keep working while background subagents, background commands and monitors run, and drops a short automated event (a `<task-notification>`) into the orchestrator's context the moment something finishes or needs a decision. That watcher only sees Claude Code's own in-process tasks. Cyberdeck workers are external provider CLIs, so the orchestrator today has to sit inside `cyberdeck_workers_wait` to learn anything, which costs a blocked turn and 90-second resume calls. The plan reproduces the push model at the broker: every worker state change and worker event that matters to its controlling orchestrator lands in a durable per-orchestrator inbox; the orchestrator sees a one-line *notice* (never the payload) either next to its next tool result while it is busy, or as a wake at a safe input boundary while it is idle; it drains the inbox with one new tool. The universal path works for any orchestrator provider because it rides two seams Cyberdeck already owns: the MCP tool-result envelope and the instruction queue. Per-provider hooks (Claude, Codex, Cursor all have `PostToolUse`-style context injection) make the notice reach the model even when it is calling non-Cyberdeck tools.

## Recommended execution shape

One Orc plus two implementation workers, Codex or Claude only (Cursor workers currently block on approval prompts). A spike worker runs first and alone, because the provider hook behaviours decide the shape of Task E. Everything in Tasks A to D is provider-neutral and can start in parallel with the spike.
