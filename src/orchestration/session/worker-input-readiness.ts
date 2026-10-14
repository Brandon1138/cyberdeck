import type { ComposerObservation } from "../../domain/worker-truth.js";
import type { ProviderTerminalActivity } from "./worker-turn-ports.js";

/** Generation-local startup evidence. Native launch prompts may run before an idle TUI exists. */
export class WorkerInputReadiness {
  private observed = false;
  private startedAt: number;
  private timer?: ReturnType<typeof setTimeout>;
  starting = false;

  constructor(private readonly deadline?: {
    now(): number;
    windowSeconds: number;
    active(): boolean;
    expired(): void;
  }) { this.startedAt = this.now(); }

  private now(): number { return this.deadline?.now() ?? Date.now(); }
  get stalledForSeconds(): number | undefined {
    const elapsed = Math.floor((this.now() - this.startedAt) / 1_000);
    return this.pending && this.deadline !== undefined && elapsed >= this.deadline.windowSeconds ? elapsed : undefined;
  }

  release(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    delete this.timer;
  }

  private arm(): void {
    this.release();
    if (this.deadline === undefined || !this.pending || !this.deadline.active()) return;
    this.timer = setTimeout(() => {
      delete this.timer;
      if (this.pending && this.deadline?.active()) this.deadline.expired();
    }, Math.max(0, this.deadline.windowSeconds * 1_000 - (this.now() - this.startedAt)));
    this.timer.unref?.();
  }

  hold(): void { if (this.timer === undefined) this.arm(); }

  get pending(): boolean { return !this.observed || this.starting; }

  reset(): void {
    this.observed = false;
    this.starting = true;
    this.startedAt = this.now();
    this.arm();
  }

  finishInitialization(initialPromptInFlight: boolean): void {
    // A prompt-free launch (including Cursor's suppressed setup turn) must not bank startup
    // repainting as a model completion. Native argv/deferred prompts keep their first real turn.
    this.starting = !initialPromptInFlight;
    this.arm();
  }

  observe(activity: ProviderTerminalActivity, composer: ComposerObservation): void {
    if (composer.inputReady !== true || activity === "working" || composer.modalOpen || composer.occupied) return;
    this.observed = true;
    this.starting = false;
    this.release();
  }
}
