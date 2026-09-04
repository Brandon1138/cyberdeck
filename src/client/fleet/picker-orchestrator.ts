import type { SessionRecord } from "../../domain/session.js";
import { stripTerminalControl } from "../../domain/terminal-replay.js";
import { DELETE_CONFIRMATION_MS } from "./constants.js";
import { threadSubject } from "./list-groups.js";
import { isTerminalSession, orderedThreads } from "./list-rows.js";
import { friendlyModel } from "./model-labels.js";
import { displayThreadName, fit } from "./render-composer.js";
import { renderHeader } from "./render-list.js";
import { boundedIndex } from "./render-rows.js";
import { type OrchestratorModelChoice, ResolvedFleetRenderOptions } from "./runtime-options.js";
import { paint, renderNotice } from "./slash-commands.js";
import { FleetSnapshot, FleetState, FleetTransition, OrchestratorPickerFocus, OrchestratorPickerState } from "./state.js";
import { threadStatus } from "./transport.js";

export function transitionOrchestratorPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
  now: number,
): FleetTransition {
  const picker = state.orchestratorPicker!;
  const choices = state.workerModels.orchestratorChoices;
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
      const existing = existingOrchestrators(snapshot);
      const current = orchestratorFocusIndex(picker.focus, existing);
      // An unresolved focus — its orchestrator was deleted from under the picker — is rescued onto
      // the first row rather than moved relative to a position it no longer has.
      const index = current < 0
        ? 0
        : boundedIndex(current + delta, existing.length + choices.length);
      return {
        state: {
          ...state,
          orchestratorPicker: { ...picker, focus: orchestratorFocusAt(index, existing) },
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

  if (key !== "enter") return { state };
  if (picker.step === "target") {
    const focus = picker.focus;
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
    const modelIndex = focus.modelIndex;
    const choice = choices[modelIndex];
    if (choice === undefined) {
      return {
        state: {
          ...state,
          notice: "No orchestrator model is available",
          noticeTone: "error",
        },
      };
    }
    return {
      state: {
        ...state,
        orchestratorPicker: { step: "effort", modelIndex, effortIndex: 0 },
        notice: undefined,
      },
    };
  }

  const selection = orchestratorSelection(picker, choices);
  return {
    state: { ...state, orchestratorPicker: undefined, notice: undefined },
    action: {
      type: "create-orchestrator",
      cockpitCwd: state.fallbackCwd,
      request: {
        provider: selection.provider.provider,
        model: selection.model,
        ...(selection.effort === undefined ? {} : { effort: selection.effort }),
        cwd: state.fallbackCwd,
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
  const selection = picker.step === "effort" ? orchestratorSelection(picker, choices) : undefined;
  const stepNumber = picker.step === "target" ? 1 : 2;
  const lines = [
    ...renderHeader(orderedThreads(snapshot), state, options),
    "",
    paint(`Orchestrator  ${stepNumber} of 2`, "dim", options.color),
    "",
  ];

  // Set only when the focused row is an existing orchestrator, never a "New orchestrator"
  // profile — that row has nothing for ctrl+x to target, so the hint stays silent on it.
  let destructiveHint: string | undefined;
  if (picker.step === "target") {
    const existing = existingOrchestrators(snapshot);
    const focusIndex = orchestratorFocusIndex(picker.focus, existing);
    lines.push("Existing orchestrators", "");
    if (existing.length === 0) {
      lines.push(paint("  No interactive orchestrators", "dim", options.color));
    } else {
      lines.push(...existing.map((record, index) =>
        pickerRow(existingOrchestratorLabel(record, options.color), index === focusIndex, options.color)));
    }
    lines.push("", "New orchestrator", "");
    const fallback = choices.find((choice) => choice.provider.provider === "codex")?.provider.fallbackReason;
    if (fallback !== undefined) {
      lines.push(paint(fit(`~ Codex models are a stored list — ${fallback}`, options.width), "muted", options.color), "");
    }
    lines.push(...choices.map((choice, index) =>
      pickerRow(
        `${choice.label}  ${paint(choice.provider.label, "dim", options.color)}`,
        existing.length + index === focusIndex,
        options.color,
      )));
    const selectedExisting = existing[focusIndex];
    if (selectedExisting !== undefined) {
      destructiveHint = isTerminalSession(selectedExisting)
        && picker.stopAcknowledgement?.sessionId === selectedExisting.id
        ? "ctrl+x delete"
        : "ctrl+x stop";
    }
  } else {
    lines.push(`${selection!.provider.label} effort`, "");
    lines.push(...selection!.provider.efforts.map((effort, index) =>
      pickerRow(effort === "native-default" ? "Provider managed" : effort, index === picker.effortIndex, options.color)));
  }

  const targetHint = destructiveHint === undefined
    ? "↑↓ select · enter focus/next · esc back"
    : `↑↓ select · enter focus/next · ${destructiveHint} · esc back`;
  const footer = [
    ...(state.notice === undefined ? [] : [renderNotice(state.notice, state.noticeTone, options.width, options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    ...(selection === undefined
      ? []
      : [paint(fit(`${selection.provider.label} · ${selection.model} · ${selection.effort ?? "Provider managed"}`, options.width), "muted", options.color)]),
    paint(
      fit(picker.step === "effort"
        ? "↑↓ select · enter create in cockpit · esc back"
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
  picker: Extract<OrchestratorPickerState, { step: "effort"; }>,
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

export function initialOrchestratorPicker(snapshot: FleetSnapshot, _cwd: string): OrchestratorPickerState {
  return { step: "target", focus: orchestratorFocusAt(0, existingOrchestrators(snapshot)) };
}

/** Where a focus sits in the picker's combined row order, or -1 when its orchestrator is gone. */
export function orchestratorFocusIndex(
  focus: OrchestratorPickerFocus,
  existing: readonly SessionRecord[],
): number {
  return focus.kind === "profile"
    ? existing.length + focus.modelIndex
    : existing.findIndex((record) => record.id === focus.sessionId);
}

/** The inverse: the durable focus a row position names, so navigation never stores a position. */
export function orchestratorFocusAt(
  index: number,
  existing: readonly SessionRecord[],
): OrchestratorPickerFocus {
  const record = existing[index];
  return record === undefined
    ? { kind: "profile", modelIndex: Math.max(0, index - existing.length) }
    : { kind: "existing", sessionId: record.id };
}

/**
 * Every orchestrator the broker still holds, live or terminal, in the fleet list's own order.
 *
 * Terminal rows stay until they are deleted, exactly as they do in the fleet list. Filtering them
 * out broke the ctrl+x ladder on the real broker: `SessionRegistry.stop()` moves a live
 * orchestrator to cancelled/stopping on the first press, so the row vanished before the second
 * press could arm the delete and the third could run it. A row that cannot be reached is a row
 * that cannot be cleaned up, so retention is now the whole record set and the label carries the
 * state instead.
 */
export function existingOrchestrators(snapshot: FleetSnapshot): SessionRecord[] {
  return orderedThreads(snapshot)
    .map(({ record }) => record)
    .filter((record) => record.kind === "orchestrator" && record.role === "orchestrator");
}

export function existingOrchestratorLabel(record: SessionRecord, color: boolean): string {
  const name = displayThreadName(
    record.name ?? `${friendlyModel(record.provider, record.model)} orchestrator`,
  );
  const lifecycle = record.attachmentState === "controlled"
    ? paint("in use", "yellow", color)
    : record.executionState === "active"
      ? paint("available", "green", color)
      : record.executionState === "starting"
        ? paint("starting", "green", color)
        // Anything else wears its own outcome rather than a join affordance. A stopped orchestrator
        // sits in this list until it is deleted, and must not read as one waiting to be joined.
        : paint(terminalOrchestratorState(record), "dim", color);
  return `${name}  ${paint(record.id.slice(0, 8), "dim", color)}  ${lifecycle}`;
}

/**
 * The fleet list's own status vocabulary, lowercased for a picker row. Only non-active records
 * reach it, so the `active` branch of {@link threadStatus} — the one that reads the terminal
 * replay — is unreachable and the empty replay below is never consulted.
 */
export function terminalOrchestratorState(record: SessionRecord): string {
  return threadStatus({ record }).toLowerCase();
}

export function pickerRow(value: string, selected: boolean, color: boolean): string {
  return `${paint(selected ? "›" : "·", selected ? "bold" : "dim", color)} ${selected ? paint(value, "bold", color) : value}`;
}

/**
 * A cursorless picker still needs a visible interaction anchor in a very short pane.
 *
 * Every selected picker row — including the directed-handoff draft — starts with `›`. Keep that
 * row inside the body window, and when the footer itself would consume the pane, spend the first
 * physical row on the selection before retaining as many trailing hints as still fit. This is a
 * visual anchor only; it never turns a picker into a terminal caret owner.
 */
export function renderCursorlessPickerFrame(
  lines: readonly string[],
  footer: readonly string[],
  height: number,
  priorityFooterRows = 0,
): string {
  const frameHeight = Math.max(1, height);
  const selectedIndex = lines.findLastIndex((line) =>
    stripTerminalControl(line).startsWith("› "));
  const fallbackIndex = lines.findLastIndex((line) => stripTerminalControl(line).trim() !== "");
  const anchorIndex = Math.max(0, selectedIndex === -1 ? fallbackIndex : selectedIndex);

  if (frameHeight <= footer.length) {
    const footerCapacity = frameHeight - 1;
    const priorityFooter = footer.slice(0, Math.min(priorityFooterRows, footerCapacity));
    const trailingCapacity = footerCapacity - priorityFooter.length;
    const trailingFooter = trailingCapacity === 0
      ? []
      : footer.slice(priorityFooterRows).slice(-trailingCapacity);
    const visibleFooter = [...priorityFooter, ...trailingFooter];
    return [lines[anchorIndex] ?? footer.at(-1) ?? "", ...visibleFooter].join("\n");
  }

  const bodyHeight = frameHeight - footer.length;
  const firstBodyRow = Math.max(
    0,
    Math.min(anchorIndex - bodyHeight + 1, lines.length - bodyHeight),
  );
  const body = lines.slice(firstBodyRow, firstBodyRow + bodyHeight);
  while (body.length < bodyHeight) body.push("");
  return [...body, ...footer].join("\n");
}
