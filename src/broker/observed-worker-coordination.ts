import {
  WorkerEventSchema,
  type EventAck,
  type WorkerEvent,
  type OwnershipMutationResult,
} from "../domain/worker-coordination.js";
import {
  WorkerCoordinationService,
  type EventSubmissionInput,
  type HandoffBatchInput,
  type HandoffBatchResult,
} from "./worker-coordination.js";

const MAX_ANNOUNCED_EVENT_IDS = 4_096;

export type WorkerEventObserver = (event: WorkerEvent, ack: EventAck) => void;
export type HandoffBatchObserver = (input: HandoffBatchInput, result: HandoffBatchResult) => void;

/**
 * Post-commit event/handoff observation and attention's authority/source-change observation.
 *
 * `WorkerCoordinationService` has no listener for submitted events or committed handoffs, and the
 * file it lives in sits at its file-size ratchet ceiling. This subclass is
 * composed in `main.ts` in its place. Every call goes through `super` unchanged; observers are
 * told only after the fsynced result returned, and only for the outcomes that mean "the substrate
 * now holds this": an accepted or superseded event, a committed handoff. A listener that throws
 * cannot roll back or misreport the mutation it observed, exactly as the budget listeners cannot.
 */
export class ObservedWorkerCoordinationService extends WorkerCoordinationService {
  private readonly eventObservers = new Set<WorkerEventObserver>();
  private readonly handoffObservers = new Set<HandoffBatchObserver>();
  private readonly subjectObservers = new Set<(subjectId: string) => void>();

  onSubjectChanged(observer: (subjectId: string) => void): () => void {
    this.subjectObservers.add(observer);
    return () => { this.subjectObservers.delete(observer); };
  }

  private notifySubjects(ids: readonly string[]): void {
    for (const id of new Set(ids)) for (const observer of this.subjectObservers) {
      try { observer(id); } catch { /* Observation never changes the committed mutation. */ }
    }
  }

  private async observeOwnership<T extends OwnershipMutationResult>(operation: Promise<T>): Promise<T> {
    const result = await operation;
    this.notifySubjects(result.outcomes.map((outcome) => outcome.subjectId));
    return result;
  }

  override registerSubject(input: Parameters<WorkerCoordinationService["registerSubject"]>[0]) { return this.observeOwnership(super.registerSubject(input)); }
  override acquire(input: Parameters<WorkerCoordinationService["acquire"]>[0]) { return this.observeOwnership(super.acquire(input)); }
  override renew(input: Parameters<WorkerCoordinationService["renew"]>[0]) { return this.observeOwnership(super.renew(input)); }
  override authenticatedCall(input: Parameters<WorkerCoordinationService["authenticatedCall"]>[0]) { return this.observeOwnership(super.authenticatedCall(input)); }
  override release(input: Parameters<WorkerCoordinationService["release"]>[0]) { return this.observeOwnership(super.release(input)); }
  override transfer(input: Parameters<WorkerCoordinationService["transfer"]>[0]) { return this.observeOwnership(super.transfer(input)); }
  override adopt(input: Parameters<WorkerCoordinationService["adopt"]>[0]) { return this.observeOwnership(super.adopt(input)); }
  override adoptBatch(input: Parameters<WorkerCoordinationService["adoptBatch"]>[0]) { return this.observeOwnership(super.adoptBatch(input)); }
  override observeControllerLiveness(input: Parameters<WorkerCoordinationService["observeControllerLiveness"]>[0]) { return this.observeOwnership(super.observeControllerLiveness(input)); }
  override expireLeases(input: Parameters<WorkerCoordinationService["expireLeases"]>[0]) { return this.observeOwnership(super.expireLeases(input)); }
  override updateLifecycle(input: Parameters<WorkerCoordinationService["updateLifecycle"]>[0]) { return this.observeOwnership(super.updateLifecycle(input)); }
  override async reconcileLifecycle(input: Parameters<WorkerCoordinationService["reconcileLifecycle"]>[0]) {
    const result = await super.reconcileLifecycle(input); this.notifySubjects([input.subjectId]); return result;
  }
  override async resolveEvent(input: Parameters<WorkerCoordinationService["resolveEvent"]>[0]) {
    const result = await super.resolveEvent(input);
    this.notifySubjects(this.listSubjects().filter((subject) => subject.lease.controller?.controllerId === input.controller.controllerId).map((subject) => subject.subjectId));
    return result;
  }
  /**
   * Event ids already announced. The substrate answers an idempotent retry with the recorded
   * `accepted` ack, which is right for the submitter and wrong for an observer: the event did not
   * happen twice. Bounded so a long-lived broker cannot grow it without limit.
   */
  private readonly announcedEventIds = new Set<string>();

  onEventSubmitted(observer: WorkerEventObserver): () => void {
    this.eventObservers.add(observer);
    return () => this.eventObservers.delete(observer);
  }

  onHandoffCommitted(observer: HandoffBatchObserver): () => void {
    this.handoffObservers.add(observer);
    return () => this.handoffObservers.delete(observer);
  }

  override async submitEvent(input: EventSubmissionInput): Promise<EventAck> {
    const ack = await super.submitEvent(input);
    if (ack.code === "accepted" || ack.code === "superseded") {
      // The substrate parsed and persisted exactly this payload; reparsing is how observers get
      // the typed event without this class reaching into the substrate's private map.
      const event = WorkerEventSchema.safeParse(input.event);
      if (!event.success || this.announcedEventIds.has(event.data.eventId)) return ack;
      this.announcedEventIds.add(event.data.eventId);
      if (this.announcedEventIds.size > MAX_ANNOUNCED_EVENT_IDS) {
        const oldest = this.announcedEventIds.values().next().value;
        if (oldest !== undefined) this.announcedEventIds.delete(oldest);
      }
      for (const observer of this.eventObservers) {
        try {
          observer(event.data, ack);
        } catch {
          // Observation never changes an already-persisted outcome.
        }
      }
    }
    return ack;
  }

  override async handoffBatch(input: HandoffBatchInput): Promise<HandoffBatchResult> {
    const result = await super.handoffBatch(input);
    if (result.committed) {
      for (const observer of this.handoffObservers) {
        try {
          observer(input, result);
        } catch {
          // Observation never changes an already-persisted outcome.
        }
      }
    }
    return result;
  }
}
