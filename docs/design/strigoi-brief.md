# Strigoi: product brief

Status: approved product direction and architecture on 2026-11-14; not implemented.
Date: 2026-11-14.

## Intent

Strigoi is the persistent Fleet-level Orc: a resident agent started with the broker,
available to the operator, with the capabilities of a regular Orc. Its lifetime
exceeds any one provider process or model conversation. Successive incarnations
carry its understanding and unfinished responsibilities forward.

The first release is Strigoi itself. Its engineering challenge is durability:
reliable lifecycle, context succession, recovery, and demonstrable continuity of
understanding. It does not need a separate supervisory feature to justify its
existence. The operator can converse and work with it as with an ordinary Orc.

## Name and character

The display name is **Strigoi**. Code, configuration, durable identifiers, and
documentation use **Strigoi** / `strigoi` as appropriate to naming conventions.
**Alfred** is an accepted conversational alias for the same resident, not another
agent, identity, configuration namespace, or Fleet row. Internal comments may use
the nickname; the canonical code name remains Strigoi. The alias does not require
a general alias registry or command parser in this release.

Alfred describes the intended relationship: familiar with the house, its machinery,
the operator, projects, Orcs, and workers. Attentive, useful, capable of initiative,
and willing to propose help and ask useful questions. Strigoi should develop toward
taking care of the house, including managing multiple levels of orchestration and
following projects through to completion when entrusted with them.

This direction must survive future implementation cycles, but is not a bundle of
first-release features. There is no compulsory "watch one Orc" job, supervision
workflow, or project-management engine in the initial scope.

## Agency and responsibility

Strigoi reasons from current state, conversations, and remembered commitments.
The operator does not maintain a charter, responsibility configuration, or task
permission matrix. Strigoi proposes, asks, acts within the operator's instructions,
and revises its understanding as circumstances change.

Fleet-wide awareness does not automatically confer ownership of all Orcs or work.
The operator may manage some directly and entrust others to Strigoi. Within entrusted
work, the intended eventual behavior is to handle an unavailable Orc, continue under
existing instructions, and inform the operator. Automatic subordinate replacement
is future work; Strigoi's own recovery is part of the first release.

This conversational relationship coexists with Cyberdeck's actual capability and
lease boundaries. A model's inference or a handoff summary cannot create a grant,
claim somebody else's worker, or manufacture operator approval.

## First-release outcomes

- Once configured and enabled, the broker starts or restores its resident without
  requiring Fleet to remain open. Repeated startup does not create extra residents.
- Uneventful startup and idle residence require no model turn. Real work, handoff,
  and recovery can consume inference; their cost is separately visible.
- The operator can use Strigoi as a regular Fleet Orc and call it Alfred in conversation.
- Planned context renewal preserves intent, rationale, uncertainty, pending work,
  and evidence. A successor can continue competently, not merely recite a summary.
- Abrupt failure recovers from committed state and original records. Uncertain
  effects are reconciled rather than blindly repeated or declared complete.
- Explicit suspension remains effective across restart. Failure, unavailable
  providers, and incomplete recovery are visible rather than disguised as readiness.

## Excluded from the initial release

Provider usage collection and Ammo integration; budget-aware provider routing;
automatic provider switching; continuous Fleet analysis; project discovery or
decomposition; automatic supervision or replacement of other Orcs; a new agent
hierarchy; a general knowledge-base product; remote/high-availability brokers.

Ordinary Orc tools remain available. These exclusions limit new product machinery,
not what the operator can ask a capable Orc to reason about using existing tools.

## What establishes success

Mechanical reliability and semantic continuity are separate acceptance dimensions.
Exercise startup, idle operation, planned succession, repeated succession, provider
failure, broker restart, and interrupted handoffs. Check that accepted inputs remain
accounted for, ownership is not duplicated, side effects are not blindly replayed,
and the operator can understand the resident's actual state.

Evaluate successors on their next useful action and the quality of their reasoning
about the ongoing work. A valid packet and a "ready" reply do not establish that.

See [ADR 0001](../adr/0001-strigoi-durable-fleet-orc.md) for the architectural
decision and [the design](../superpowers/specs/2026-11-14-strigoi-design.md) for
lifecycle, handoff, recovery, and acceptance contracts.
