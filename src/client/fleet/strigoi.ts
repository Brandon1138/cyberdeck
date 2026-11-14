import type { ExecuteFleetActionContext } from "./runtime-actions.js";
import type { StrigoiInspection } from "../../orchestration/strigoi-ports.js";
import { strigoiFleetView } from "../../domain/strigoi-view.js";
import { collectFleetSnapshot } from "./transport.js";
import { revealCurrentSession } from "./current-sessions.js";
import { randomUUID } from "node:crypto";
import type { FleetSnapshot, FleetState, FleetTransition } from "./state.js";
import type { StrigoiFleetView } from "../../domain/strigoi.js";
import { threadFocusInert } from "./list-rows.js";
export function strigoiStatus(view: StrigoiFleetView): string {
  return `Strigoi #${view.incarnation ?? "?"} · ${view.desired} · ${view.readiness} · adoption ${view.adoption}`
    + (view.hold ? ` · HOLD ${view.hold.code}: ${view.hold.detail} [${view.hold.sourceIds.join(", ")}]` : "")
    + view.continuationHolds.map(h => ` · Continuation ${h.code}: ${h.detail} [${h.sourceIds.join(", ")}]`).join("");
}
export function strigoiTransition(state: FleetState, snapshot: FleetSnapshot, command: string): FleetTransition | undefined {
  if (/^\/strigoi(?:\s|$)/u.test(command)) {
    const match = /^\/strigoi(?:\s+(status|renew|suspend|resume))?$/u.exec(command);
    if (!match) return { state: { ...state, draft: "", notice: "Usage: /strigoi [status|renew|suspend|resume]", noticeTone: "error" } };
    return { state: { ...state, draft: "", notice: undefined }, action: { type: "strigoi", operation: (match[1] ?? "status") as "status" | "renew" | "suspend" | "resume", mutationId: randomUUID() } };
  }
  const thread = threadFocusInert(state) ? undefined : snapshot.threads.find(t => t.record.id === state.selectedSessionId);
  if (thread?.strigoi?.canonical && command && !command.startsWith("/")) {
    const retry = state.strigoiDraft;
    return { state: { ...state, draft: "", strigoiDraft: undefined, notice: undefined }, action: { type: "strigoi-submit", message: command,
      messageId: retry?.message === command ? retry.messageId : randomUUID() } };
  }
  return undefined;
}

export async function executeStrigoiAction(context: ExecuteFleetActionContext) {
  const { action, client } = context;
  let state = context.state;
  if (action?.type === "strigoi-submit") {
    await client.request("strigoi.submit", { message: action.message, messageId: action.messageId });
    state = { ...state, notice: "Message accepted for Strigoi", noticeTone: "neutral" };
  } else if (action?.type === "strigoi") {
    let inspection = await client.request<StrigoiInspection>("strigoi.inspect", {});
    if (action.operation === "renew") {
      await client.request("strigoi.renew", { expectedIncarnation: inspection.state.incarnation, reason: "operator-request", mutationId: action.mutationId });
      inspection = await client.request<StrigoiInspection>("strigoi.inspect", {});
    } else if (action.operation !== "status") inspection = await client.request<StrigoiInspection>(`strigoi.${action.operation}`, { mutationId: action.mutationId });
    const id = inspection.state.activeBinding?.sessionId;
    const view = id ? strigoiFleetView(inspection, id) : undefined;
    state = { ...state, notice: view ? strigoiStatus(view) : `Strigoi · ${inspection.state.desired} · ${inspection.readiness}`, noticeTone: inspection.state.hold ? "warning" : "neutral" };
    const snapshot = await collectFleetSnapshot(client);
    if (id) state = { ...revealCurrentSession({ ...state, selectedSessionId: id, residentFocusSessionId: id,
      focusedViewControl: undefined, focusedFolderCwd: undefined, focusedShowMoreCwd: undefined, focusedHistoryCwd: undefined,
      focusedUpdateSessionId: undefined, focusedLifecycleCwd: undefined, focusedLifecycleSessionId: undefined, focusedUnconfirmedCwd: undefined }, snapshot, id), notice: state.notice };
    return { state, snapshot };
  }
  return { state, snapshot: await collectFleetSnapshot(client) };
}
