import type { WorkerModelCatalog } from "./runtime-options.js";
import type { FleetState } from "./state.js";

/** A catalog refresh must preserve both the model identity and the selected effort. */
export function adoptOrchestratorModels(state: FleetState, workerModels: WorkerModelCatalog): FleetState {
  const next = { ...state, workerModels };
  const picker = state.orchestratorPicker;
  if (picker === undefined || (picker.step === "target" && picker.focus.kind === "existing")) return next;
  const index = picker.step === "effort" ? picker.modelIndex
    : picker.focus.kind === "profile" ? picker.focus.modelIndex : -1;
  const selected = state.workerModels.orchestratorChoices[index];
  const modelIndex = workerModels.orchestratorChoices.findIndex((choice) =>
    choice.provider.provider === selected?.provider.provider && choice.model === selected?.model);
  if (modelIndex === -1) {
    return {
      ...next,
      orchestratorPicker: { step: "target", focus: { kind: "profile", modelIndex: 0 } },
      notice: "The selected orchestrator model is no longer listed; choose a model again",
      noticeTone: "warning",
    };
  }
  if (picker.step === "target") {
    return { ...next, orchestratorPicker: { ...picker, focus: { kind: "profile", modelIndex } } };
  }
  const effort = selected!.provider.efforts[picker.effortIndex];
  const effortIndex = workerModels.orchestratorChoices[modelIndex]!.provider.efforts
    .findIndex((candidate) => candidate === effort);
  return effortIndex === -1
    ? {
      ...next,
      orchestratorPicker: { step: "target", focus: { kind: "profile", modelIndex } },
      notice: "The selected reasoning effort is no longer listed; choose an effort again",
      noticeTone: "warning",
    }
    : { ...next, orchestratorPicker: { ...picker, modelIndex, effortIndex } };
}
