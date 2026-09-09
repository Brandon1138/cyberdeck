/** Only sanitized envelopes enter this bounded, nonblocking downstream queue. */
export class BoundedExportQueue {
  private readonly queue: string[] = [];
  private pumping = false;
  private closed = false;
  private dropped = 0;
  private retryAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly send: (body: string) => Promise<{ status: number }>) {}
  enqueue(body: string): void {
    if (this.closed || this.queue.length >= 100) { this.dropped++; return; }
    this.queue.push(body); void this.pump();
  }
  health(): { queued: number; dropped: number } { return { queued: this.queue.length, dropped: this.dropped }; }
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
          if (response.status === 429 || response.status >= 500) { this.retryAt = Date.now() + 60_000; break; }
          this.queue.shift(); if (response.status >= 400) this.dropped++;
        } catch { this.retryAt = Date.now() + 60_000; break; }
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
