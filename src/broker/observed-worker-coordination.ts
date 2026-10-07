import {
  WorkerEventSchema,
  type EventAck,
  type WorkerEvent,
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
 * The coordination substrate with two observation points the notification producer needs.
 *
 * `WorkerCoordinationService` has no listener for submitted events or committed handoffs, and the
 * file it lives in sits at its file-size ratchet ceiling, so it cannot grow one. This subclass is
 * composed in `main.ts` in its place. Every call goes through `super` unchanged; observers are
 * told only after the fsynced result returned, and only for the outcomes that mean "the substrate
 * now holds this": an accepted or superseded event, a committed handoff. A listener that throws
 * cannot roll back or misreport the mutation it observed, exactly as the budget listeners cannot.
 */
export class ObservedWorkerCoordinationService extends WorkerCoordinationService {
  private readonly eventObservers = new Set<WorkerEventObserver>();
  private readonly handoffObservers = new Set<HandoffBatchObserver>();
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
