import type { SessionRecord } from "../../domain/session.js";
import { FOLDER_THREAD_CAP, ORCS_SECTION_KEY } from "./constants.js";
import { groupThreads, orchestratorThreads } from "./list-groups.js";
import { isCollapsed, isExpanded, orderedThreads } from "./list-rows.js";
import { handoffMarks, isHandoffEligible } from "./picker-handoff.js";
import { existingOrchestrators, orchestratorFocusAt, orchestratorFocusIndex } from "./picker-orchestrator.js";
import { FleetAction, FleetSnapshot, FleetState, FleetThread, OrchestratorPickerState } from "./state.js";

export function openAction(record: SessionRecord): FleetAction {
  return record.executionState === "active" || record.executionState === "starting"
    ? { type: "attach", sessionId: record.id }
    : { type: "resume", sessionId: record.id };
}

export function normalizeState(state: FleetState, snapshot: FleetSnapshot, now: number): FleetState {
  const threads = orderedThreads(snapshot);
  const selectedExists = threads.some(({ record }) => record.id === state.selectedSessionId);
  const selectedSessionId = selectedExists ? state.selectedSessionId : threads[0]?.record.id;
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
  const folderExists = state.focusedFolderCwd !== undefined
    && folders.some(({ cwd }) => cwd === state.focusedFolderCwd);
  // A capped folder only offers a show-more row once it has more workers than it shows,
  // and a collapsed folder offers none at all.
  const showMoreExists = state.focusedShowMoreCwd !== undefined
    && !isCollapsed(state, state.focusedShowMoreCwd)
    && folders.some(({ cwd, threads: workers }) =>
      cwd === state.focusedShowMoreCwd && workers.length > FOLDER_THREAD_CAP);
  // A collapsed folder hides its threads, so focus rises to the header rather
  // than resting on a row nobody can see; the cap does the same onto its show-more row.
  const selectedCollapsed = selectedCwd !== undefined && isCollapsed(state, selectedCwd);
  const selectedCapped = !selectedCollapsed
    && selectedCwd !== undefined
    && selectedSessionId !== undefined
    && cappedOut(folders, state, selectedCwd, selectedSessionId);
  const focusedFolderCwd = folderExists
    ? state.focusedFolderCwd
    : !showMoreExists && selectedCollapsed
      ? selectedCwd
      : undefined;
  const focusedShowMoreCwd = focusedFolderCwd !== undefined
    ? undefined
    : showMoreExists
      ? state.focusedShowMoreCwd
      : selectedCapped
        ? selectedCwd
        : undefined;
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
export function cappedOut(
  folders: ReadonlyArray<{ cwd: string; threads: readonly FleetThread[]; }>,
  state: FleetState,
  cwd: string,
  sessionId: string,
): boolean {
  if (isExpanded(state, cwd)) return false;
  const folder = folders.find((candidate) => candidate.cwd === cwd);
  if (folder === undefined) return false;
  return folder.threads.findIndex(({ record }) => record.id === sessionId) >= FOLDER_THREAD_CAP;
}

