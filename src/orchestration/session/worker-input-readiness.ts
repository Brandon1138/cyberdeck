import type { ComposerObservation } from "../../domain/worker-truth.js";
import type { ProviderTerminalActivity } from "./worker-turn-ports.js";

/** Generation-local startup evidence. Native launch prompts may run before an idle TUI exists. */
export class WorkerInputReadiness {
  private observed = false;
  starting = false;

  get pending(): boolean { return !this.observed || this.starting; }

  reset(): void {
    this.observed = false;
    this.starting = true;
  }

  finishInitialization(initialPromptInFlight: boolean): void {
    // A prompt-free launch (including Cursor's suppressed setup turn) must not bank startup
    // repainting as a model completion. Native argv/deferred prompts keep their first real turn.
    this.starting = !initialPromptInFlight;
  }

  observe(activity: ProviderTerminalActivity, composer: ComposerObservation): void {
    if (composer.inputReady !== true || activity === "working" || composer.modalOpen || composer.occupied) return;
    this.observed = true;
    this.starting = false;
  }
}
