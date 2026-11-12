import { foldTransition, groupThreads, setCollapsed, setExpanded, setHistoryExpanded } from "./list-groups.js";
import { historyExpanded } from "./list-rows.js";
import { selectListView } from "./slash-commands.js";
import type { FleetSnapshot, FleetState, FleetTransition } from "./state.js";
import { revealCurrentSession } from "./current-sessions.js";
import { threadRuntimePresence } from "./runtime-presence.js";

/** Inspect a durable conversation without attaching, resuming, reading or revealing its siblings. */
export function revealFleetThread(state: FleetState, snapshot: FleetSnapshot, sessionId: string): FleetState {
  const target = snapshot.threads.find(({ record }) => record.id === sessionId);
  if (target === undefined) return state;
  const cwd = target.record.kind === "orchestrator" ? "/@orcs"
    : groupThreads(snapshot).find(({ threads }) => threads.includes(target))?.cwd;
  const notice = state.lifecycleWatermarks?.[sessionId]?.notice;
  let next: FleetState = { ...state, listView: "live", selectedSessionId: sessionId,
    focusedUpdateSessionId: undefined, focusedFolderCwd: undefined, focusedHistoryCwd: undefined,
    focusedShowMoreCwd: undefined, focusedViewControl: undefined, focusedLifecycleCwd: undefined,
    focusedLifecycleSessionId: undefined, focusedUnconfirmedCwd: undefined,
    focusedLifecycleOccurrences: notice === undefined ? undefined : { [sessionId]: notice.generation },
    revealedHistorySessionId: threadRuntimePresence(target) === "absent" ? sessionId : undefined, notice: undefined };
  if (cwd !== undefined) {
    next = setCollapsed(next, cwd, false);
    if (threadRuntimePresence(target) === "unknown") next = { ...next,
      expandedUnconfirmedCwds: [...new Set([...(next.expandedUnconfirmedCwds ?? []), cwd])] };
  }
  return snapshot.currentLayout === "sessions" ? revealCurrentSession(next, snapshot, sessionId) : next;
}

/** Handle structural visit controls without arming an action on a previously selected thread. */
export function transitionVisitControls(state: FleetState, snapshot: FleetSnapshot, key: string): FleetTransition | undefined {
  if (state.draft === "" && ["left", "right", "enter"].includes(key)) {
    const cwd = state.focusedLifecycleCwd ?? state.focusedUnconfirmedCwd;
    if (cwd !== undefined) {
      const field = state.focusedLifecycleCwd !== undefined ? "expandedLifecycleCwds" : "expandedUnconfirmedCwds";
      const expanded = state[field] ?? [];
      const open = key === "enter" ? !expanded.includes(cwd) : key === "right";
      return { state: { ...state, [field]: open ? [...new Set([...expanded, cwd])] : expanded.filter((key) => key !== cwd) } };
    }
    if (state.focusedLifecycleSessionId !== undefined && key !== "left") {
      return { state: revealFleetThread(state, snapshot, state.focusedLifecycleSessionId) };
    }
  }
  if (state.focusedViewControl !== undefined && state.draft === "") {
    const views = ["live", "workers", "unread", "history"] as const;
    if (key === "left" || key === "right") {
      const index = views.indexOf(state.focusedViewControl);
      return { state: { ...state, focusedViewControl: views[Math.max(0, Math.min(views.length - 1, index + (key === "left" ? -1 : 1)))] } };
    }
    if (key === "enter") return { state: selectListView(state, snapshot, state.focusedViewControl) };
  }
  if (state.focusedHistoryCwd !== undefined && state.draft === "" && (key === "left" || key === "right" || key === "enter")) {
    const cwd = state.focusedHistoryCwd;
    return foldTransition(state, setHistoryExpanded(state, cwd,
      key === "enter" ? !historyExpanded(state, cwd) : key === "right"), cwd);
  }
  if (state.focusedUpdateSessionId !== undefined && state.draft === "" && (key === "enter" || key === "right")) {
    return { state: revealFleetThread(state, snapshot, state.focusedUpdateSessionId) };
  }
  return undefined;
}
