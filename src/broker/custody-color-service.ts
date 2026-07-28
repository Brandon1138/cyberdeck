import {
  allocateCustodyColorSlot,
  releaseCustodyColorSlot,
  type CustodyColorTable,
} from "../domain/custody-color.js";
import type { OwnershipSubject } from "../domain/worker-coordination.js";
import type { CustodyColorStore } from "../persistence/custody-color-store.js";

export interface CustodyColorSubjects {
  listSubjects(): OwnershipSubject[];
}

export interface CustodyColorServiceOptions {
  store: CustodyColorStore;
  /** Fading workers make a slot unavailable, so allocation has to see live subjects. */
  subjects?: CustodyColorSubjects;
  now?: () => string;
}

/**
 * Broker-side owner of the six custody color slots.
 *
 * Everything is event-driven: a slot moves when an orchestrator is bound or unbound, never on
 * a schedule. The table is cached after the first read and every mutation is serialized behind
 * one promise chain, so two orchestrators spawning at once cannot both be told they own a slot.
 */
export class CustodyColorService {
  private cached: CustodyColorTable | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CustodyColorServiceOptions) {}

  async table(): Promise<CustodyColorTable> {
    if (this.cached === undefined) this.cached = await this.options.store.read();
    return this.cached;
  }

  /** The spawning orchestrator's slot, or `undefined` when six live orchestrators already hold them. */
  async assign(controllerId: string): Promise<number | undefined> {
    return this.serialize(async () => {
      const allocation = allocateCustodyColorSlot({
        controllerId,
        table: await this.table(),
        subjects: this.options.subjects?.listSubjects() ?? [],
        now: this.now(),
      });
      if (allocation.slot === undefined) return undefined;
      this.cached = await this.options.store.write(allocation.table);
      return allocation.slot;
    });
  }

  async release(controllerId: string): Promise<void> {
    await this.serialize(async () => {
      const table = await this.table();
      const released = releaseCustodyColorSlot(table, controllerId, this.now());
      if (released === table) return;
      this.cached = await this.options.store.write(released);
    });
  }

  /** The slot each controller currently holds, for callers that only know controller identity. */
  async slotFor(controllerId: string): Promise<number | undefined> {
    return (await this.table()).find((entry) => entry.controllerId === controllerId)?.slot;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
