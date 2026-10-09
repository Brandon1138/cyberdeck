import type { ControllerIdentity, ControllerLiveness, OwnershipSubject } from "../domain/worker-coordination.js";

export interface CurrentLeaseObservation {
  sessionId: string;
  leaseVersion: number;
  leaseExpiresAt: string;
  controllerId: string;
}

export function controllerLiveness(
  subject: OwnershipSubject,
  observations: ReadonlyMap<string, ControllerLiveness>,
): ControllerLiveness | undefined {
  return subject.lease.controller === undefined ? undefined : observations.get(subject.lease.controller.controllerId);
}

/** Internal execution-renewal fence compares durable fields, never a moving read horizon. */
export function storedLeaseMatches(subject: OwnershipSubject | undefined, input: CurrentLeaseObservation, now: string): boolean {
  const lease = subject?.lease;
  return lease?.state === "active" && lease.version === input.leaseVersion
    && lease.expiresAt === input.leaseExpiresAt && lease.controller?.controllerId === input.controllerId
    && Date.parse(lease.expiresAt) > Date.parse(now);
}

/** A client call cannot override a broker-owned session's death or its fixed grace deadline. */
export function heartbeatObservation(
  controller: ControllerIdentity,
  observed: ControllerLiveness | undefined,
  observedAt: string,
  reason: string,
): ControllerLiveness {
  return observed?.session === undefined ? { controller, state: "connected", observedAt, reason } : observed;
}

export function isControlled(subject: OwnershipSubject): boolean {
  return (subject.lease.state === "active" || subject.lease.state === "contested")
    && subject.lease.controller !== undefined;
}

export function leaseHasExpired(
  subject: OwnershipSubject,
  observed: ControllerLiveness | undefined,
  now: string,
  gracePeriodMs: number,
): boolean {
  if (!isControlled(subject)) return false;
  const disconnectedPastGrace = observed?.state === "disconnected"
    && Date.parse(now) >= Date.parse(observed.observedAt) + gracePeriodMs;
  // Only broker session observations vouch for quiet owners. External clients still need calls.
  if (observed?.session !== undefined) return disconnectedPastGrace;
  return Date.parse(now) >= Date.parse(subject.lease.expiresAt) || disconnectedPastGrace;
}

/** Pure read projection: no timer, journal writes, token rotation or fabricated renewal. */
export function observedLeaseCopy(
  subject: OwnershipSubject,
  observed: ControllerLiveness | undefined,
  now: string,
  leaseDurationMs: number,
  gracePeriodMs: number,
): OwnershipSubject {
  if (isControlled(subject) && observed?.session !== undefined) {
    // A living session has no heartbeat deadline. Project a fresh horizon for consumers that
    // require expiresAt; confirmed death replaces it with the fixed orphan-grace deadline.
    const expiresAt = observed.state === "connected"
      ? Date.parse(now) + leaseDurationMs
      : Date.parse(observed.observedAt) + gracePeriodMs;
    subject = { ...subject, lease: { ...subject.lease, expiresAt: new Date(expiresAt).toISOString() } };
  }
  if (!leaseHasExpired(subject, observed, now, gracePeriodMs)) return subject;
  return {
    ...subject,
    lease: {
      ...subject.lease,
      state: "orphaned",
      tokenHash: undefined,
      orphanedAt: now,
      reason: "lease expired after broker-observed liveness/heartbeat deadline",
      contest: undefined,
    },
    updatedAt: now,
  };
}
