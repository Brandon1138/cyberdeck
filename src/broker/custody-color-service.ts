import {
  allocateCustodyColorSlot,
  reconcileCustodyColorTable,
  releaseCustodyColorSlot,
  type CustodyColorTable,
} from "../domain/custody-color.js";
import { orchestratorControllerId } from "../domain/orchestrator.js";
import type { OwnershipSubject } from "../domain/worker-coordination.js";
import type { CustodyColorStore } from "../persistence/custody-color-store.js";

export interface CustodyColorSubjects {
  listSubjects(): OwnershipSubject[];
}

export interface CustodyColorLiveBindings {
  list(): Promise<readonly { key: string }[]>;
}

export interface CustodyColorServiceOptions {
  store: CustodyColorStore;
  /** Fading workers make a slot unavailable, so allocation has to see live subjects. */
  subjects?: CustodyColorSubjects;
  /**
   * Live orchestrator bindings, checked once on load to reclaim a slot whose holder crashed
   * or was SIGKILLed rather than released gracefully. Absent in tests that do not care.
   */
  orchestratorBindings?: CustodyColorLiveBindings;
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
    if (this.cached === undefined) this.cached = await this.load();
    return this.cached;
  }

  private async load(): Promise<CustodyColorTable> {
    const table = await this.options.store.read();
    if (this.options.orchestratorBindings === undefined) return table;
    const live = new Set(
      (await this.options.orchestratorBindings.list())
        .map((binding) => orchestratorControllerId(binding.key)),
    );
    const reconciled = reconcileCustodyColorTable(table, live, this.now());
    return reconciled === table ? table : await this.options.store.write(reconciled);
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
