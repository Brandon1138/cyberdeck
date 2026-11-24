import { DELETE_CONFIRMATION_MS } from "./constants.js";
import { threadSubject } from "./list-groups.js";
import { isTerminalSession, orderedThreads } from "./list-rows.js";
import {
  existingOrchestratorLabel,
  existingOrchestrators,
  orchestratorFocusIndex,
  orchestratorTargetFocus,
  orchestratorTargetPosition,
  providerManagedOnly,
  visibleOrchestratorModels,
} from "./orchestrator-targets.js";
import { pickerRow, renderCursorlessPickerFrame } from "./picker-frame.js";
import { fit } from "./render-composer.js";
import { renderHeader } from "./render-list.js";
import { boundedIndex, pickerScrollOffset } from "./render-rows.js";
import { type OrchestratorModelChoice, ResolvedFleetRenderOptions } from "./runtime-options.js";
import { paint, renderNotice } from "./slash-commands.js";
import { FleetSnapshot, FleetState, FleetTransition, OrchestratorPickerState } from "./state.js";

export function transitionOrchestratorPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
  now: number,
): FleetTransition {
  const picker = state.orchestratorPicker!;
  const choices = state.workerModels.orchestratorChoices;
  if (picker.step === "project") {
    const { modelIndex, effortIndex, projectRoot } = picker;
    if (key === "escape") {
      if (providerManagedOnly(choices[modelIndex])) {
        return {
          state: {
            ...state,
            notice: undefined,
            orchestratorPicker: { step: "target", focus: { kind: "profile", modelIndex }, filter: "" },
          },
        };
      }
      return { state: { ...state, notice: undefined, orchestratorPicker: { step: "effort", modelIndex, effortIndex } } };
    }
    const projects = [undefined, ...(snapshot.projects ?? [])];
    const index = projects.indexOf(projectRoot);
    if (key === "up" || key === "down") {
      const next = boundedIndex(index + (key === "up" ? -1 : 1), projects.length);
      return { state: { ...state, orchestratorPicker: { ...picker, projectRoot: projects[next] }, notice: undefined } };
    }
    if (key !== "enter") return { state };
    if (index < 0) {
      return { state: {
        ...state,
        orchestratorPicker: { ...picker, projectRoot: undefined },
        notice: "Project was removed. Choose a home again.",
        noticeTone: "warning",
      } };
    }
    return createSelectedOrchestrator(state, picker, projectRoot);
  }
  if (key === "escape") {
    return {
      state: {
        ...state,
        orchestratorPicker: picker.step === "effort"
          ? { step: "target", focus: { kind: "profile", modelIndex: picker.modelIndex } }
          : undefined,
        notice: undefined,
      },
    };
  }

  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    if (picker.step === "target") {
      const existing = picker.existingExpanded ? existingOrchestrators(snapshot) : [];
      const visible = visibleOrchestratorModels(choices, picker.filter ?? "");
      const index = boundedIndex(
        orchestratorTargetPosition(picker.focus, existing, visible) + delta,
        1 + existing.length + visible.length,
      );
      return {
        state: {
          ...state,
          orchestratorPicker: {
            ...picker,
            focus: index === 0
              ? { kind: "existing-group" }
              : orchestratorTargetFocus(index - 1, existing, visible),
          },
        },
      };
    }
    const choice = choices[picker.modelIndex]!;
    return {
      state: {
        ...state,
        orchestratorPicker: {
          ...picker,
          effortIndex: boundedIndex(picker.effortIndex + delta, choice.provider.efforts.length),
        },
      },
    };
  }

  if (picker.step === "target" && (
    picker.focus.kind === "existing-group" && ["enter", "left", "right"].includes(key)
    || picker.focus.kind === "existing" && key === "left"
  )) {
    return {
      state: {
        ...state,
        orchestratorPicker: {
          ...picker,
          focus: { kind: "existing-group" },
          existingExpanded: key === "enter" ? !picker.existingExpanded : key === "right",
          stopAcknowledgement: undefined,
          deleteConfirmation: undefined,
        },
        notice: undefined,
      },
    };
  }

  // Same durable-id target, same graceful-stop/confirm/delete ladder as the fleet list's own
  // ctrl+x — this is a second place to reach it, not a second way to do it. A "New orchestrator"
  // row has no session to stop, so the key is inert there.
  if (key === "ctrl+x" && picker.step === "target") {
    const focus = picker.focus;
    if (focus.kind !== "existing") return { state };
    const selectedExisting = existingOrchestrators(snapshot)
      .find((record) => record.id === focus.sessionId);
    if (selectedExisting === undefined) return { state };
    const terminal = isTerminalSession(selectedExisting);
    const stopAcknowledged = picker.stopAcknowledgement?.sessionId === selectedExisting.id;
    if (!terminal || !stopAcknowledged) {
      return {
        state: {
          ...state,
          orchestratorPicker: {
            ...picker,
            stopAcknowledgement: { sessionId: selectedExisting.id },
            deleteConfirmation: undefined,
          },
          notice: `Stopping ${threadSubject(selectedExisting)}`,
          noticeTone: "warning",
        },
        action: { type: "stop", sessionId: selectedExisting.id },
      };
    }
    const deleteConfirmed = picker.deleteConfirmation?.sessionId === selectedExisting.id
      && picker.deleteConfirmation.expiresAt > now;
    if (deleteConfirmed) {
      return {
        state: {
          ...state,
          orchestratorPicker: { ...picker, deleteConfirmation: undefined },
          notice: undefined,
        },
        action: { type: "delete", sessionId: selectedExisting.id },
      };
    }
    return {
      state: {
        ...state,
        orchestratorPicker: {
          ...picker,
          deleteConfirmation: { sessionId: selectedExisting.id, expiresAt: now + DELETE_CONFIRMATION_MS },
        },
        notice: `Delete ${threadSubject(selectedExisting)}? press ctrl+x again`,
        noticeTone: "confirmation",
      },
    };
  }

  if (picker.step === "target" && (key === "backspace" || ([...key].length === 1 && key.charCodeAt(0) >= 0x20))) {
    const filter = key === "backspace"
      ? [...(picker.filter ?? "")].slice(0, -1).join("")
      : `${picker.filter ?? ""}${key}`;
    const visible = visibleOrchestratorModels(choices, filter);
    const focus = picker.focus;
    const focusedModel = focus.kind === "profile" ? focus.modelIndex : undefined;
    const nextFocus = focusedModel !== undefined && !visible.some((row) => row.modelIndex === focusedModel)
      ? { kind: "profile" as const, modelIndex: visible[0]?.modelIndex ?? focusedModel }
      : focus;
    return { state: { ...state, notice: undefined, orchestratorPicker: { ...picker, filter, focus: nextFocus } } };
  }

  if (key !== "enter") return { state };
  if (picker.step === "target") {
    const focus = picker.focus;
    if (focus.kind === "existing-group") return { state };
    const existing = existingOrchestrators(snapshot);
    if (focus.kind === "existing") {
      const selectedExisting = existing.find((record) => record.id === focus.sessionId);
      // The row was deleted between the keypress and this snapshot. Enter opens nothing rather
      // than the orchestrator that inherited the position.
      if (selectedExisting === undefined) return { state };
      if (selectedExisting.attachmentState === "controlled") {
        return {
          state: {
            ...state,
            notice: "Orchestrator is in use by another controller",
            noticeTone: "warning",
          },
        };
      }
      // A terminal row is joined, not ignored: Enter resumes it and focuses the cockpit, which is
      // exactly what Enter on a terminal thread does in the fleet list.
      return {
        state: {
          ...state,
          selectedSessionId: selectedExisting.id,
          orchestratorPicker: undefined,
          notice: undefined,
        },
        action: {
          type: "open-orchestrator",
          sessionId: selectedExisting.id,
          cockpitCwd: state.fallbackCwd,
          requiresResume: selectedExisting.executionState !== "active"
            && selectedExisting.executionState !== "starting",
        },
      };
    }
    const visible = visibleOrchestratorModels(choices, picker.filter ?? "");
    const selected = visible.find((row) => row.modelIndex === focus.modelIndex);
    if (selected === undefined) {
      const filter = picker.filter?.trim() ?? "";
      return {
        state: {
          ...state,
          notice: filter === "" ? "No orchestrator model is available" : `No model matches ${filter}`,
          noticeTone: "error",
        },
      };
    }
    return continueOrchestratorModel(state, snapshot, selected.modelIndex);
  }

  if (snapshot.projects?.length) {
    return { state: { ...state, orchestratorPicker: { ...picker, step: "project" }, notice: undefined } };
  }
  return createSelectedOrchestrator(state, picker);
}

function continueOrchestratorModel(
  state: FleetState,
  snapshot: FleetSnapshot,
  modelIndex: number,
): FleetTransition {
  const choice = state.workerModels.orchestratorChoices[modelIndex];
  if (choice === undefined) {
    return { state: { ...state, notice: "No orchestrator model is available", noticeTone: "error" } };
  }
  // Cursor's only effort is the slug itself. A one-row "Provider managed" screen is a keypress
  // that chooses nothing, so Enter goes on to the project or creates the Orc.
  if (providerManagedOnly(choice)) {
    if (snapshot.projects?.length) {
      return {
        state: {
          ...state,
          orchestratorPicker: { step: "project", modelIndex, effortIndex: 0 },
          notice: undefined,
        },
      };
    }
    return createSelectedOrchestrator(state, { step: "effort", modelIndex, effortIndex: 0 });
  }
  return {
    state: {
      ...state,
      orchestratorPicker: { step: "effort", modelIndex, effortIndex: 0 },
      notice: undefined,
    },
  };
}

function createSelectedOrchestrator(state: FleetState, picker: Exclude<OrchestratorPickerState, { step: "target" }>,
  projectRoot?: string): FleetTransition {
  const selection = orchestratorSelection(picker, state.workerModels.orchestratorChoices);
  return {
    state: { ...state, orchestratorPicker: undefined, notice: undefined },
    action: {
      type: "create-orchestrator",
      cockpitCwd: state.fallbackCwd,
      request: {
        provider: selection.provider.provider,
        model: selection.model,
        ...(selection.effort === undefined ? {} : { effort: selection.effort }),
        cwd: projectRoot ?? state.fallbackCwd,
        ...(projectRoot === undefined ? {} : { projectRoot }),
        scope: "fleet",
      },
    },
  };
}

export function renderOrchestratorPicker(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const picker = state.orchestratorPicker!;
  const choices = state.workerModels.orchestratorChoices;
  const selection = picker.step !== "target" ? orchestratorSelection(picker, choices) : undefined;
  const focusedChoice = picker.step === "target"
    ? (picker.focus.kind === "profile" ? choices[picker.focus.modelIndex] : undefined)
    : choices[picker.modelIndex];
  const skipsEffort = providerManagedOnly(focusedChoice);
  const hasProjects = (snapshot.projects?.length ?? 0) > 0 || picker.step === "project";
  const totalSteps = 1 + (skipsEffort ? 0 : 1) + (hasProjects ? 1 : 0);
  const stepNumber = picker.step === "target" ? 1 : picker.step === "effort" ? 2 : skipsEffort ? 2 : 3;
  const lines = [
    ...renderHeader(orderedThreads(snapshot), state, options),
    "",
    paint(`Orchestrator  ${stepNumber} of ${totalSteps}`, "dim", options.color),
    "",
  ];

  // Set only when the focused row is an existing orchestrator, never a "New orchestrator"
  // profile — that row has nothing for ctrl+x to target, so the hint stays silent on it.
  let destructiveHint: string | undefined;
  let range = "";
  if (picker.step === "target") {
    const existing = existingOrchestrators(snapshot);
    const focusIndex = orchestratorFocusIndex(picker.focus, existing);
    lines.push(pickerRow(
      `${picker.existingExpanded ? "▾" : "▸"} Existing orchestrators (${existing.length})`,
      picker.focus.kind === "existing-group", options.color,
    ), "");
    if (existing.length === 0) {
      lines.push(paint("  No interactive orchestrators", "dim", options.color));
    } else if (picker.existingExpanded) {
      lines.push(...existing.map((record, index) =>
        pickerRow(existingOrchestratorLabel(record, options.color), index === focusIndex, options.color)));
    }
    const filter = picker.filter ?? "";
    lines.push("", filter.trim() === "" ? "New orchestrator" : `New orchestrator · ${filter}`, "");
    const announced = new Set<string>();
    for (const choice of choices) {
      const reason = choice.provider.fallbackReason;
      if (reason === undefined || announced.has(choice.provider.provider)) continue;
      announced.add(choice.provider.provider);
      lines.push(paint(
        fit(`~ ${choice.provider.label} models are a stored list — ${reason}`, options.width),
        "muted",
        options.color,
      ));
    }
    if (announced.size > 0) lines.push("");
    const visible = visibleOrchestratorModels(choices, filter);
    const footerRows = (state.notice === undefined ? 0 : 1) + 2;
    const visibleRows = Math.max(1, options.height - footerRows - lines.length);
    const focusedModel = picker.focus.kind === "profile" ? picker.focus.modelIndex : undefined;
    const selectedSlot = focusedModel === undefined
      ? 0
      : visible.findIndex((row) => row.modelIndex === focusedModel);
    const offset = pickerScrollOffset(Math.max(0, selectedSlot), visible.length, visibleRows);
    lines.push(...visible.slice(offset, offset + visibleRows).map((row) =>
      pickerRow(
        `${row.choice.label}  ${paint(row.choice.provider.label, "dim", options.color)}`,
        focusedModel === row.modelIndex,
        options.color,
      )));
    if (visible.length === 0) {
      lines.push(paint(`No model matches ${filter.trim()}`, "muted", options.color));
    }
    if (visible.length > visibleRows) {
      range = ` · ${offset + 1}-${Math.min(visible.length, offset + visibleRows)} of ${visible.length}`;
    }
    const selectedExisting = existing[focusIndex];
    if (selectedExisting !== undefined) {
      destructiveHint = isTerminalSession(selectedExisting)
        && picker.stopAcknowledgement?.sessionId === selectedExisting.id
        ? "ctrl+x delete"
        : "ctrl+x stop";
    }
  } else if (picker.step === "project") {
    lines.push("New Orc · choose its home", "",
      pickerRow("No project (Fleet)", picker.projectRoot === undefined, options.color));
    for (const root of snapshot.projects ?? []) {
      lines.push(pickerRow(fit(root, Math.max(1, options.width - 2)), root === picker.projectRoot, options.color));
    }
  } else {
    lines.push(`${selection!.provider.label} effort`, "");
    lines.push(...selection!.provider.efforts.map((effort, index) =>
      pickerRow(effort === "native-default" ? "Provider managed" : effort, index === picker.effortIndex, options.color)));
  }

  const targetHint = `${picker.step === "target" && picker.focus.kind === "existing-group"
    ? "↑↓ select · enter expand/collapse · ←→ fold/unfold · esc back"
    : destructiveHint === undefined
    ? "↑↓ select · enter focus/next · esc back"
    : `↑↓ select · enter focus/next · ${destructiveHint} · esc back`} · type to filter${range}`;
  const footer = [
    ...(state.notice === undefined ? [] : [renderNotice(state.notice, state.noticeTone, options.width, options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    ...(selection === undefined
      ? []
      : [paint(fit(`${selection.provider.label} · ${selection.model} · ${selection.effort ?? "Provider managed"}`, options.width), "muted", options.color)]),
    paint(
      fit(picker.step === "effort" && snapshot.projects?.length
        ? "↑↓ select · enter choose project · esc back"
        : picker.step !== "target" ? "↑↓ select · enter create in cockpit · esc back"
        : targetHint, options.width),
      "dim",
      options.color,
    ),
  ];
  return renderCursorlessPickerFrame(
    lines,
    footer,
    options.height,
    state.notice === undefined ? 0 : 1,
  );
}

export function orchestratorSelection(
  picker: Exclude<OrchestratorPickerState, { step: "target"; }>,
  choices: readonly OrchestratorModelChoice[],
) {
  const choice = choices[picker.modelIndex]!;
  const provider = choice.provider;
  const effort = provider.efforts[picker.effortIndex]!;
  return {
    provider,
    model: choice.model,
    effort: effort === "native-default" ? undefined : effort,
  };
}

export function initialOrchestratorPicker(_snapshot: FleetSnapshot, _cwd: string): OrchestratorPickerState {
  return { step: "target", focus: { kind: "profile", modelIndex: 0 }, filter: "" };
}
