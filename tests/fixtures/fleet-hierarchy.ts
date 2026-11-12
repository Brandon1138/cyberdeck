import type { FleetSnapshot, FleetThread } from "../../src/client/fleet.js";
import { projectWorkerTruth, type WorkerTruthState } from "../../src/domain/worker-truth.js";
export const TREE_NOW = "2026-11-12T16:00:00.000Z";
export function treeThread(id: string, state: WorkerTruthState = "idle", options: {
  kind?: "worker" | "orchestrator"; cwd?: string; nativeParent?: string; root?: string; controller?: string;
} = {}): FleetThread {
  const native = options.nativeParent !== undefined;
  const ended = ["exited", "stopped", "interrupted", "failed"].includes(state);
  const truth = { ...projectWorkerTruth({ executionState: ended ? "exited" : "active", exitCode: ended ? 0 : null,
    activity: state === "working" ? "working" : state === "idle" ? "awaiting-input" : "unknown",
    composer: { occupied: false, modalOpen: state === "blocked-modal" }, completedTurns: 0, canonicalTurns: 0, pendingInstructions: 0 }), state };
  return { record: { id, name: id, provider: "codex", kind: options.kind ?? "worker", cwd: options.cwd ?? "/projects/parking",
    model: "gpt-6-astra", effort: "high", sandbox: "workspace-write", detached: true,
    createdAt: TREE_NOW, updatedAt: TREE_NOW, executionState: ended ? "exited" : "active", attachmentState: "detached",
    pid: native ? 0 : 42, exitCode: ended ? 0 : null, childIds: [] }, workerTruth: truth,
    runtimePresence: ended ? "absent" : native || state === "unknown" ? "unknown" : "present",
    ...(options.controller ? { controllerId: options.controller } : {}),
    ...(native ? { nativeAgent: { threadId: id, parentThreadId: options.nativeParent!, parentName: options.nativeParent!,
      rootSessionId: options.root ?? options.nativeParent! } } : {}) };
}
export function hierarchyFixture(): FleetSnapshot {
  const executive = treeThread("Executive", "idle", { kind: "orchestrator", cwd: "/Users/operator" });
  executive.record.orchestratorScope = "fleet";
  const project = treeThread("Parking Orc", "working", { kind: "orchestrator", controller: "parking-controller" });
  const managed = treeThread("Browser verification", "blocked-modal");
  managed.coordination = { sessionId: managed.record.id, subjectId: "browser", origin: {
    creatorControllerId: "old-controller", creatorSessionId: "old-orc", taskId: "task", threadId: "browser", createdAt: TREE_NOW },
    currentController: { controllerId: "parking-controller", familyId: "parking", scope: "workspace" },
    leaseHealth: "active", orphaned: false, adoptable: false };
  return { currentLayout: "sessions", projects: ["/projects/parking", "/projects/cyberdeck"], threads: [
    executive, project, managed,
    treeThread("Implement presence", "working", { nativeParent: project.record.id }),
    treeThread("Nested review", "working", { nativeParent: "Implement presence", root: project.record.id }),
    ...Array.from({ length: 54 }, (_, i) => treeThread(`old-native-${i}`, "unknown", { nativeParent: project.record.id })),
    ...Array.from({ length: 80 }, (_, i) => treeThread(`retired-orc-${i}`, "exited", { kind: "orchestrator", cwd: "/Users/operator" })),
    treeThread("Standalone", "idle", { cwd: "/projects/cyberdeck" }),
  ] };
}
