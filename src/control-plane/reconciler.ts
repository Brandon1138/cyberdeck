import type { JobControlPlane } from "./job-control-plane.js";
import type { WorktreeLeaseManager } from "./worktree-lease-manager.js";

/**
 * A supervised runtime that can vouch for the jobs it is currently executing. Adapters expose this
 * narrow read-only view; the reconciler never asks a runtime to start, stop, or retry anything.
 */
export interface RuntimeInspector {
  readonly provider: string;
  activeJobIds(): readonly string[];
}

/** Read-only artifact inventory used to spot stored content no job references any more. */
export interface ArtifactInspector {
  listIds(): Promise<string[]>;
}

export type ReconciliationFindingKind =
  | "unverifiable-in-flight-job"
  | "orphaned-runtime"
  | "orphaned-lease"
  | "orphaned-artifact"
  | "pending-report-back";

export interface ReconciliationFinding {
  kind: ReconciliationFindingKind;
  subject: string;
  detail: string;
  /** True when only a human can safely decide what happens next. */
  operatorActionRequired: boolean;
  suggestedAction: string;
  /** Always false: reconciliation never deletes, kills, resumes, or retries anything. */
  destructive: false;
}

export interface ReconciliationReport {
  /** Null only for a composed broker whose control-plane reconciliation pass has not run. */
  reconciledAt: string | null;
  findings: ReconciliationFinding[];
  quarantinedJobIds: string[];
}

export interface ControlPlaneReconcilerOptions {
  controlPlane: JobControlPlane;
  leases: WorktreeLeaseManager;
  runtimes?: RuntimeInspector[];
  artifacts?: ArtifactInspector;
  now?: () => string;
}

/**
 * Compares durable control-plane state against supervised runtime, lease, artifact, and report-back
 * state after a startup or a disconnect.
 *
 * The pass is deliberately conservative and **fails closed**:
 *
 * - It never dispatches, completes, acknowledges, or retries anything, so no work is duplicated.
 * - In-flight work no runtime claims is *quarantined* (moved to `interrupted` with a reason), never
 *   resumed and never declared successful.
 * - Only leases the A4 rules prove stale (expired) are fenced; a lease whose owner cannot be
 *   verified stays held and blocking until an operator resolves it explicitly.
 * - Everything ambiguous — orphaned runtimes, orphaned leases, orphaned artifacts — is reported as a
 *   structured finding requiring operator action rather than cleaned up automatically.
 *
 * Running it twice is safe: the second pass observes the same state and changes nothing.
 */
export class ControlPlaneReconciler {
  constructor(private readonly options: ControlPlaneReconcilerOptions) {}

  async reconcile(): Promise<ReconciliationReport> {
    const findings: ReconciliationFinding[] = [];
    const quarantinedJobIds: string[] = [];

    const claimed = new Set<string>();
    for (const runtime of this.options.runtimes ?? []) {
      for (const jobId of runtime.activeJobIds()) claimed.add(jobId);
    }

    const snapshots = this.options.controlPlane.listJobs();
    const known = new Set<string>(snapshots.map((snapshot) => snapshot.record.id));

    for (const snapshot of snapshots) {
      const { id, lifecycle } = snapshot.record;
      if (lifecycle.status === "settled") continue;
      if (lifecycle.status !== "interrupted" && claimed.has(id)) continue;

      if (lifecycle.status !== "interrupted") {
        const quarantined = await this.options.controlPlane.quarantine(
          id,
          "Reconciliation could not verify a supervised runtime for this in-flight job",
        );
        if (quarantined) quarantinedJobIds.push(id);
      }
      findings.push({
        kind: "unverifiable-in-flight-job",
        subject: id,
        detail: `Job ${id} was ${lifecycle.status} with no runtime able to vouch for it`,
        operatorActionRequired: true,
        suggestedAction:
          "Inspect the job and its repository, then explicitly resubmit or abandon it. Cyberdeck will not retry it automatically.",
        destructive: false,
      });
    }

    for (const jobId of claimed) {
      if (known.has(jobId)) continue;
      findings.push({
        kind: "orphaned-runtime",
        subject: jobId,
        detail: `A supervised runtime claims job ${jobId}, which the control plane has no record of`,
        operatorActionRequired: true,
        suggestedAction:
          "Inspect and stop the runtime manually; Cyberdeck refuses to kill a process it cannot correlate.",
        destructive: false,
      });
    }

    // A4 owns the staleness rules: recovery releases only provably expired leases and marks the
    // rest orphaned/blocking. The reconciler reports that evidence; it invents no extra release.
    const orphanEvidence = await this.options.leases.recover();
    for (const orphan of orphanEvidence) {
      findings.push({
        kind: "orphaned-lease",
        subject: orphan.leaseId,
        detail: `Lease ${orphan.leaseId} on ${orphan.canonicalKey} is held by unverifiable owner ${orphan.ownerKey}`,
        operatorActionRequired: true,
        suggestedAction: orphan.guidance,
        destructive: false,
      });
    }

    for (const reportBack of this.options.controlPlane.listReportBacks()) {
      if (reportBack.state === "delivered") continue;
      findings.push({
        kind: "pending-report-back",
        subject: reportBack.jobId,
        detail: `Report-back for job ${reportBack.jobId} is ${reportBack.state} after ${reportBack.attempts} attempt(s)`,
        operatorActionRequired: false,
        suggestedAction:
          "The parent must acknowledge the existing handoff; reconciliation never re-delivers or self-acknowledges it.",
        destructive: false,
      });
    }

    if (this.options.artifacts !== undefined) {
      const referenced = new Set<string>();
      for (const snapshot of snapshots) {
        const lifecycle = snapshot.record.lifecycle;
        if (lifecycle.status !== "settled" || !("artifacts" in lifecycle.result)) continue;
        for (const artifact of lifecycle.result.artifacts) referenced.add(artifact.id);
      }
      for (const artifactId of await this.options.artifacts.listIds()) {
        if (referenced.has(artifactId)) continue;
        findings.push({
          kind: "orphaned-artifact",
          subject: artifactId,
          detail: `Stored artifact ${artifactId} is referenced by no known job result`,
          operatorActionRequired: true,
          suggestedAction:
            "Inspect the artifact before removing it; Cyberdeck performs no destructive artifact cleanup.",
          destructive: false,
        });
      }
    }

    // Fencing itself is performed by the lease manager's recovery under the A4 staleness rules: a
    // provably expired lease is released there and consequently never appears as an orphan above.
    return {
      reconciledAt: this.options.now?.() ?? new Date().toISOString(),
      findings,
      quarantinedJobIds,
    };
  }
}
