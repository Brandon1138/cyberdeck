import type { SessionRecord } from "../../domain/session.js";
import { ORCS_SECTION_KEY } from "./constants.js";
import { groupThreads, orchestratorThreads } from "./list-groups.js";
import { fleetListRows, orderedThreads, threadFocusInert } from "./list-rows.js";
import { reconcileReplyWatermarks } from "./visit-state.js";
import { handoffMarks, isHandoffEligible } from "./picker-handoff.js";
import { existingOrchestrators, orchestratorFocusAt, orchestratorFocusIndex } from "./picker-orchestrator.js";
import { FleetAction, FleetSnapshot, FleetState, OrchestratorPickerState } from "./state.js";

export function openAction(record: SessionRecord): FleetAction {
  return record.executionState === "active" || record.executionState === "starting"
    ? { type: "attach", sessionId: record.id }
    : { type: "resume", sessionId: record.id };
}

export function normalizeState(state: FleetState, snapshot: FleetSnapshot, now: number): FleetState {
  state = reconcileReplyWatermarks(state, snapshot);
  const threads = orderedThreads(snapshot);
  const selectedExists = threads.some(({ record }) => record.id === state.selectedSessionId);
  // Losing a selection never arms an action on the neighbour that happens to take its old slot.
  const selectionLost = state.selectedSessionId !== undefined && !selectedExists;
  const selectedSessionId = selectedExists ? state.selectedSessionId
    : selectionLost ? undefined : threads[0]?.record.id;
  // An orc's row is never hidden by the folder it was launched in — it lives in the global
  // Orcs section — but that section folds and caps like a folder, so the orc answers to it
  // under the sentinel key instead.
  const selectedRecord = threads.find(({ record }) => record.id === selectedSessionId)?.record;
  const orcs = orchestratorThreads(snapshot.threads);
  const folders = [
    ...(orcs.length === 0 ? [] : [{ cwd: ORCS_SECTION_KEY, threads: orcs }]),
    ...groupThreads(snapshot),
  ];
  // A worker answers to the section it renders in, which under a registry is its project rather
  // than its own working directory.
  const selectedCwd = selectedRecord === undefined
    ? undefined
    : selectedRecord.kind === "orchestrator"
      ? ORCS_SECTION_KEY
      : folders.find(({ threads: workers }) =>
        workers.some(({ record }) => record.id === selectedRecord.id))?.cwd;
  // The explicit stop/delete ladder stays on the same durable id even when stopping folds it
  // into history. Reveal that history locally rather than arming the thread in its former slot.
  if (!threadFocusInert(state) && state.stopAcknowledgement?.sessionId === selectedSessionId && selectedCwd !== undefined) {
    state = { ...state, expandedHistoryCwds: [...new Set([...(state.expandedHistoryCwds ?? []), selectedCwd])],
      expandedCwds: [...new Set([...(state.expandedCwds ?? []), selectedCwd])] };
  }
  const rows = fleetListRows(snapshot, { ...state, selectedSessionId });
  const has = (kind: "folder" | "show-more" | "history", cwd: string | undefined) =>
    cwd !== undefined && rows.some((row) => row.kind === kind && row.cwd === cwd);
  const visibleSelection = rows.some((row) => row.kind === "thread" && row.thread.record.id === selectedSessionId);
  let focusedFolderCwd = has("folder", state.focusedFolderCwd) ? state.focusedFolderCwd : undefined;
  let focusedShowMoreCwd = has("show-more", state.focusedShowMoreCwd) ? state.focusedShowMoreCwd : undefined;
  let focusedHistoryCwd = has("history", state.focusedHistoryCwd) ? state.focusedHistoryCwd : undefined;
  let focusedViewControl = state.focusedViewControl;
  const focusedUpdateSessionId = rows.some((row) => row.kind === "update"
    && row.thread.record.id === state.focusedUpdateSessionId) ? state.focusedUpdateSessionId : undefined;
  const lostStructuralFocus = threadFocusInert(state) && focusedFolderCwd === undefined
    && focusedShowMoreCwd === undefined && focusedHistoryCwd === undefined
    && focusedViewControl === undefined && focusedUpdateSessionId === undefined;
  if (selectionLost && !threadFocusInert(state) || lostStructuralFocus) focusedViewControl = state.listView ?? "live";
  if (focusedViewControl === undefined && focusedFolderCwd === undefined && focusedShowMoreCwd === undefined
    && focusedHistoryCwd === undefined && focusedUpdateSessionId === undefined && !visibleSelection) {
    if (has("show-more", selectedCwd)) focusedShowMoreCwd = selectedCwd;
    else if (has("history", selectedCwd)) focusedHistoryCwd = selectedCwd;
    else if (has("folder", selectedCwd)) focusedFolderCwd = selectedCwd;
    else focusedViewControl = state.listView ?? "live";
  }
  const stopAcknowledgement = state.stopAcknowledgement?.sessionId === selectedSessionId
    ? state.stopAcknowledgement
    : undefined;
  const deleteConfirmation = state.deleteConfirmation !== undefined
    && state.deleteConfirmation.sessionId === selectedSessionId
    && state.deleteConfirmation.expiresAt > now
    ? state.deleteConfirmation
    : undefined;
  const quitConfirmation = state.quitConfirmation !== undefined && state.quitConfirmation.expiresAt > now
    ? state.quitConfirmation
    : undefined;
  // A mark is a claim about a live worker. A session that has gone away takes its mark with it,
  // rather than leaving a batch member the broker would have to refuse the whole handoff over.
  const markedIds = handoffMarks(state).filter((id) => isHandoffEligible(threads, id));
  const confirmationExpired = (state.deleteConfirmation !== undefined && deleteConfirmation === undefined)
    || (state.quitConfirmation !== undefined && quitConfirmation === undefined);
  return {
    ...state,
    selectedSessionId,
    focusedFolderCwd,
    focusedShowMoreCwd,
    focusedHistoryCwd,
    focusedViewControl,
    focusedUpdateSessionId,
    stopAcknowledgement,
    deleteConfirmation,
    quitConfirmation,
    ...(state.handoffMarks === undefined ? {} : { handoffMarks: markedIds }),
    ...(state.orchestratorPicker === undefined
      ? {}
      : { orchestratorPicker: normalizeOrchestratorPicker(state.orchestratorPicker, snapshot, now) }),
    ...(confirmationExpired
      ? { notice: undefined }
      : {}),
  };
}

/**
 * Carry the picker across a snapshot refresh.
 *
 * The focus itself is durable, so nothing has to be re-derived from a row number; the only work is
 * rescuing a focus whose orchestrator was deleted, and dropping a stop acknowledgement or a delete
 * confirmation that is no longer the focused row's — the same rules the fleet list applies to its
 * own copies of that ladder state.
 */
export function normalizeOrchestratorPicker(
  picker: OrchestratorPickerState,
  snapshot: FleetSnapshot,
  now: number,
): OrchestratorPickerState {
  if (picker.step !== "target") return picker;
  const existing = existingOrchestrators(snapshot);
  const focus = orchestratorFocusIndex(picker.focus, existing) < 0
    ? orchestratorFocusAt(0, existing)
    : picker.focus;
  const focusedId = focus.kind === "existing" ? focus.sessionId : undefined;
  return {
    ...picker,
    focus,
    stopAcknowledgement: picker.stopAcknowledgement?.sessionId === focusedId
      ? picker.stopAcknowledgement
      : undefined,
    deleteConfirmation: picker.deleteConfirmation !== undefined
      && picker.deleteConfirmation.sessionId === focusedId
      && picker.deleteConfirmation.expiresAt > now
      ? picker.deleteConfirmation
      : undefined,
  };
}

/** True when the folder's cap would hide this worker, leaving its selection without a row. */

