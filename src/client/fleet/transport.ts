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
      .map((entry) => [entry.sessionId, entry.controllerId] as const),
  );
  // Undefined rather than empty when the broker has no registry: an empty list is an answer, and
  // grouping every thread under "Unregistered" is the wrong answer to a question nobody asked.
  const projects = await client.request<string[]>("fleet.projects", {})
    .then((roots) => roots as readonly string[] | undefined, () => undefined);
  const threads = sessions.map((record): FleetThread => {
    const workerCoordination = coordinationBySession.get(record.id);
    const controllerId = orchestratorOwnership.get(record.id);
    return {
      record,
      ...(workerCoordination === undefined ? {} : { coordination: workerCoordination }),
      ...(controllerId === undefined ? {} : { controllerId }),
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
  const persisted = thread.record.attentionState;
  if (persisted !== undefined) {
    return ({
      working: "Working",
      "needs-input": "Needs input",
      done: "Done",
      stopping: "Stopping",
      stopped: "Stopped",
      interrupted: "Interrupted",
      failed: "Failed",
    } as const)[persisted];
  }
  switch (thread.record.executionState) {
    case "starting": return "Working";
    case "exited": return "Done";
    case "failed": return "Failed";
    // A session that died inside a live process. It reads as Failed rather than as whatever its
    // last terminal frame happened to look like, so nobody is invited to type at it.
    case "errored": return "Failed";
    case "cancelled": return thread.record.exitCode === null ? "Stopping" : "Stopped";
    // The broker stamps attentionState at start and maintains it as output arrives, so an active
    // record without one is a record the broker has not classified yet. "Working" is the answer
    // that invites patience rather than input at a thread nothing has vouched for.
    case "active": return "Working";
  }
}

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

