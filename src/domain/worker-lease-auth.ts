import { createHash } from "node:crypto";
import type { ControllerIdentity, OwnershipSubject } from "./worker-coordination.js";

export function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function isControlled(subject: OwnershipSubject): boolean {
  return (subject.lease.state === "active" || subject.lease.state === "contested") && subject.lease.controller !== undefined;
}
/** One fencing predicate, shared by all canonical coordination operations. */
export function workerLeaseAuthCode(subject: OwnershipSubject, controller: ControllerIdentity, token: string,
  leaseVersion: number | undefined, expired: boolean): "OWNERSHIP_LOST" | "LEASE_TOKEN_INVALID" | "LEASE_EXPIRED" | undefined {
  if (expired || subject.lease.state === "orphaned") return "LEASE_EXPIRED";
  if (!isControlled(subject) || subject.lease.controller?.controllerId !== controller.controllerId
    || (leaseVersion !== undefined && subject.lease.version !== leaseVersion)) return "OWNERSHIP_LOST";
  if (subject.lease.tokenHash === undefined || subject.lease.tokenHash !== hashToken(token)) return "LEASE_TOKEN_INVALID";
  return undefined;
}
