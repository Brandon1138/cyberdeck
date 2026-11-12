import { prepared } from "./frame-cache.js";
import { projectRootFor, sectionPath } from "./list-groups.js";
import { threadRuntimePresence } from "./runtime-presence.js";
import type { FleetSnapshot, FleetThread } from "./state.js";

export const FLEET_ORCS_KEY = "/@fleet-orchestrators";
export const OTHER_WORKERS_KEY = "/@standalone-workers";
export const workerTreeKey = (id: string) => `/@session/${id}`;

export interface SessionNode {
  thread: FleetThread;
  children: SessionNode[];
  /** All descendants, once each, for disclosure counts and attention rollups. */
  members: FleetThread[];
}
export interface SessionGroup { key: string; label: string; nodes: SessionNode[] }

/** Only recorded native edges and current lease holders establish parentage. */
export function sessionTree(snapshot: FleetSnapshot): SessionGroup[] {
  return prepared([snapshot, "sessionTree"], () => {
    const nodes = new Map(snapshot.threads.map(thread => [thread.record.id, { thread, children: [], members: [] } as SessionNode]));
    const controllers = new Map(snapshot.threads.filter(t => t.record.kind === "orchestrator" && t.controllerId)
      .map(t => [t.controllerId!, t.record.id]));
    const parents = new Map<string, string>();
    for (const thread of snapshot.threads) {
      if (thread.record.kind === "orchestrator") continue;
      const native = thread.nativeAgent;
      const parent = native === undefined ? controllers.get(thread.coordination?.currentController?.controllerId ?? "")
        : nodes.has(native.parentThreadId) ? native.parentThreadId : native.rootSessionId;
      if (parent && parent !== thread.record.id && nodes.has(parent)) parents.set(thread.record.id, parent);
    }
    // Corrupt or incomplete edges must not strand a worker or recurse forever.
    for (const id of parents.keys()) {
      const seen = new Set([id]);
      let parent = parents.get(id);
      while (parent !== undefined) {
        if (seen.has(parent)) { parents.delete(id); break; }
        seen.add(parent); parent = parents.get(parent);
      }
    }
    const groups = new Map<string, SessionGroup>([[FLEET_ORCS_KEY, {
      key: FLEET_ORCS_KEY, label: "Unassigned / Fleet orchestrators", nodes: [],
    }]]);
    for (const root of snapshot.projects ?? []) groups.set(root, { key: root, label: root, nodes: [] });
    for (const [id, node] of nodes) {
      const parent = parents.get(id);
      if (parent !== undefined) { nodes.get(parent)!.children.push(node); continue; }
      const record = node.thread.record;
      const project = projectRootFor(sectionPath(node.thread), snapshot.projects ?? [])
        ?? projectRootFor(record.cwd, snapshot.projects ?? []);
      const key = record.kind === "orchestrator" && (record.orchestratorScope === "fleet" || project === undefined)
        ? FLEET_ORCS_KEY : project ?? OTHER_WORKERS_KEY;
      if (!groups.has(key)) groups.set(key, { key, label: "Standalone / Unattributed workers", nodes: [] });
      groups.get(key)!.nodes.push(node);
    }
    const ordered = (entries: SessionNode[]): void => {
      entries.sort((a, b) => Number(b.thread.record.kind === "orchestrator") - Number(a.thread.record.kind === "orchestrator")
        || Number(b.thread.record.pinned === true) - Number(a.thread.record.pinned === true)
        || (a.thread.record.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.thread.record.displayOrder ?? Number.MAX_SAFE_INTEGER)
        || a.thread.record.createdAt.localeCompare(b.thread.record.createdAt) || a.thread.record.id.localeCompare(b.thread.record.id));
      for (const node of entries) {
        ordered(node.children);
        node.members = [node.thread, ...node.children.flatMap(child => child.members)];
      }
    };
    for (const group of groups.values()) ordered(group.nodes);
    return [...groups.values()].sort((a, b) => a.key === FLEET_ORCS_KEY ? -1 : b.key === FLEET_ORCS_KEY ? 1
      : a.key === OTHER_WORKERS_KEY ? 1 : b.key === OTHER_WORKERS_KEY ? -1 : a.key.localeCompare(b.key));
  });
}

/** Activity observations do not establish process presence, but actionable work stays discoverable. */
export function hasCurrentActivity(thread: FleetThread): boolean {
  return threadRuntimePresence(thread) !== "absent" && thread.workerTruth?.terminal !== true
    && ["working", "starting", "blocked-modal", "blocked-composer", "stalled", "provider-limit", "errored", "failed"]
      .includes(thread.workerTruth?.state ?? "");
}

export function nodeDisposition(node: SessionNode): "current" | "unconfirmed" | "history" {
  if (node.members.some(t => threadRuntimePresence(t) === "present" || hasCurrentActivity(t))) return "current";
  return node.members.some(t => threadRuntimePresence(t) === "unknown") ? "unconfirmed" : "history";
}

export function activitySummary(threads: readonly FleetThread[]): string {
  const current = threads.filter(t => threadRuntimePresence(t) !== "absent" && t.workerTruth?.terminal !== true);
  const working = current.filter(t => t.workerTruth?.state === "working").length;
  const blocked = current.filter(t => ["blocked-modal", "blocked-composer", "stalled", "provider-limit", "errored", "failed"]
    .includes(t.workerTruth?.state ?? "")).length;
  return [working ? `${working} working` : "", blocked ? `${blocked} needs attention` : ""].filter(Boolean).join(" · ");
}
