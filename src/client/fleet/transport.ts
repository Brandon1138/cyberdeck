import type { FleetOrchestratorOwnershipView, FleetWorkerCoordinationView, } from "../../broker/worker-coordination-view.js";
import type { SessionRecord } from "../../domain/session.js";
import { DEFAULT_PERMISSION_POLICIES, UNQUERIED_WORKER_MODELS } from "./constants.js";
import { orderedThreads } from "./list-rows.js";
import { FleetSnapshot, FleetState, FleetThread, FleetTransport, StartFleetAction, ThreadStatus } from "./state.js";

export async function collectFleetSnapshot(client: FleetTransport): Promise<FleetSnapshot> {
  const sessions = await client.request<SessionRecord[]>("session.list", {});
  const coordination = await client.request<FleetWorkerCoordinationView[]>(
    "fleet.workerCoordination",
    {},
  ).catch(() => []);
  const coordinationBySession = new Map(
    coordination.map((entry) => [entry.sessionId, entry] as const),
  );
  // An orc's controller identity comes from its binding, which the coordination projection does
  // not carry. A broker too old to answer leaves every orc sigil-less rather than failing the
  // snapshot: no sigils at all is a legible fleet, half of them is not.
  const orchestratorOwnership = new Map(
    (await client.request<FleetOrchestratorOwnershipView[]>("fleet.orchestratorOwnership", {})
      .catch(() => []))
      .map((entry) => [entry.sessionId, entry] as const),
  );
  // Undefined rather than empty when the broker has no registry: an empty list is an answer, and
  // grouping every thread under "Unregistered" is the wrong answer to a question nobody asked.
  const projects = await client.request<string[]>("fleet.projects", {})
    .then((roots) => roots as readonly string[] | undefined, () => undefined);
  const threads = sessions.map((record): FleetThread => {
    const workerCoordination = coordinationBySession.get(record.id);
    const ownership = orchestratorOwnership.get(record.id);
    return {
      record,
      ...(workerCoordination === undefined ? {} : { coordination: workerCoordination }),
      ...(ownership === undefined ? {} : { controllerId: ownership.controllerId }),
      ...(ownership?.createdBy === undefined ? {} : { createdBy: ownership.createdBy }),
    };
  });
  return {
    threads,
    ...(projects === undefined ? {} : { projects }),
  };
}

export function createFleetState(snapshot: FleetSnapshot, fallbackCwd = process.cwd()): FleetState {
  return {
    selectedSessionId: orderedThreads(snapshot)[0]?.record.id,
    threadListScrollOffset: 0,
    fallbackCwd,
    draft: "",
    launchProfiles: {},
    workerModels: UNQUERIED_WORKER_MODELS,
    permissionPolicies: { ...DEFAULT_PERMISSION_POLICIES },
    nvimLayoutEnabled: true,
    view: "fleet",
  };
}

export function threadStatus(thread: FleetThread): ThreadStatus {
  if (thread.workerTruth !== undefined) {
    // Scout completion is a separately verified structured outcome, never inferred from idle
    // or process exit. Current fault/stop/uncertainty still wins over an old successful report.
    if ((thread.workerTruth.state === "idle" || thread.workerTruth.state === "exited")
      && thread.workerTruth.taskOutcome === "succeeded") return "Done";
    return TRUTH_STATUS[thread.workerTruth.state] ?? "Unknown";
  }
  // Legacy records describe process lifecycle, not current provider activity. Persisted turn
  // attention can survive a restart and cannot prove current work, readiness, or task success.
  if (thread.record.termination !== undefined) {
    return thread.record.termination.kind === "provider-fault" ? "Failed" : "Provider limit";
  }
  switch (thread.record.executionState) {
    case "starting": return "Starting";
    case "exited": return thread.record.attentionState === "stopped" ? "Stopped"
      : verifiedScoutOutcome(thread.record) ? "Done" : "Exited";
    case "failed": return "Failed";
    // A session that died inside a live process. It reads as Failed rather than as whatever its
    // last terminal frame happened to look like, so nobody is invited to type at it.
    case "errored": return "Failed";
    case "cancelled": return thread.record.attentionState === "interrupted" ? "Interrupted"
      : thread.record.exitCode === null ? "Stopping" : "Stopped";
    case "active": {
      const attention = thread.record.attentionState;
      if (attention === "stopping") return "Stopping";
      if (attention === "stopped") return "Stopped";
      if (attention === "interrupted") return "Interrupted";
      if (attention === "failed") return "Failed";
      return "Unknown";
    }
  }
}

/** These flags are set by the broker after validating the Scout decision card and canary. */
function verifiedScoutOutcome(record: SessionRecord): boolean {
  return record.scout?.terminalState === "complete"
    && record.scout.reportState === "complete"
    && record.scout.canary.status === "verified";
}

/** Presentation vocabulary only: the broker owns all evidence and state decisions. */
const TRUTH_STATUS: Readonly<Record<string, ThreadStatus>> = {
  starting: "Starting",
  working: "Working",
  "blocked-modal": "Needs input",
  "blocked-composer": "Needs input",
  idle: "Idle",
  stalled: "Stalled",
  "provider-limit": "Provider limit",
  errored: "Failed",
  failed: "Failed",
  stopping: "Stopping",
  stopped: "Stopped",
  interrupted: "Interrupted",
  exited: "Exited",
  unknown: "Unknown",
};

export async function startFleetSession(
  client: FleetTransport,
  action: StartFleetAction,
): Promise<SessionRecord> {
  if (action.permissionLaunch?.application.kind !== "post-launch-command") {
    return client.request<SessionRecord>("session.startWithPrompt", action.request);
  }
  return client.request<SessionRecord>("session.startWithPrompt", {
    ...action.request,
    approvalMode: "auto",
  });
}
