import { randomUUID } from "node:crypto";
import type { ConcurrencyDeclaration } from "../domain/budget.js";
import { evaluateClaudeLaunchSafety } from "../domain/policy.js";

/** One queued job competing for a slot. Identity only — the scheduler never reads an instruction. */
export interface AdmissionCandidate {
  jobId: string;
  provider: string;
  /** Canonical repository/working-directory key. Grouping only; it proves no exclusive access. */
  repositoryKey: string;
  enqueuedAt: string;
  model?: string;
}

/**
 * A queued candidate plus the arrival order the scheduler itself observed. `sequence` is assigned by
 * {@link AdmissionScheduler.enqueue} and is never supplied by a caller: it is the scheduler's own
 * count of enqueues, so it cannot be spoofed and cannot be skewed by a clock.
 */
interface QueuedEntry extends AdmissionCandidate {
  sequence: number;
}

/** Proof that exactly one concurrency slot is held for exactly one job. */
export interface SlotReservation {
  reservationId: string;
  jobId: string;
  provider: string;
  repositoryKey: string;
  reservedAt: string;
}

export type AdmissionBlockReason =
  | "MAX_CONCURRENT_JOBS"
  | "MAX_CONCURRENT_PER_PROVIDER"
  | "MAX_CONCURRENT_PER_REPOSITORY"
  | "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_MODEL";

export interface QueuedEntryView {
  jobId: string;
  provider: string;
  repositoryKey: string;
  enqueuedAt: string;
  blockedBy: AdmissionBlockReason;
}

export interface AdmissionSnapshot {
  limits: ConcurrencyDeclaration;
  admissionOpen: boolean;
  reservations: SlotReservation[];
  queued: QueuedEntryView[];
}

export interface AdmissionSchedulerOptions {
  limits: ConcurrencyDeclaration;
  now?: () => string;
  idFactory?: () => string;
}

/**
 * Neutral admission control over durable jobs.
 *
 * **Ordering.** The queue is scanned in a total, deterministic order: ascending `enqueuedAt`, then
 * ascending admission sequence — the scheduler's own monotonic count of enqueues — and only then
 * ascending `jobId` as a defensive final fallback. The sequence is what makes the order *fair*
 * rather than merely total: `enqueuedAt` is a wall clock with millisecond resolution, so two jobs
 * submitted in the same millisecond tie, and tie-breaking those by `jobId` sorts random UUIDs, i.e.
 * releases them in an order unrelated to the order they arrived in. Sequence is assigned at enqueue,
 * so a tie always releases in arrival order, under a fake clock and a real one alike.
 *
 * **Starvation resistance.** `admitNext` returns the first *eligible* candidate in that order, so a
 * younger job may pass an older one — but only when the older one's own provider or repository
 * bucket is saturated. Because the scan order is global FIFO, the first member of any bucket the
 * scan reaches is that bucket's oldest waiting job, so ordering *within* a bucket is strictly FIFO
 * and no job can be passed over indefinitely: every admitted job holds exactly one slot and releases
 * it on every terminal path, so each bucket drains and its oldest member is admitted next.
 *
 * **Neutrality.** A blocked job is never admitted under a different provider, model, or repository,
 * and spare capacity never causes a substitution. The scheduler only gates the provider the caller
 * explicitly requested.
 *
 * **Launch safety.** Free capacity is not a reason to start a live Claude job whose model is omitted
 * is omitted. Those candidates are held (never admitted) and surfaced as blocked, so an unknown
 * model stays unsafe rather than being converted into a default. Explicit Fable authorization is
 * enforced at the operator/delegation boundary, not by concurrency admission.
 */
export class AdmissionScheduler {
  private readonly queue = new Map<string, QueuedEntry>();
  private readonly reservations = new Map<string, SlotReservation>();
  /**
   * Monotonic enqueue counter backing the ordering tie-break. It is deliberately per-process and not
   * persisted: the queue itself is in-memory only, and recovery interrupts every job that was still
   * queued rather than re-enqueuing it (see `JobControlPlane.recover`), so a restart starts from an
   * empty queue and has nothing whose arrival order a durable counter could preserve. If a queued
   * job ever becomes recoverable, the recovered sequence must be restored with it — or, better, the
   * counter seeded past the highest recovered value so a fresh enqueue never ties an old one.
   */
  private sequence = 0;
  /**
   * The startup gate. It begins **closed**, so persistence recovery and reconciliation must finish
   * (and explicitly open admission) before any job can be dispatched, and shutdown can stop new
   * work without racing the drain.
   */
  private open = false;

  constructor(private readonly options: AdmissionSchedulerOptions) {}

  get activeCount(): number {
    return this.reservations.size;
  }

  get admissionOpen(): boolean {
    return this.open;
  }

  openAdmission(): void {
    this.open = true;
  }

  closeAdmission(): void {
    this.open = false;
  }

  /**
   * Queue a candidate and stamp it with the next admission sequence. Re-enqueuing a known job id is
   * a no-op, so a retry cannot double-queue and cannot move a waiting job to the back of its own
   * timestamp tie by consuming a fresh sequence.
   */
  enqueue(candidate: AdmissionCandidate): void {
    if (this.queue.has(candidate.jobId) || this.reservations.has(candidate.jobId)) return;
    this.sequence += 1;
    this.queue.set(candidate.jobId, { ...candidate, sequence: this.sequence });
  }

  /** Reserve one slot for the oldest eligible candidate, or nothing when none is admissible. */
  admitNext(): SlotReservation | undefined {
    if (!this.open) return undefined;
    for (const candidate of this.ordered()) {
      if (this.blockReason(candidate) !== undefined) continue;
      const reservation: SlotReservation = {
        reservationId: this.options.idFactory?.() ?? randomUUID(),
        jobId: candidate.jobId,
        provider: candidate.provider,
        repositoryKey: candidate.repositoryKey,
        reservedAt: this.now(),
      };
      this.queue.delete(candidate.jobId);
      this.reservations.set(candidate.jobId, reservation);
      return reservation;
    }
    return undefined;
  }

  /**
   * Release the slot held by a job. Returns `true` exactly once per reservation, so a terminal
   * transition that races a failed-to-launch cleanup cannot return the same slot twice.
   */
  release(jobId: string): boolean {
    return this.reservations.delete(jobId);
  }

  /** Drop a still-queued job (cancelled or rejected before launch). It holds no slot to release. */
  withdraw(jobId: string): boolean {
    return this.queue.delete(jobId);
  }

  isQueued(jobId: string): boolean {
    return this.queue.has(jobId);
  }

  holdsSlot(jobId: string): boolean {
    return this.reservations.has(jobId);
  }

  snapshot(): AdmissionSnapshot {
    return {
      limits: { ...this.options.limits },
      admissionOpen: this.open,
      reservations: [...this.reservations.values()].map((reservation) => ({ ...reservation })),
      queued: this.ordered().map((candidate) => ({
        jobId: candidate.jobId,
        provider: candidate.provider,
        repositoryKey: candidate.repositoryKey,
        enqueuedAt: candidate.enqueuedAt,
        blockedBy: this.blockReason(candidate) ?? "MAX_CONCURRENT_JOBS",
      })),
    };
  }

  private ordered(): QueuedEntry[] {
    return [...this.queue.values()].sort((left, right) => {
      if (left.enqueuedAt !== right.enqueuedAt) {
        return left.enqueuedAt.localeCompare(right.enqueuedAt);
      }
      // Same millisecond: arrival order decides, never the shape of a random job id.
      if (left.sequence !== right.sequence) return left.sequence - right.sequence;
      // Unreachable through `enqueue` (every entry holds a distinct sequence); kept so the
      // comparator is a total order on any two entries rather than returning 0 for distinct jobs.
      return left.jobId.localeCompare(right.jobId);
    });
  }

  private blockReason(candidate: AdmissionCandidate): AdmissionBlockReason | undefined {
    if (!evaluateClaudeLaunchSafety(candidate.provider, candidate.model).safe) {
      return "CLAUDE_LAUNCH_REQUIRES_EXPLICIT_MODEL";
    }
    const { maxConcurrentJobs, maxConcurrentPerProvider, maxConcurrentPerRepository } =
      this.options.limits;
    if (maxConcurrentJobs !== undefined && this.reservations.size >= maxConcurrentJobs) {
      return "MAX_CONCURRENT_JOBS";
    }
    const providerLimit = maxConcurrentPerProvider?.[candidate.provider];
    if (providerLimit !== undefined && this.countBy("provider", candidate.provider) >= providerLimit) {
      return "MAX_CONCURRENT_PER_PROVIDER";
    }
    if (
      maxConcurrentPerRepository !== undefined &&
      this.countBy("repositoryKey", candidate.repositoryKey) >= maxConcurrentPerRepository
    ) {
      return "MAX_CONCURRENT_PER_REPOSITORY";
    }
    return undefined;
  }

  private countBy(field: "provider" | "repositoryKey", value: string): number {
    let count = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation[field] === value) count += 1;
    }
    return count;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}
