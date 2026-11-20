import type { FleetSnapshot, FleetState } from "./state.js";
import type { FleetListRow, FleetTreeRow } from "./list-rows.js";
import { sessionTree, workerTreeKey, visibleInLive, activitySummary, type SessionNode } from "./session-tree.js";
import { threadRuntimePresence } from "./runtime-presence.js";
import { isUnreadThread } from "./visit-state.js";
import { pendingLifecycleThreads } from "./lifecycle-state.js";
import { leaseCustody, leaseCustodyBadge } from "../lease-custody.js";
import { sectionPath } from "./list-groups.js";
import type { FleetThread } from "./state.js";

/** One hierarchy across views; no provider I/O or inference of task success. */
export function currentSessionRows(snapshot: FleetSnapshot, state: FleetState): FleetListRow[] {
  const rows: FleetListRow[] = [{ kind: "views" }];
  const view = state.listView ?? "live";
  const filter = state.projectFilter?.replace(/\/$/u, "");
  if (filter) rows.push({ kind: "section", label: `Project: ${filter} · /filter all to clear` });
  if (view !== "live" && snapshot.nativeAgentNotice) rows.push({ kind: "section", label: snapshot.nativeAgentNotice });
  const inScope = (thread: FleetThread): boolean => !filter || thread.record.id === state.revealedHistorySessionId
    || [thread.record.cwd, sectionPath(thread)].some(path => path === filter || path.startsWith(`${filter}/`));
  // Ownership can cross projects. Keep only matching descendants and their structural ancestors.
  const scopedNode = (node: SessionNode): SessionNode[] => {
    if (!filter) return [node];
    const children = node.children.flatMap(scopedNode);
    return !inScope(node.thread) && !children.length ? []
      : [{ thread: node.thread, children, members: [node.thread, ...children.flatMap(child => child.members)] }];
  };
  const forced = (node: SessionNode): boolean => node.members.some(t => t.record.id === state.revealedHistorySessionId);
  const matches = (node: SessionNode): boolean => forced(node) || node.members.some(t => inScope(t) && (
    view === "history" ? threadRuntimePresence(t) === "absent"
      : view === "unread" ? isUnreadThread(state, t.record.id)
      : true));
  const open = (key: string) => !state.collapsedCwds?.includes(key);
  const emitNodes = (nodes: SessionNode[], depth: number, parentKey: string, ancestors: string[]): void => {
    for (const node of nodes.filter(matches)) {
      const key = workerTreeKey(node.thread.record.id);
      const children = node.children.filter(matches);
      const collapsed = !open(key);
      const tree: FleetTreeRow = { depth, parentKey, ancestors };
      if (children.length) {
        tree.key = key;
        tree.collapsed = collapsed;
        if (view !== "live") {
          const descendants = node.members.slice(1).filter(inScope);
          const activity = activitySummary(descendants);
          tree.summary = [activity, `${descendants.length} worker${descendants.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
        }
      }
      const custody = node.thread.coordination === undefined ? undefined : leaseCustodyBadge(leaseCustody(node.thread.coordination));
      rows.push({ kind: "thread", cwd: node.thread.record.cwd, thread: node.thread, tree,
        ...(custody === undefined ? {} : { leaseBadge: custody }) });
      if (tree.summary) rows.push({ kind: "section", label: `${"  ".repeat(Math.min(depth + 1, 4))}${tree.summary}` });
      if (!collapsed) emitNodes(children, depth + 1, key, [...ancestors, key]);
    }
  };
  for (const group of sessionTree(snapshot, view === "live")) {
    const nodes = group.nodes.flatMap(scopedNode).filter(matches);
    if (!nodes.length) continue;
    const members = nodes.flatMap(n => n.members).filter(inScope);
    const collapsed = !open(group.key);
    if (view === "live") {
      rows.push({ kind: "folder", cwd: group.key, label: group.label, threadCount: members.length, collapsed,
        tree: { depth: 0, ancestors: [] } });
      if (!collapsed) emitNodes(nodes, 1, group.key, [group.key]);
      continue;
    }
    const activity = activitySummary(members);
    const notices = pendingLifecycleThreads(members, state);
    const orcs = members.filter(t => t.record.kind === "orchestrator").length;
    const counts = [orcs ? `${orcs} Orc${orcs === 1 ? "" : "s"}` : "", members.length > orcs ? `${members.length - orcs} worker${members.length - orcs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    rows.push({ kind: "folder", cwd: group.key, label: group.label, threadCount: members.length, collapsed,
      tree: { depth: 0, ancestors: [], summary: counts } });
    const unread = members.filter(t => isUnreadThread(state, t.record.id)).length;
    const attention = [activity, notices.length ? `${notices.length} notices` : "", unread ? `${unread} unread` : ""].filter(Boolean).join(" · ");
    if (attention) rows.push({ kind: "section", label: `  ${attention}` });
    if (collapsed) continue;
    emitNodes(nodes, 1, group.key, [group.key]);
    if (notices.length && view !== "unread") {
      const expanded = state.expandedLifecycleCwds?.includes(group.key) === true;
      rows.push({ kind: "lifecycle", cwd: group.key, threads: notices, expanded });
      if (expanded) rows.push(...notices.map(thread => ({ kind: "lifecycle-item" as const, cwd: group.key, thread })));
    }
  }
  if (!rows.some(row => row.kind === "thread" || row.kind === "folder")) rows.push({ kind: "section", label:
    view === "unread" ? "No unread assistant replies." : "No sessions in this scope." });
  return rows;
}

/** Reveal exactly one target and its ancestors without expanding unrelated history. */
export function revealCurrentSession(state: FleetState, snapshot: FleetSnapshot, id: string): FleetState {
  const target = snapshot.threads.find(t => t.record.id === id);
  if (!target) return state;
  let next: FleetState = { ...state, listView: !visibleInLive(target) && (state.listView ?? "live") === "live" ? "history" : state.listView, revealedHistorySessionId: id };
  // A fully opened projection gives the real path, including nested native parents.
  const probe = { ...next, collapsedCwds: [],
    openFolderCwds: sessionTree(snapshot).map(group => group.key) };
  const row = currentSessionRows(snapshot, probe).find(row => row.kind === "thread" && row.thread.record.id === id);
  if (row?.kind === "thread" && row.tree) next = { ...next,
    collapsedCwds: state.collapsedCwds?.filter(key => !row.tree!.ancestors.includes(key)),
    openFolderCwds: [...new Set([...(state.openFolderCwds ?? []), ...row.tree.ancestors])] };
  return next;
}
