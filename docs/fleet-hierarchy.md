# Fleet hierarchy and activity

Live groups Unassigned / Fleet orchestrators above registered projects. A Fleet-scoped Orc stays at the top even when its working directory belongs to a project. Workspace Orcs are grouped by registered repository root (including declared sibling worktrees). Unregistered Orcs remain in the top group. This presentation does not grant or change cross-project authority or peer-creation permissions.

Native workers follow their recorded parent edges. Broker-managed workers follow their current lease controller, including after a handoff; a former creator is not treated as the current owner. Workers without a represented owner remain discoverable under their project or Standalone / Unattributed workers. An ended parent does not imply its children ended.

- Left/right folds a group or a parent with children. Left on a leaf goes to its parent.
- Enter opens a broker-managed session, toggles a group, or inspects an observed native worker. Native controls remain with the parent.
- Folds persist through the existing folder-disposition store. New tree groups use distinct keys from the legacy Orc roster.
- `/view workers` lists workers independently of Orc folds. `/filter <project root>` narrows the tree; `/filter all` clears it.
- Confirmed-ended sessions are disclosed under History. Runtime-unconfirmed sessions are folded separately, without inferring that an old record is dead. Observed working/blocked descendants remain in the current tree.
- Group rollups retain working, attention, lifecycle notice and unread counts when folded. Traversing or folding does not mark replies read.

Header counts distinguish live Orcs, live managed workers, discovered native workers and unconfirmed runtime presence. Native discovery is not a process-liveness claim. Narrow rows prioritize role, task and status; selected detail retains model, owner, path and last confirmed observation.

## False-stall regression

Previously, once a native activity version was known, the engine stopped counting terminal progress. Visible response/tool output could therefore continue while Fleet reported Stalled. Codex's first instructed turn also lacked periodic native polling until its first canonical completion, leaving its quiet-time reader vulnerable to continuous repainting.

The engine now polls native activity from the first turn while retaining exact launch attribution and generation fences. It also combines native transcript movement with changes in the rendered Codex response/tool body. Spinner/elapsed-time/footer/composer changes alone do not reset the stall timer. This changes activity observation, not completion or task-success evidence. A genuinely quiet in-flight turn can still become Stalled.

## Reproducible preview

With the locked dependencies and Node 24.18.0:

```sh
node --import tsx scripts/render-fleet-hierarchy.ts
```

This writes 20 bounded plain-text frames and a validation manifest to `.local/fleet-hierarchy`, using 54 unconfirmed workers, 80 retired Orcs, nested native workers, a managed worker needing input, a project Orc and a Fleet Orc. It does not connect to a broker, start a provider or touch tmux. Source/test/fixture validation is separate from activating a rebuilt Fleet or broker in a live session.
