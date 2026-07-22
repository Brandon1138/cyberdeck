# Product

## Register

product

## Users

Developers coordinating several local AI coding agents from a terminal. They need to move quickly
between repositories and conversations, understand which agent needs attention, and intervene
without losing durable work when panes or terminal clients close.

## Product Purpose

Cyberdeck is a provider-neutral local cockpit for durable agent sessions. It keeps provider process
ownership in the broker, projects familiar views through tmux, and makes agent state, model choice,
delegation, steering, stopping, and deletion explicit. Success means the fleet view becomes useful
enough for daily work before broader orchestration features are added.

## Brand Personality

Familiar, truthful, restrained.

## Anti-references

- Speculative multi-panel dashboards that obscure the active task.
- Provider-branded behavior, rankings, implicit model choices, or silent fallback.
- Decorative terminal interfaces that trade density or keyboard fluency for novelty.
- Controls whose label hides whether an action stops a process, detaches a view, or deletes history.

## Design Principles

- Start from the proven Claude Code Agents interaction pattern and change only what provider
  neutrality and honest lifecycle semantics require.
- Keep projects, agent state, the latest meaningful preview, and recency visible at a glance.
- Treat detached sessions as the same durable runtime, never as disposable background work.
- Let tmux own layout and navigation while the broker owns every provider process and PTY.
- Add features only after daily use demonstrates that they earn space in the interface.

## Accessibility & Inclusion

The interface is keyboard-first, never communicates state through color alone, remains legible in
reduced-color terminals, preserves standard tmux and terminal shortcuts, and degrades cleanly in
narrow panes. Motion is limited to state refreshes and terminal cursor behavior.
