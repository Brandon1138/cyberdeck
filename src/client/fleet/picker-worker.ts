import { stripTerminalControl } from "../../domain/terminal-replay.js";
import { expandPath } from "../path-completion.js";
import { composerCwd, friendlyEffort } from "./model-labels.js";
import { adoptOrchestratorModels } from "./orchestrator-models.js";
import { pickerRow, renderCursorlessPickerFrame } from "./picker-orchestrator.js";
import { fit } from "./render-composer.js";
import { renderHeader } from "./render-list.js";
import { boundedIndex } from "./render-rows.js";
import { ResolvedFleetRenderOptions, WorkerModelCatalog, WorkerModelChoice } from "./runtime-options.js";
import { paint, shortPath } from "./slash-commands.js";
import { FleetSnapshot, FleetState, FleetTransition, LaunchProfile } from "./state.js";

export function openWorkerPicker(state: FleetState, snapshot: FleetSnapshot, returnDraft: string): FleetTransition {
  const cwd = composerCwd(state, snapshot);
  return openWorkerPickerForCwd(state, cwd, returnDraft);
}

export function openWorkerPickerForCwd(state: FleetState, cwd: string, returnDraft: string): FleetTransition {
  const current = state.launchProfiles[cwd];
  const choices = state.workerModels.choices;
  const modelIndex = current === undefined
    ? 0
    : Math.max(0, choices.findIndex((choice) =>
      choice.provider === current.provider && choice.model === current.model));
  const choice = choices[modelIndex];
  const effortIndex = current?.effort === undefined || choice === undefined
    ? 0
    : Math.max(0, choice.efforts.indexOf(current.effort));
  return {
    state: {
      ...state,
      draft: "",
      helpOpen: false,
      notice: undefined,
      workerPicker: { step: "model", modelIndex, effortIndex, cwd, returnDraft, filter: "" },
    },
    // Opening the picker is the moment the offer has to be current: Fleet outlives a provider's
    // release, so a list read once at startup is a list that goes stale while the pane stays open.
    action: { type: "worker-capabilities" },
  };
}

/**
 * The rows the picker is showing: every model the providers advertise, narrowed by what was typed.
 *
 * Matched against the slug and the label together, and case-insensitively, because the operator
 * knows the model by whichever of the two they last read.
 */
export function pickerModelChoices(state: FleetState): readonly WorkerModelChoice[] {
  const filter = state.workerPicker?.filter.trim().toLowerCase() ?? "";
  if (filter === "") return state.workerModels.choices;
  return state.workerModels.choices.filter((choice) =>
    `${choice.model} ${choice.label} ${choice.provider}`.toLowerCase().includes(filter));
}

/**
 * Type a repository path into the composer row and register it.
 *
 * The draft is sent as typed rather than resolved here: only the broker runs beside the
 * repositories, and a path is not a project until git agrees it is one. Tab completes against the
 * filesystem, which is what makes a long worktree path bearable to type at all.
 *
 * An offered parent turns Enter into an answer: the operator named a worktree, the broker named the
 * repository above it, and pressing Enter takes that repository. Editing the draft withdraws the
 * offer, because the answer no longer belongs to the question.
 */
export function transitionProjectPrompt(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const prompt = state.projectPrompt!;
  if (key === "escape") {
    return { state: { ...state, projectPrompt: undefined, notice: undefined } };
  }
  if (key === "enter") {
    if (prompt.parentOffer !== undefined) {
      return {
        state: { ...state, projectPrompt: undefined, notice: undefined },
        action: { type: "project-add", path: prompt.parentOffer.root, acceptParent: true },
      };
    }
    const draft = prompt.draft.trim();
    if (draft === "") {
      return { state: { ...state, notice: "Project path cannot be empty", noticeTone: "error" } };
    }
    return {
      state: { ...state, projectPrompt: undefined, notice: undefined },
      action: { type: "project-add", path: expandPath(draft, composerCwd(state, snapshot)) },
    };
  }
  if (key === "tab") {
    return {
      state: { ...state, projectPrompt: { draft: prompt.draft }, notice: undefined },
      action: { type: "project-complete", draft: prompt.draft },
    };
  }
  if (key === "backspace") {
    return {
      state: {
        ...state,
        projectPrompt: { draft: [...prompt.draft].slice(0, -1).join("") },
        notice: undefined,
      },
    };
  }
  if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
    return {
      state: { ...state, projectPrompt: { draft: `${prompt.draft}${key}` }, notice: undefined },
    };
  }
  return { state };
}

/**
 * The composer while it is a shell. Enter runs the line where Fleet would spawn an agent, esc puts
 * the composer back to dispatching work and drops the transcript with it.
 */
export function transitionShellMode(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const shell = state.shellMode!;
  // Both leave, and both leave while a line is still running: the running guard below is about not
  // editing a draft mid-flight, not about trapping the operator inside a command that will not end.
  if (key === "escape" || key === "ctrl+g") {
    return { state: { ...state, shellMode: undefined, notice: undefined } };
  }
  // A line already in flight owns the shell. Typing into it would edit a draft the operator cannot
  // see the effect of, and Enter would race two commands into one cwd.
  if (shell.running === true) return { state };
  if (key === "enter") {
    const command = shell.draft.trim();
    if (command === "") return { state };
    return {
      state: {
        ...state,
        shellMode: {
          draft: "",
          running: true,
          // The echoed line, then the open row its output extends.
          transcript: [...capShellTranscript(shell.transcript), `! ${command}`, ""],
        },
        notice: undefined,
      },
      action: { type: "shell-run", command, cwd: composerCwd(state, snapshot) },
    };
  }
  if (key === "ctrl+j" || key === "alt+enter" || key === "shift+enter") {
    return { state: { ...state, shellMode: { ...shell, draft: `${shell.draft}\n` }, notice: undefined } };
  }
  if (key === "backspace") {
    return {
      state: {
        ...state,
        shellMode: { ...shell, draft: [...shell.draft].slice(0, -1).join("") },
        notice: undefined,
      },
    };
  }
  if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
    return {
      state: { ...state, shellMode: { ...shell, draft: `${shell.draft}${key}` }, notice: undefined },
    };
  }
  return { state };
}

/** How much shell output Fleet keeps. Older rows are dropped from the top, never from the tail. */
export const SHELL_TRANSCRIPT_LINES = 500;

export function capShellTranscript(transcript: readonly string[]): readonly string[] {
  return transcript.length <= SHELL_TRANSCRIPT_LINES
    ? transcript
    : transcript.slice(transcript.length - SHELL_TRANSCRIPT_LINES);
}

/**
 * Folds one chunk of shell output into the transcript. The last element is the row the shell has
 * left open, so a chunk that does not begin at a line boundary extends it rather than starting a
 * new one — output arrives in whatever sizes the pipe hands over, not in lines.
 */
export function appendShellOutput(
  transcript: readonly string[],
  chunk: string,
): readonly string[] {
  const text = stripTerminalControl(chunk)
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/\t/gu, "  ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  if (text === "") return transcript;
  const segments = text.split("\n");
  const lines = transcript.length === 0 ? [""] : [...transcript];
  lines[lines.length - 1] = `${lines[lines.length - 1] ?? ""}${segments[0] ?? ""}`;
  for (const segment of segments.slice(1)) lines.push(segment);
  return capShellTranscript(lines);
}

export function transitionWorkerPicker(state: FleetState, key: string): FleetTransition {
  const picker = state.workerPicker!;
  const choices = pickerModelChoices(state);
  if (key === "escape") {
    if (picker.step === "effort") {
      return { state: { ...state, workerPicker: { ...picker, step: "model" }, notice: undefined } };
    }
    return { state: { ...state, workerPicker: undefined, draft: picker.returnDraft, notice: undefined } };
  }
  if (key === "up" || key === "down") {
    const delta = key === "up" ? -1 : 1;
    if (picker.step === "model") {
      return {
        state: {
          ...state,
          workerPicker: {
            ...picker,
            modelIndex: boundedIndex(picker.modelIndex + delta, choices.length),
            effortIndex: 0,
          },
        },
      };
    }
    const selected = choices[picker.modelIndex];
    if (selected === undefined) return { state };
    return {
      state: {
        ...state,
        workerPicker: {
          ...picker,
          effortIndex: boundedIndex(picker.effortIndex + delta, selected.efforts.length),
        },
      },
    };
  }
  if (picker.step === "model" && (key === "backspace" || ([...key].length === 1 && key.charCodeAt(0) >= 0x20))) {
    const filter = key === "backspace"
      ? [...picker.filter].slice(0, -1).join("")
      : `${picker.filter}${key}`;
    // The cursor returns to the top of whatever the narrowed list now is; keeping an index across
    // a changed list points it at a model the operator never selected.
    return { state: { ...state, workerPicker: { ...picker, filter, modelIndex: 0, effortIndex: 0 } } };
  }
  if (key !== "enter") return { state };
  const choice = choices[picker.modelIndex];
  if (choice === undefined) {
    return {
      state: {
        ...state,
        notice: picker.filter === "" ? "No models are advertised" : `No model matches ${picker.filter}`,
        noticeTone: "error",
      },
    };
  }
  if (picker.step === "model") {
    return { state: { ...state, workerPicker: { ...picker, step: "effort", effortIndex: 0 } } };
  }
  const effort = choice.efforts[picker.effortIndex]!;
  const isolation = state.launchProfiles[picker.cwd]?.isolation;
  const profile: LaunchProfile = {
    provider: choice.provider,
    model: choice.model,
    ...(effort === "provider-managed" ? {} : { effort }),
    // Choosing a model is not choosing to share the operator's checkout again. Isolation is a
    // property of the folder, so it survives every re-pick of what runs in it.
    ...(isolation === undefined ? {} : { isolation }),
  };
  return {
    state: {
      ...state,
      workerPicker: undefined,
      draft: picker.returnDraft,
      launchProfiles: { ...state.launchProfiles, [picker.cwd]: profile },
      notice: `Selected ${choice.label} · ${friendlyEffort(effort)}`,
      noticeTone: "neutral",
    },
    action: { type: "profile", cwd: picker.cwd, profile },
  };
}

/**
 * Adopt a freshly read model catalog without moving the operator's selection.
 *
 * The catalog can land while the picker is open — that is the point of refreshing on open — so the
 * row under the cursor is re-found by provider and slug rather than by position. A model that is no
 * longer advertised has no row to keep, and the cursor goes to the top of the list that does exist.
 */
export function adoptWorkerModels(state: FleetState, workerModels: WorkerModelCatalog): FleetState {
  const picker = state.workerPicker;
  if (picker === undefined) return adoptOrchestratorModels(state, workerModels);
  const selected = pickerModelChoices(state)[picker.modelIndex];
  const next = { ...state, workerModels };
  if (selected === undefined) return next;
  const modelIndex = pickerModelChoices(next).findIndex((choice) =>
    choice.provider === selected.provider && choice.model === selected.model);
  return modelIndex === -1
    ? { ...next, workerPicker: { ...picker, step: "model", modelIndex: 0, effortIndex: 0 } }
    : { ...next, workerPicker: { ...picker, modelIndex } };
}

/**
 * Keep the selected row on screen. The model list is longer than a terminal — Cursor alone
 * contributes one entry per model-and-effort pair — so without a window the selection walks off the
 * bottom and the picker stops responding to the eye. Derived from the index rather than stored, so
 * there is no second cursor that can disagree with the selection.
 */
export function pickerScrollOffset(selectedIndex: number, total: number, visibleRows: number): number {
  const centered = selectedIndex - Math.floor(visibleRows / 2);
  return Math.max(0, Math.min(centered, total - visibleRows));
}

export function renderWorkerPicker(state: FleetState, options: ResolvedFleetRenderOptions): string {
  const picker = state.workerPicker!;
  const choices = pickerModelChoices(state);
  const choice = choices[picker.modelIndex];
  const lines = renderHeader([], state, options);
  lines.push("");
  let range = "";
  if (picker.step === "model") {
    lines.push(picker.filter === "" ? "Choose a model" : `Choose a model · ${picker.filter}`, "");
    // Named, not implied: a provider Fleet could not ask is showing a stored list, and the
    // operator has to be able to tell that from a list read a moment ago.
    for (const fallback of state.workerModels.fallbacks) {
      lines.push(paint(
        fit(`~ ${fallback.provider} models are a stored list — ${fallback.reason}`, options.width),
        "muted",
        options.color,
      ));
    }
    if (state.workerModels.fallbacks.length > 0) lines.push("");
    const total = choices.length;
    const visibleRows = Math.max(1, options.height - 3 - lines.length);
    const offset = pickerScrollOffset(picker.modelIndex, total, visibleRows);
    lines.push(...choices.slice(offset, offset + visibleRows).map((model, index) =>
      pickerRow(
        `${model.source === "fallback-catalog" ? "~ " : ""}${model.label}  ${paint(model.provider, "dim", options.color)}`,
        offset + index === picker.modelIndex,
        options.color,
      )));
    if (total === 0) lines.push(paint(`No model matches ${picker.filter}`, "muted", options.color));
    if (total > visibleRows) {
      range = ` · ${offset + 1}-${Math.min(total, offset + visibleRows)} of ${total}`;
    }
  } else if (choice !== undefined) {
    lines.push(`${choice.label} effort`, "");
    lines.push(...choice.efforts.map((effort, index) =>
      pickerRow(friendlyEffort(effort), index === picker.effortIndex, options.color)));
  }
  const heading = choice === undefined ? "No model selected" : choice.label;
  const footer = [
    paint("─".repeat(options.width), "dim", options.color),
    paint(fit(`${heading} · ${shortPath(picker.cwd, options.home)}`, options.width), "muted", options.color),
    paint(
      fit(
        `↑↓ select · enter apply/next · esc back${picker.step === "model" ? " · type to filter" : ""}${range}`,
        options.width,
      ),
      "dim",
      options.color,
    ),
  ];
  return renderCursorlessPickerFrame(lines, footer, options.height);
}
