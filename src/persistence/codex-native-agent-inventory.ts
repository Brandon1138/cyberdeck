import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { SessionRecord } from "../domain/session.js";
import type { FleetProjectionSnapshot } from "../domain/fleet-projection.js";
import { projectWorkerTruth } from "../domain/worker-truth.js";
import type { WorkerTruth } from "../domain/worker-truth.js";
import type { CodexConversationBindingStore } from "./codex-conversation-bindings.js";
import { NativeAgentActivity } from "./native-agent-activity.js";

type Thread = FleetProjectionSnapshot["threads"][number];
interface NativeRow {
  root: string; parent_thread_id: string; child_thread_id: string; status: string;
  source: string; agent_path: string; rollout_path: string; cwd: string;
  created_at: number; updated_at: number; model: string | null; reasoning_effort: string | null; archived: number;
}

/** Read-only discovery: an exact native edge never grants a broker lease or a process handle. */
export class CodexNativeAgentInventory {
  notice: string | undefined;
  private previous = new Map<string, Thread>();
  private readonly activity = new NativeAgentActivity();
  constructor(private readonly home: string, private readonly bindings: CodexConversationBindingStore) {}

  async list(sessions: readonly SessionRecord[]): Promise<Thread[]> {
    const owners = new Map<string, SessionRecord>();
    const represented = new Set<string>();
    for (const session of sessions.filter(record => record.provider === "codex")) {
      const binding = await this.bindings.read(session.id).catch(() => undefined);
      if (binding === undefined) continue;
      represented.add(binding.nativeSessionId);
      owners.set(binding.nativeSessionId, session);
    }
    if (owners.size === 0) return this.unavailable(sessions);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(this.home, "state_5.sqlite"), { readOnly: true, timeout: 100 });
      const roots = [...owners.keys()].slice(0, 500);
      const rows = db.prepare(`WITH RECURSIVE family(root,parent_thread_id,child_thread_id,status,depth) AS (
        SELECT parent_thread_id,parent_thread_id,child_thread_id,status,1 FROM thread_spawn_edges
          WHERE parent_thread_id IN (${roots.map(() => "?").join(",")})
        UNION ALL SELECT f.root,e.parent_thread_id,e.child_thread_id,e.status,f.depth+1
          FROM thread_spawn_edges e JOIN family f ON e.parent_thread_id=f.child_thread_id WHERE f.depth<8
      ) SELECT f.root,f.parent_thread_id,f.child_thread_id,f.status,t.source,t.agent_path,t.rollout_path,t.cwd,
        t.created_at,t.updated_at,t.model,t.reasoning_effort,t.archived FROM family f
        JOIN threads t ON t.id=f.child_thread_id ORDER BY t.archived,(f.status='closed'),t.updated_at DESC LIMIT 2001`).all(...roots) as unknown as NativeRow[];
      const incomplete = owners.size > roots.length || rows.length > 2000;
      const next = new Map<string, Thread>();
      for (const row of rows.slice(0, 2000)) {
        if (represented.has(row.child_thread_id) || next.has(row.child_thread_id)) continue;
        let source: { subagent?: { thread_spawn?: { parent_thread_id?: string; agent_path?: string } } };
        try { source = JSON.parse(row.source); } catch { continue; }
        const spawn = source.subagent?.thread_spawn;
        if (spawn?.parent_thread_id !== row.parent_thread_id || !row.agent_path || spawn.agent_path !== row.agent_path) continue;
        const parent = owners.get(row.root)!;
        const ended = row.status === "closed" || row.archived === 1;
        const observed = await this.activity.read(row.rollout_path, row.child_thread_id);
        const truth = projectWorkerTruth({ executionState: ended ? "exited" : "active", exitCode: ended ? 0 : null,
          activity: observed.activity, composer: { occupied: false, modalOpen: false }, completedTurns: observed.turns,
          canonicalTurns: observed.turns, pendingInstructions: 0 });
        const previous = this.previous.get(row.child_thread_id)?.workerTruth;
        if (truth.state !== "unknown") truth.lastConfirmed = { state: truth.state, at: observed.at ?? new Date(row.updated_at * 1000).toISOString() };
        else if (previous?.lastConfirmed !== undefined) {
          truth.lastConfirmed = previous.lastConfirmed;
          truth.detail = unavailableDetail(previous.lastConfirmed);
        }
        const name = row.agent_path.split("/").filter(Boolean).at(-1) ?? "Native worker";
        next.set(row.child_thread_id, {
          record: { id: row.child_thread_id, provider: "codex", kind: "worker", role: "worker", name,
            parentSessionId: owners.get(row.parent_thread_id)?.id ?? row.parent_thread_id,
            cwd: row.cwd, model: row.model ?? undefined, detached: true, sandbox: "read-only", pid: 0,
            createdAt: new Date(row.created_at * 1000).toISOString(), updatedAt: new Date(row.updated_at * 1000).toISOString(),
            executionState: ended ? "exited" : "active", exitCode: ended ? 0 : null, attachmentState: "watched", childIds: [] },
          workerTruth: truth, runtimePresence: ended ? "absent" : "unknown",
          nativeAgent: { threadId: row.child_thread_id, parentThreadId: row.parent_thread_id,
            parentName: parent.name ?? "Orchestrator", rootSessionId: parent.id,
            ...(parent.generation === undefined ? {} : { rootGeneration: parent.generation }) },
        });
      }
      const boundRoots = new Set([...owners.values()].map(record => record.id));
      for (const thread of this.unavailable(sessions)) {
        if (!next.has(thread.record.id) && (incomplete || !boundRoots.has(thread.nativeAgent!.rootSessionId))) next.set(thread.record.id, thread);
      }
      this.previous = next;
      this.notice = incomplete ? "Native worker discovery incomplete (bounded inventory); last discovered workers retained" : undefined;
      return [...next.values()];
    } catch {
      return this.unavailable(sessions);
    } finally { db?.close(); }
  }
  private unavailable(sessions: readonly SessionRecord[]): Thread[] {
    const roots = new Map(sessions.map(record => [record.id, record.generation]));
    const retained = [...this.previous.values()].filter(thread => roots.has(thread.nativeAgent!.rootSessionId)
      && roots.get(thread.nativeAgent!.rootSessionId) === thread.nativeAgent!.rootGeneration);
    this.notice = sessions.some(record => record.provider === "codex")
      ? `Native worker observation unavailable${retained.length === 0 ? "" : "; showing last discovered workers"}` : undefined;
    return retained.map(thread => ({ ...thread, runtimePresence: "unknown", workerTruth: { ...thread.workerTruth!, state: "unknown", terminal: false,
      detail: unavailableDetail(thread.workerTruth?.lastConfirmed) } }));
  }
}

function unavailableDetail(last: WorkerTruth["lastConfirmed"]): string {
  return `Native worker observation unavailable${last === undefined ? "" : `; last confirmed ${last.state} at ${last.at}`}`;
}

