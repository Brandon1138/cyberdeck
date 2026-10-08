const HOUR_MS = 60 * 60 * 1000;

interface WakeWindow {
  enqueuedAt: number[];
  zeroWindowStart?: number;
}

/** Rolling wake attempts are process-local; a broker restart resets the budget. */
export class OrchestratorNotificationWakeBudget {
  private readonly windows = new Map<string, WakeWindow>();

  check(controllerId: string, maximum: number, now: number): {
    allowed: boolean; windowStartIso?: string; resumeAt?: number;
  } {
    const window = this.windows.get(controllerId) ?? { enqueuedAt: [] };
    this.windows.set(controllerId, window);
    window.enqueuedAt = window.enqueuedAt.filter((at) => at > now - HOUR_MS);
    if (maximum > 0 && window.enqueuedAt.length < maximum) return { allowed: true };
    if (maximum === 0 && (window.zeroWindowStart === undefined || now >= window.zeroWindowStart + HOUR_MS)) {
      window.zeroWindowStart = now;
    }
    // For a decreased policy ceiling, enough oldest attempts must expire to admit one more.
    const start = maximum === 0 ? window.zeroWindowStart!
      : window.enqueuedAt[window.enqueuedAt.length - maximum]!;
    return { allowed: false, windowStartIso: new Date(start).toISOString(), resumeAt: start + HOUR_MS };
  }

  record(controllerId: string, now: number): void {
    const window = this.windows.get(controllerId) ?? { enqueuedAt: [] };
    window.enqueuedAt.push(now);
    this.windows.set(controllerId, window);
  }
}
