/** Only sanitized envelopes enter this bounded, nonblocking downstream queue. */
export class BoundedExportQueue {
  private readonly queue: string[] = [];
  private pumping = false;
  private closed = false;
  private dropped = 0;
  private queueDropped = 0;
  private transportFailed = 0;
  private accepted = 0;
  private lastFailure: "timeout-or-network" | "rate-limited" | "server-error" | "rejected" | null = null;
  private retryAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly send: (body: string) => Promise<{ status: number }>) {}
  enqueue(body: string): void {
    if (this.closed || this.queue.length >= 100) { this.dropped++; this.queueDropped++; return; }
    this.queue.push(body); void this.pump();
  }
  health(): { queued: number; dropped: number } { return { queued: this.queue.length, dropped: this.dropped }; }
  transportHealth() { return { queueDropped: this.queueDropped, transportFailed: this.transportFailed,
    accepted: this.accepted, lastFailure: this.lastFailure }; }
  close(): void { this.closed = true; clearTimeout(this.retryTimer); }
  async pump(): Promise<void> {
    if (this.pumping || Date.now() < this.retryAt || this.closed) return;
    this.pumping = true;
    try {
      for (let sent = 0; sent < 10 && this.queue.length > 0 && !this.closed; sent += 1) {
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const response = await Promise.race([this.send(this.queue[0]!), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("SINK_TIMEOUT")), 2000);
          })]).finally(() => clearTimeout(timer));
          if (response.status === 429 || response.status >= 500) {
            this.transportFailed++; this.lastFailure = response.status === 429 ? "rate-limited" : "server-error";
            this.retryAt = Date.now() + 60_000; break;
          }
          this.queue.shift();
          if (response.status >= 300 || response.status < 200) { this.dropped++; this.transportFailed++; this.lastFailure = "rejected"; }
          else { this.accepted++; this.lastFailure = null; }
        } catch { this.transportFailed++; this.lastFailure = "timeout-or-network"; this.retryAt = Date.now() + 60_000; break; }
      }
    } finally {
      this.pumping = false;
      if (this.queue.length && !this.closed) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { void this.pump(); }, Math.max(1, this.retryAt - Date.now())).unref();
      }
    }
  }
}
