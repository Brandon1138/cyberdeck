/** Physical capacity reservation; queue membership never counts as a running slot. */
export class ExecutionSlotScheduler {
  private readonly held = new Set<string>();
  private readonly pending = new Map<string, { resolve: (release: () => void) => void; reject: (error: Error) => void }>();
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("EXECUTION_CAPACITY_INVALID");
  }
  reserve(id: string): Promise<() => void> {
    if (this.held.has(id) || this.pending.has(id)) return Promise.reject(new Error("EXECUTION_SLOT_ALREADY_RESERVED"));
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.drain(); });
  }
  cancel(id: string): void {
    const queued = this.pending.get(id);
    if (queued) { this.pending.delete(id); queued.reject(new Error("EXECUTION_QUEUE_CANCELLED")); }
  }
  /** Recovery must call this before admission opens, using verified running resources. */
  recover(ids: readonly string[]): void {
    if (this.held.size || this.pending.size) throw new Error("EXECUTION_SCHEDULER_ALREADY_ACTIVE");
    for (const id of ids) this.held.add(id);
  }
  release(id: string): void { if (this.held.delete(id)) this.drain(); }
  snapshot(): { running: string[]; queued: string[]; capacity: number } {
    return { running: [...this.held], queued: [...this.pending.keys()], capacity: this.capacity };
  }
  private drain(): void {
    while (this.held.size < this.capacity && this.pending.size > 0) {
      const [id, waiter] = this.pending.entries().next().value!;
      this.pending.delete(id); this.held.add(id);
      let released = false;
      waiter.resolve(() => { if (!released) { released = true; this.release(id); } });
    }
  }
}
