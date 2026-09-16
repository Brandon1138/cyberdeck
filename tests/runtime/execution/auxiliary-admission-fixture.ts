import { join } from "node:path";
import { ResourceAdmissionService } from "../../../src/orchestration/resource-admission-service.js";
import { ResourceReservationStore } from "../../../src/persistence/resource-reservation-store.js";
import { ResourceRuntimeBindingStore } from "../../../src/persistence/resource-runtime-binding-store.js";
import { ResourcePolicySchema, type ResourceReservation } from "../../../src/domain/resource-budget.js";

export async function realAuxiliaryAdmission(directory: string, installationId: string,
  verify: (reservation: ResourceReservation, evidence: string) => Promise<boolean>) {
  const store = await ResourceReservationStore.open(join(directory, "ledger"), installationId);
  const bindings = await ResourceRuntimeBindingStore.open(join(directory, "ledger"), () => store.assertOwner());
  const control = { available: true };
  const admission = new ResourceAdmissionService(store, ResourcePolicySchema.parse({ fixedBytes: 1024 ** 3,
    uncertainBytes: 512 * 1024 ** 2, controlMarginBytes: 512 * 1024 ** 2, maxPids: 2048 }),
  () => ({ observedAt: Date.now(), availableBytes: control.available ? 20 * 1024 ** 3 : 0,
    pressure: "normal", attributionComplete: true }), verify);
  await admission.reconcile(async () => true);
  return { admission, store, bindings, control };
}
