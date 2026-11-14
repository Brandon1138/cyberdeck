import { DELIVERY_HOLD_DETAIL, deliveryHoldFailed, type DeliveryHoldReason } from "../../domain/worker-truth.js";
import type { InstructionDelivery } from "./session-ports.js";

/** Serialize admission until the write finishes, and reconcile old receipts before reserving input. */
export class WorkerInputAdmission {
  private busy = false;
  private contended = false;
  constructor(private readonly host: {
    active(): boolean; epoch(): number; revision(): number; fence(): void;
    hold(): DeliveryHoldReason | undefined; capture(): Promise<void> | undefined;
    needsRestore(): boolean; restore(): Promise<boolean>; reconcile(): Promise<boolean>;
    released(): void;
  }) {}

  async run(render: () => Promise<InstructionDelivery>, refuse: (reason: DeliveryHoldReason) => Promise<InstructionDelivery>): Promise<InstructionDelivery> {
    if (this.busy) { this.contended = true; return refuse("admission-in-progress"); }
    if (!this.host.active()) return refuse("worker-terminal");
    const hold = this.host.hold();
    if (hold !== undefined) return refuse(hold);
    this.busy = true;
    this.host.fence();
    const epoch = this.host.epoch(), revision = this.host.revision();
    try {
      const pending = this.host.capture();
      if (pending !== undefined) await pending;
      try {
        if (this.host.needsRestore() && !await this.host.restore()) return refuse("completion-restore-pending");
      } catch { return refuse("completion-restore-pending"); }
      // A durable ledger may lag the native source. Bank unseen older receipts before assigning
      // expectedTurn, rather than letting those receipts answer the instruction about to be written.
      try {
        if (!await this.host.reconcile()) return refuse("completion-reconcile-pending");
      } catch { return refuse(this.host.hold() ?? "completion-reconcile-pending"); }
      if (!this.host.active()) return refuse("worker-terminal");
      if (this.host.epoch() !== epoch || this.host.revision() !== revision || this.host.needsRestore()) return refuse("observation-changed");
      const rechecked = this.host.hold();
      return rechecked === undefined ? await render() : refuse(rechecked);
    } finally {
      this.busy = false;
      if (this.contended) { this.contended = false; this.host.released(); }
    }
  }
}

export async function heldInstructionDelivery(hold: DeliveryHoldReason,
  source: "orchestrator" | "worker" | "broker", instructionId: string | undefined,
  append: (data: Record<string, unknown>) => Promise<unknown>, event: (data: Record<string, unknown>) => Promise<unknown>): Promise<InstructionDelivery> {
  const at = new Date().toISOString();
  const state = deliveryHoldFailed(hold) ? "undelivered" : "queued";
  await append({ instructionState: state, holdReason: hold, detail: DELIVERY_HOLD_DETAIL[hold], source,
    ...(instructionId === undefined ? {} : { instructionId }) });
  await event({ bytes: 0, source, held: hold, detail: DELIVERY_HOLD_DETAIL[hold] });
  return { state, hold, detail: DELIVERY_HOLD_DETAIL[hold], at };
}

/** Terminal input refusal shares the admission surface, without creating a target reservation. */
export async function terminalInstructionDelivery(executionState: string,
  source: "orchestrator" | "worker" | "broker", instructionId: string | undefined,
  append: (data: Record<string, unknown>) => Promise<unknown>): Promise<InstructionDelivery> {
  const at = new Date().toISOString();
  await append({ instructionState: "undelivered", holdReason: "worker-terminal", executionState, source,
    ...(instructionId === undefined ? {} : { instructionId }) });
  return { state: "undelivered", hold: "worker-terminal", detail: DELIVERY_HOLD_DETAIL["worker-terminal"], at };
}
