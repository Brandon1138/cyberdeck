import type { WorkerTruth } from "./worker-truth.js";

/** Presentation history is never input readiness, delivery authority, or task success. */
export class WorkerTruthObservation {
  private generation: number | undefined;
  private last: WorkerTruth["lastConfirmed"];
  observe(truth: WorkerTruth, generation: number | undefined, now: number): WorkerTruth {
    if (generation !== this.generation) { this.last = undefined; this.generation = generation; }
    if (truth.state !== "unknown") {
      this.last = { state: truth.state, at: new Date(now).toISOString() };
      return truth;
    }
    return this.last === undefined ? truth : { ...truth, lastConfirmed: this.last,
      detail: `Activity observation unavailable; last confirmed ${this.last.state} at ${this.last.at}` };
  }
}
