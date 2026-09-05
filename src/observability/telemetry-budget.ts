import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";
export class TelemetryBudget {
  private day = "";
  private used = 0;
  private readonly seen = new Set<string>();
  dropped = 0;
  constructor(private readonly dailyCap: number, private readonly sampleRate = 0.1, private readonly now = () => Date.now(), private readonly stateFile?: string) {
    if (stateFile !== undefined) {
      try {
        const state = z.object({ day: z.string(), used: z.number().int().nonnegative(), seen: z.array(z.string()).max(100000) }).parse(JSON.parse(readFileSync(stateFile, "utf8")));
        this.day = state.day; this.used = state.used; for (const id of state.seen) this.seen.add(id);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (!Number.isSafeInteger(dailyCap) || dailyCap < 0 || dailyCap > 100000 || sampleRate < 0 || sampleRate > 1) throw new Error("TELEMETRY_BUDGET_INVALID");
  }
  admit(runId: string, eventId?: string): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.used = 0; this.seen.clear(); }
    if (eventId !== undefined && this.seen.has(eventId)) return false;
    const sample = createHash("sha256").update(runId).digest().readUInt32BE(0) / 2 ** 32;
    if (sample >= this.sampleRate || this.used >= this.dailyCap) { this.dropped += 1; return false; }
    this.used += 1;
    if (eventId !== undefined) this.seen.add(eventId);
    if (this.stateFile !== undefined) {
      mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
      const temporary = `${this.stateFile}.next`, handle = openSync(temporary, "w", 0o600);
      try { writeFileSync(handle, JSON.stringify({ day: this.day, used: this.used, seen: [...this.seen] })); fsyncSync(handle); }
      finally { closeSync(handle); }
      renameSync(temporary, this.stateFile);
    }
    return true;
  }
  health(): { day: string; used: number; cap: number; dropped: number } { return { day: this.day, used: this.used, cap: this.dailyCap, dropped: this.dropped }; }
}
