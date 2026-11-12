import type { FleetSnapshot, FleetState } from "./state.js";
import type { FleetListRow, FleetTreeRow } from "./list-rows.js";
import { sessionTree, workerTreeKey, nodeDisposition, activitySummary, type SessionNode } from "./session-tree.js";
import { threadRuntimePresence } from "./runtime-presence.js";
import { isUnreadThread } from "./visit-state.js";
import { pendingLifecycleThreads } from "./lifecycle-state.js";
import { leaseCustody, leaseCustodyBadge } from "../lease-custody.js";

/** One hierarchy across views; no provider I/O or inference of task success. */
export function currentSessionRows(snapshot: FleetSnapshot, state: FleetState): FleetListRow[] {
  const rows: FleetListRow[] = [{ kind: "views" }];
  const view = state.listView ?? "live";
  const filter = state.projectFilter?.replace(/\/$/u, "");
  if (filter) rows.push({ kind: "section", label: `Project: ${filter} · /filter all to clear` });
  if (snapshot.nativeAgentNotice) rows.push({ kind: "section", label: snapshot.nativeAgentNotice });
  const forced = (node: SessionNode): boolean => node.members.some(t => t.record.id === state.revealedHistorySessionId);
  const matches = (node: SessionNode): boolean => forced(node) || node.members.some(t =>
    view === "history" ? threadRuntimePresence(t) === "absent"
      : view === "unread" ? isUnreadThread(state, t.record.id)
      : view === "workers" ? t.record.kind !== "orchestrator" : true);
  const open = (key: string, defaultClosed = false) => !state.collapsedCwds?.includes(key)
    && (!defaultClosed || state.openFolderCwds?.includes(key) === true);
  const emitNodes = (nodes: SessionNode[], depth: number, parentKey: string, ancestors: string[], partition = true): void => {
    const visible = nodes.filter(matches);
    const emit = (node: SessionNode, at: number, parent: string, path: string[]) => {
      const key = workerTreeKey(node.thread.record.id);
      const children = node.children.filter(matches);
      const collapsed = !open(key);
      const activity = activitySummary(node.members.slice(1));
      const tree: FleetTreeRow = { depth: at, parentKey: parent, ancestors: path,
        ...(children.length ? { key, collapsed, summary: `${activity ? `${activity} · ` : ""}${node.members.length - 1} worker${node.members.length === 2 ? "" : "s"}` } : {}) };
      const custody = node.thread.coordination === undefined ? undefined : leaseCustodyBadge(leaseCustody(node.thread.coordination));
      rows.push({ kind: "thread", cwd: node.thread.record.cwd, thread: node.thread, tree,
        ...(custody === undefined ? {} : { leaseBadge: custody }) });
      if (children.length) rows.push({ kind: "section", label: `${"  ".repeat(Math.min(at + 1, 4))}${tree.summary}` });
      if (!collapsed) emitNodes(children, at + 1, key, [...path, key]);
    };
    if (view === "history" || view === "unread" || !partition) {
      for (const node of visible) emit(node, depth, parentKey, ancestors);
      return;
    }
    for (const node of visible.filter(n => nodeDisposition(n) === "current" || forced(n))) emit(node, depth, parentKey, ancestors);
    for (const disposition of ["unconfirmed", "history"] as const) {
      const hidden = visible.filter(n => nodeDisposition(n) === disposition && !forced(n));
      if (!hidden.length) continue;
      const key = `/@tree-bucket/${encodeURIComponent(parentKey)}/${disposition}`;
      const members = hidden.flatMap(n => n.members);
      const collapsed = !open(key, true);
      rows.push({ kind: "folder", cwd: key, label: disposition === "history" ? "History"
        : members.every(t => t.record.kind !== "orchestrator") ? "Unconfirmed workers" : "Unconfirmed sessions",
        threadCount: members.length, collapsed, tree: { depth, parentKey, ancestors, summary: `${members.length}` } });
      if (!collapsed) emitNodes(hidden, depth + 1, key, [...ancestors, key], false);
    }
  };
  for (const group of sessionTree(snapshot)) {
    const nodes = group.nodes.filter(node => matches(node) && (!filter || group.key === filter || forced(node)
      || node.members.some(t => t.record.cwd === filter || t.record.cwd.startsWith(`${filter}/`)
        || t.record.workspace?.repositoryPath === filter)));
    const emptyProject = group.nodes.length === 0 && snapshot.projects?.includes(group.key)
      && (!filter || group.key === filter) && (view === "live" || view === "workers");
    if (!nodes.length && !emptyProject) continue;
    const members = nodes.flatMap(n => n.members);
    const collapsed = !open(group.key, view === "live" && nodes.every(n => nodeDisposition(n) !== "current" && !forced(n)));
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
    if (view === "workers") {
      // Deliberately flatten this view: it is the direct escape from any collapsed Orc tree.
      const workers = members.filter(t => t.record.kind !== "orchestrator");
      emitNodes(workers.map(thread => ({ thread, children: [], members: [thread] })), 1, group.key, [group.key]);
    } else emitNodes(nodes, 1, group.key, [group.key]);
    if (notices.length && view !== "unread") {
      const expanded = state.expandedLifecycleCwds?.includes(group.key) === true;
      rows.push({ kind: "lifecycle", cwd: group.key, threads: notices, expanded });
      if (expanded) rows.push(...notices.map(thread => ({ kind: "lifecycle-item" as const, cwd: group.key, thread })));
    }
  }
  if (!rows.some(row => row.kind === "thread" || row.kind === "folder")) rows.push({ kind: "section", label:
    view === "workers" ? "No workers in this scope." : view === "unread" ? "No unread assistant replies." : "No sessions in this scope." });
  return rows;
}

/** Reveal exactly one target and its ancestors without expanding unrelated history. */
export function revealCurrentSession(state: FleetState, snapshot: FleetSnapshot, id: string): FleetState {
  if (!snapshot.threads.some(t => t.record.id === id)) return state;
  let next: FleetState = { ...state, revealedHistorySessionId: id };
  // A fully opened projection gives the real path, including nested native parents.
  const probe = { ...next, listView: "live" as const, collapsedCwds: [],
    openFolderCwds: sessionTree(snapshot).map(group => group.key) };
  const row = currentSessionRows(snapshot, probe).find(row => row.kind === "thread" && row.thread.record.id === id);
  if (row?.kind === "thread" && row.tree) next = { ...next,
    collapsedCwds: state.collapsedCwds?.filter(key => !row.tree!.ancestors.includes(key)),
    openFolderCwds: [...new Set([...(state.openFolderCwds ?? []), ...row.tree.ancestors])] };
  return next;
}
