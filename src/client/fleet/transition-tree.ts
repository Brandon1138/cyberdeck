import { fleetListRows, focusedListRowIndex } from "./list-rows.js";
import { focusRow, foldTransition, setCollapsed } from "./list-groups.js";
import type { FleetSnapshot, FleetState, FleetTransition } from "./state.js";

/** Tree gestures never attach a provider or mutate a native worker. Enter remains open/inspect. */
export function transitionTreeControls(state: FleetState, snapshot: FleetSnapshot, key: string): FleetTransition | undefined {
  if (state.draft !== "" || key !== "left" && key !== "right") return;
  const rows = fleetListRows(snapshot, state);
  const row = rows[focusedListRowIndex(rows, state)];
  if (row?.kind !== "folder" && row?.kind !== "thread" || !row.tree) return;
  const foldKey = row.kind === "folder" ? row.cwd : row.tree.key;
  const collapsed = row.kind === "folder" ? row.collapsed : row.tree.collapsed;
  if (foldKey && (key === "right" || !collapsed)) {
    return foldTransition(state, setCollapsed(state, foldKey, key === "left"), foldKey);
  }
  if (key === "left" && row.tree.parentKey) {
    const parent = rows.find(candidate => candidate.kind === "folder" ? candidate.cwd === row.tree!.parentKey
      : candidate.kind === "thread" && candidate.tree?.key === row.tree!.parentKey);
    return { state: { ...focusRow(state, parent), notice: undefined } };
  }
}
