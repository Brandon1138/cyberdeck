import { foldTransition, groupThreads, setCollapsed, setExpanded, setHistoryExpanded } from "./list-groups.js";
import { historyExpanded } from "./list-rows.js";
import { selectListView } from "./slash-commands.js";
import type { FleetSnapshot, FleetState, FleetTransition } from "./state.js";

/** Handle structural visit controls without arming an action on a previously selected thread. */
export function transitionVisitControls(state: FleetState, snapshot: FleetSnapshot, key: string): FleetTransition | undefined {
  if (state.focusedViewControl !== undefined && state.draft === "") {
    const views = ["live", "unread", "history"] as const;
    if (key === "left" || key === "right") {
      const index = views.indexOf(state.focusedViewControl);
      return { state: { ...state, focusedViewControl: views[Math.max(0, Math.min(2, index + (key === "left" ? -1 : 1)))] } };
    }
    if (key === "enter") return { state: selectListView(state, snapshot, state.focusedViewControl) };
  }
  if (state.focusedHistoryCwd !== undefined && state.draft === "" && (key === "left" || key === "right" || key === "enter")) {
    const cwd = state.focusedHistoryCwd;
    return foldTransition(state, setHistoryExpanded(state, cwd,
      key === "enter" ? !historyExpanded(state, cwd) : key === "right"), cwd);
  }
  if (state.focusedUpdateSessionId !== undefined && state.draft === "" && (key === "enter" || key === "right")) {
    const target = snapshot.threads.find(({ record }) => record.id === state.focusedUpdateSessionId);
    if (target === undefined) return { state };
    const cwd = target.record.kind === "orchestrator" ? "/@orcs"
      : groupThreads(snapshot).find(({ threads }) => threads.includes(target))?.cwd;
    let next: FleetState = { ...state, listView: "live", selectedSessionId: target.record.id,
      focusedUpdateSessionId: undefined, focusedFolderCwd: undefined, focusedHistoryCwd: undefined,
      focusedShowMoreCwd: undefined, focusedViewControl: undefined, notice: undefined };
    if (cwd !== undefined) next = setExpanded(setHistoryExpanded(setCollapsed(next, cwd, false), cwd, true), cwd, true);
    return { state: next };
  }
  return undefined;
}
