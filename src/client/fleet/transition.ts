import { imageInputRefusal, providerAcceptsImages } from "../../domain/image-input.js";
import { HANDOFF_LIMITS } from "../../domain/worker-handoff.js";
import { DELETE_CONFIRMATION_MS, PROJECTS_UNAVAILABLE_NOTICE, QUIT_CONFIRMATION_NOTICE } from "./constants.js";
import { focusRow, foldTransition, navigableListRowIndex, scrollFocusedRowIntoView, setCollapsed, setExpanded, threadSubject } from "./list-groups.js";
import { fleetListRows, focusedListRowIndex, isCollapsed, isExpanded, isTerminalSession, orderedThreads, threadFocusInert } from "./list-rows.js";
import { composerCwd } from "./model-labels.js";
import { normalizeState, openAction } from "./normalize.js";
import { TERMINAL_HANDOFF_REFUSAL, handoffMarks, openHandoffPicker, transitionHandoffPicker } from "./picker-handoff.js";
import { initialOrchestratorPicker, transitionOrchestratorPicker } from "./picker-orchestrator.js";
import { openPermissionPicker, transitionCommandPalette, transitionPermissionPicker } from "./picker-palette.js";
import { openWorkerPicker, transitionProjectPrompt, transitionShellMode, transitionWorkerPicker } from "./picker-worker.js";
import { startTransition, workerPolicyTransition } from "./slash-commands.js";
import { FleetSnapshot, FleetState, FleetTransition } from "./state.js";
import { transitionQuit, transitionRename } from "./transition-modes.js";
export function transitionFleet(current: FleetState, snapshot: FleetSnapshot, key: string, now = Date.now(), threadListViewportHeight = Number.MAX_SAFE_INTEGER): FleetTransition {
  const normalized = normalizeState(current, snapshot, now);
  const threads = orderedThreads(snapshot);
  const quit = transitionQuit(normalized, key, now);
  if (quit !== undefined) return quit;
  const state = normalized.quitConfirmation === undefined
    ? normalized
    : {
      ...normalized,
      quitConfirmation: undefined,
      ...(normalized.notice === QUIT_CONFIRMATION_NOTICE ? { notice: undefined } : {}),
    };
  const focusedFolderCwd = state.focusedFolderCwd;
  const focusedShowMoreCwd = state.focusedShowMoreCwd;
  const selected = threadFocusInert(state)
    ? undefined
    : threads.find(({ record }) => record.id === state.selectedSessionId);
  if (key === "ctrl+w") {
    return {
      state: {
        ...state,
        view: state.view === "fleet" ? "diagnostics" : "fleet",
        helpOpen: false,
        notice: undefined,
      },
    };
  }
  if (state.view === "diagnostics") return { state };
  if (state.rename !== undefined) return transitionRename(state, key);
  if (state.projectPrompt !== undefined) {
    return transitionProjectPrompt(state, snapshot, key);
  }
  if (state.shellMode !== undefined) {
    return transitionShellMode(state, snapshot, key);
  }
  if (state.workerPicker !== undefined) {
    return transitionWorkerPicker(state, key);
  }
  if (state.permissionPicker !== undefined) {
    return transitionPermissionPicker(state, snapshot, key);
  }
  if (state.commandPalette !== undefined) {
    return transitionCommandPalette(state, snapshot, key);
  }
  if (state.handoffPicker !== undefined) {
    return transitionHandoffPicker(state, snapshot, key);
  }
  if (key === "ctrl+o") {
    return {
      state: {
        ...state,
        draft: "",
        deleteConfirmation: undefined,
        notice: undefined,
        orchestratorPicker: initialOrchestratorPicker(snapshot, state.fallbackCwd),
      },
      action: { type: "worker-capabilities" },
    };
  }
  if (state.orchestratorPicker !== undefined) {
    return transitionOrchestratorPicker(state, snapshot, key, now);
  }
  if (key === "ctrl+s") {
    return {
      state: { ...state, helpOpen: false, notice: undefined },
      action: { type: "change-directory", cwd: composerCwd(state, snapshot) },
    };
  }
  if (key === "ctrl+]") {
    const cockpitTarget = selected
      ?? threads.find(({ record }) => record.id === state.selectedSessionId);
    if (cockpitTarget?.record.kind !== "orchestrator") {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: "Select a detached orchestrator to attach to the cockpit",
          noticeTone: "neutral",
        },
      };
    }
    if (cockpitTarget.record.attachmentState === "controlled") {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: "Selected orchestrator is controlled elsewhere",
          noticeTone: "warning",
        },
      };
    }
    return {
      state: { ...state, helpOpen: false, notice: undefined },
      action: {
        type: "open-orchestrator",
        sessionId: cockpitTarget.record.id,
        cockpitCwd: state.fallbackCwd,
        requiresResume: cockpitTarget.record.executionState !== "active"
          && cockpitTarget.record.executionState !== "starting",
      },
    };
  }
  if (key === "?" && state.draft === "") {
    return { state: { ...state, helpOpen: state.helpOpen !== true, notice: undefined } };
  }
  if (key === "ctrl+l") {
    return {
      state: {
        ...state,
        leaseDetail: state.leaseDetail !== true,
        helpOpen: false,
        notice: undefined,
      },
    };
  }
  if (key === "ctrl+d") {
    if (selected === undefined) {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: "Select a worker to mark it for handoff",
          noticeTone: "warning",
        },
      };
    }
    if (selected.record.kind === "orchestrator") {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: "An orchestrator receives a handoff; it is not marked for one",
          noticeTone: "warning",
        },
      };
    }
    if (isTerminalSession(selected.record)) {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: TERMINAL_HANDOFF_REFUSAL,
          noticeTone: "warning",
        },
      };
    }
    const marked = handoffMarks(state);
    const workerId = selected.record.id;
    if (!marked.includes(workerId) && marked.length >= HANDOFF_LIMITS.manifestEntries) {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: `A handoff can include at most ${HANDOFF_LIMITS.manifestEntries} workers`,
          noticeTone: "warning",
        },
      };
    }
    const next = marked.includes(workerId)
      ? marked.filter((id) => id !== workerId)
      : [...marked, workerId];
    return {
      state: {
        ...state,
        handoffMarks: next,
        helpOpen: false,
        notice: next.length === 0
          ? "No workers marked for handoff"
          : `${next.length} worker${next.length === 1 ? "" : "s"} marked · /handoff to send`,
        noticeTone: "neutral",
      },
    };
  }
  if (key === "ctrl+r" && selected !== undefined) {
    return {
      state: {
        ...state,
        rename: { sessionId: selected.record.id, draft: selected.record.name ?? "" },
        helpOpen: false,
        notice: undefined,
      },
    };
  }
  if (key === "ctrl+n") {
    if (focusedFolderCwd !== undefined) {
      if (focusedFolderCwd.startsWith("/@")) {
        return {
          state: { ...state, helpOpen: false, notice: "Not a project folder", noticeTone: "warning" },
        };
      }
      return {
        state: { ...state, helpOpen: false, notice: undefined },
        action: { type: "open-checkout", cwd: focusedFolderCwd },
      };
    }
    if (selected === undefined || selected.record.kind === "orchestrator") {
      return {
        state: {
          ...state,
          helpOpen: false,
          notice: "Select a worker to open its worktree in nvim",
          noticeTone: "neutral",
        },
      };
    }
    return {
      state: { ...state, helpOpen: false, notice: undefined },
      action: { type: "open-worktree", sessionId: selected.record.id },
    };
  }
  if (key === "ctrl+t" && selected !== undefined) {
    return { state: { ...state, helpOpen: false, notice: undefined }, action: { type: "pin", sessionId: selected.record.id } };
  }
  if ((key === "shift+up" || key === "shift+down") && selected !== undefined) {
    return {
      state: { ...state, helpOpen: false, notice: undefined },
      action: {
        type: "reorder",
        sessionId: selected.record.id,
        direction: key === "shift+up" ? "up" : "down",
      },
    };
  }
  if (/^alt\+[1-9]$/u.test(key)) {
    const index = Number(key.slice(-1)) - 1;
    const target = threads[index];
    return target === undefined
      ? { state }
      : {
        state: {
          ...state,
          selectedSessionId: target.record.id,
          focusedFolderCwd: undefined,
          focusedShowMoreCwd: undefined,
          deleteConfirmation: undefined,
          notice: undefined,
        },
        action: openAction(target.record),
      };
  }
  if (key === "ctrl+x" && selected !== undefined) {
    const terminal = isTerminalSession(selected.record);
    const stopAcknowledged = state.stopAcknowledgement?.sessionId === selected.record.id;
    if (!terminal || !stopAcknowledged) {
      return {
        state: {
          ...state,
          stopAcknowledgement: { sessionId: selected.record.id },
          deleteConfirmation: undefined,
          notice: `Stopping ${threadSubject(selected.record)}`,
          noticeTone: "warning",
        },
        action: { type: "stop", sessionId: selected.record.id },
      };
    }
    if (state.deleteConfirmation?.sessionId === selected.record.id) {
      return {
        state: { ...state, deleteConfirmation: undefined, notice: undefined },
        action: { type: "delete", sessionId: selected.record.id },
      };
    }
    return {
      state: {
        ...state,
        deleteConfirmation: {
          sessionId: selected.record.id,
          expiresAt: now + DELETE_CONFIRMATION_MS,
        },
        notice: `Delete ${threadSubject(selected.record)}? press ctrl+x again`,
        noticeTone: "confirmation",
      },
    };
  }
  if (key === "a" && focusedFolderCwd !== undefined && state.draft === "") {
    if (snapshot.projects === undefined) {
      return { state: { ...state, notice: PROJECTS_UNAVAILABLE_NOTICE, noticeTone: "error" } };
    }
    return {
      state: { ...state, projectPrompt: { draft: "" }, helpOpen: false, notice: undefined },
    };
  }
  if (key === "d" && focusedFolderCwd !== undefined && state.draft === "") {
    if (snapshot.projects === undefined) {
      return { state: { ...state, notice: PROJECTS_UNAVAILABLE_NOTICE, noticeTone: "error" } };
    }
    if (focusedFolderCwd.startsWith("/@")) {
      return { state: { ...state, notice: "Not a project folder", noticeTone: "warning" } };
    }
    return {
      state: { ...state, notice: undefined },
      action: { type: "project-remove", root: focusedFolderCwd },
    };
  }
  if (focusedFolderCwd !== undefined && (key === "left" || key === "right")) {
    return foldTransition(state, setCollapsed(state, focusedFolderCwd, key === "left"), focusedFolderCwd);
  }
  if (key === "enter" && focusedFolderCwd !== undefined && state.draft.trim() === "") {
    return foldTransition(
      state,
      setCollapsed(state, focusedFolderCwd, !isCollapsed(state, focusedFolderCwd)),
      focusedFolderCwd,
    );
  }
  if (focusedShowMoreCwd !== undefined && (key === "left" || key === "right")) {
    return foldTransition(state, setExpanded(state, focusedShowMoreCwd, key === "right"), focusedShowMoreCwd);
  }
  if (key === "enter" && focusedShowMoreCwd !== undefined && state.draft.trim() === "") {
    return foldTransition(
      state,
      setExpanded(state, focusedShowMoreCwd, !isExpanded(state, focusedShowMoreCwd)),
      focusedShowMoreCwd,
    );
  }
  if (key === "right" && selected !== undefined) {
    return {
      state: { ...state, draft: "", deleteConfirmation: undefined, notice: undefined },
      action: openAction(selected.record),
    };
  }
  if (key === " " && state.draft === "" && selected !== undefined) {
    return {
      state: { ...state, deleteConfirmation: undefined, helpOpen: false, notice: undefined },
      action: openAction(selected.record),
    };
  }
  if (key === "enter" && selected !== undefined) {
    const initialPrompt = state.draft.trim();
    const workerPolicy = workerPolicyTransition(state, snapshot, initialPrompt);
    if (workerPolicy !== undefined) return workerPolicy;
    if (initialPrompt === "/model") {
      return openWorkerPicker(state, snapshot, "");
    }
    if (initialPrompt === "/permissions") {
      return openPermissionPicker(state, snapshot);
    }
    if (initialPrompt === "/handoff") {
      return openHandoffPicker(state, snapshot);
    }
    if (initialPrompt === "") {
      return {
        state: { ...state, deleteConfirmation: undefined, notice: undefined },
        action: openAction(selected.record),
      };
    }
    return startTransition(state, selected.record, initialPrompt);
  }
  if (key === "enter" && selected === undefined && state.draft.trim() !== "") {
    const initialPrompt = state.draft.trim();
    const workerPolicy = workerPolicyTransition(state, snapshot, initialPrompt);
    if (workerPolicy !== undefined) return workerPolicy;
    if (initialPrompt === "/model") return openWorkerPicker(state, snapshot, "");
    if (initialPrompt === "/permissions") return openPermissionPicker(state, snapshot);
    if (initialPrompt === "/handoff") return openHandoffPicker(state, snapshot);
    return startTransition(state, undefined, initialPrompt);
  }
  if (
    key === "up"
    || key === "down"
    || key === "pageup"
    || key === "pagedown"
    || key === "alt+k"
    || key === "alt+j"
    || key === "home"
    || key === "end"
  ) {
    const rows = fleetListRows(snapshot, state);
    const currentIndex = focusedListRowIndex(rows, state);
    const pageDistance = Math.max(1, threadListViewportHeight - 1);
    const halfPageDistance = Math.max(1, Math.floor(threadListViewportHeight / 2));
    const targetIndex = key === "home"
      ? 0
      : key === "end"
        ? rows.length - 1
        : currentIndex + (
          key === "up"
            ? -1
            : key === "down"
              ? 1
              : key === "pageup"
                ? -pageDistance
                : key === "pagedown"
                  ? pageDistance
                  : key === "alt+k"
                    ? -halfPageDistance
                    : halfPageDistance
        );
    const nextIndex = navigableListRowIndex(
      rows,
      targetIndex,
      targetIndex < currentIndex ? -1 : 1,
    );
    const focused = focusRow(state, rows[nextIndex]);
    return {
      state: {
        ...scrollFocusedRowIntoView(
          focused,
          rows,
          threadListViewportHeight,
        ),
        deleteConfirmation: undefined,
        notice: undefined,
      },
    };
  }
  if (key === "backspace") {
    return { state: { ...state, draft: [...state.draft].slice(0, -1).join(""), notice: undefined } };
  }
  if (key === "ctrl+v") {
    const target = state.launchProfiles[composerCwd(state, snapshot)]?.provider;
    if (target !== undefined && !providerAcceptsImages(target)) {
      return {
        state: { ...state, notice: imageInputRefusal(target), noticeTone: "error" },
      };
    }
    return { state, action: { type: "attach-clipboard-image" } };
  }
  if (key === "ctrl+j" || key === "alt+enter" || key === "shift+enter") {
    return { state: { ...state, draft: `${state.draft}\n`, notice: undefined } };
  }
  if (key === "escape") {
    if (state.helpOpen === true) return { state: { ...state, helpOpen: false, notice: undefined } };
    if (state.draft !== "") return { state: { ...state, draft: "", notice: undefined } };
    return { state };
  }
  if (key === "@" && state.draft === "" && selected !== undefined) {
    const reference = (selected.record.name ?? selected.record.id.slice(0, 8)).replace(/\s+/gu, "-");
    return { state: { ...state, draft: `@${reference} `, notice: undefined } };
  }
  if (key === "!" && state.draft === "") {
    return {
      state: {
        ...state,
        shellMode: { draft: "", transcript: [] },
        helpOpen: false,
        notice: undefined,
      },
    };
  }
  if (key === "/" && state.draft === "") {
    return {
      state: {
        ...state,
        draft: "/",
        commandPalette: {
          level: "commands",
          selectedIndex: 0,
          scrollOffset: 0,
        },
        helpOpen: false,
        notice: undefined,
      },
    };
  }
  if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
    return { state: { ...state, draft: `${state.draft}${key}`, notice: undefined } };
  }
  return { state };
}
