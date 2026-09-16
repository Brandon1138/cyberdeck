export interface VmAttribution {
  vmPhysicalBytes: number | null;
  ownedGuestBytes: number | null;
  foreignGuestBytes: number | null;
  residualVmBytes: number | null;
  attributedVmEstimateBytes: number | null;
  conservativeVmUpperBytes: number | null;
  uncertaintyReserveBytes: number;
  uncertainty: string[];
}
const valid = (x: number | null): x is number => x !== null && Number.isSafeInteger(x) && x >= 0;
/** Guest memory is an allocation view, never added to the VM physical total.
 * Residual VM memory is entirely charged to Cyberdeck (conservative overhead attribution).
 * Guest usage is not host resident memory: the estimate is explicitly not a physical measurement.
 * Admission must select the whole-VM upper bound until workload calibration approves an estimate.
 */
export function attributeVm(vmPhysicalBytes: number | null, ownedGuestBytes: number | null,
  foreignGuestBytes: number | null, uncertaintyReserveBytes: number): VmAttribution {
  if (!valid(uncertaintyReserveBytes)) throw new Error("VM_RESERVE_INVALID");
  const available = valid(vmPhysicalBytes) && valid(ownedGuestBytes) && valid(foreignGuestBytes);
  const residualVmBytes = available ? Math.max(0, vmPhysicalBytes - ownedGuestBytes - foreignGuestBytes) : null;
  return { vmPhysicalBytes: valid(vmPhysicalBytes) ? vmPhysicalBytes : null,
    ownedGuestBytes: valid(ownedGuestBytes) ? ownedGuestBytes : null,
    foreignGuestBytes: valid(foreignGuestBytes) ? foreignGuestBytes : null, residualVmBytes,
    attributedVmEstimateBytes: available ? Math.min(vmPhysicalBytes, ownedGuestBytes + residualVmBytes!) : null,
    conservativeVmUpperBytes: valid(vmPhysicalBytes) ? vmPhysicalBytes : null,
    uncertaintyReserveBytes,
    uncertainty: ["guest-usage-not-host-residency", "shared-vm-residual-fully-charged", ...(available ? [] : ["vm-or-guest-metrics-unavailable"])] };
}
