import type { FleetThread } from "./state.js";
import { threadStatus } from "./transport.js";

export const MASCOT_BLINK_INTERVAL_MS = 350;
export const MASCOT_BLINK_DURATION_MS = MASCOT_BLINK_INTERVAL_MS * 6;

function workingOrchestrators(threads: readonly FleetThread[]): Set<string> {
  return new Set(threads.flatMap((thread) =>
    thread.record.kind === "orchestrator" && threadStatus(thread) === "Working"
      ? [`${thread.record.id}:${thread.record.generation ?? 0}:${thread.record.pid}`]
      : []));
}

/** A brief start acknowledgement; sustained work never loops or extends the pulse. */
export class MascotActivityPulse {
  private working: Set<string>;
  private startedAt: number | undefined;

  constructor(threads: readonly FleetThread[]) {
    // Opening Fleet is not a new orchestrator start.
    this.working = workingOrchestrators(threads);
  }

  update(threads: readonly FleetThread[], now: number): {
    cursorVisible: boolean;
    nextFrameIn: number | undefined;
  } {
    const current = workingOrchestrators(threads);
    const started = [...current].some((identity) => !this.working.has(identity));
    this.working = current;
    if (this.startedAt !== undefined && now - this.startedAt >= MASCOT_BLINK_DURATION_MS) {
      this.startedAt = undefined;
    }
    if (started && this.startedAt === undefined) this.startedAt = now;
    if (this.startedAt === undefined) return { cursorVisible: true, nextFrameIn: undefined };
    const elapsed = Math.max(0, now - this.startedAt);
    return {
      cursorVisible: Math.floor(elapsed / MASCOT_BLINK_INTERVAL_MS) % 2 === 0,
      nextFrameIn: MASCOT_BLINK_INTERVAL_MS - elapsed % MASCOT_BLINK_INTERVAL_MS,
    };
  }
}
