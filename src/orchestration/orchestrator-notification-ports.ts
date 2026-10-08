import type { z } from "zod";
import type {
  NotificationDeliveryChannel,
  NotificationKind,
  NotificationPolicy,
  OrchestratorNotification,
  OrchestratorNotificationSchema,
  Severity,
} from "../domain/orchestrator-notification.js";

/**
 * What the producer writes, the delivery service watches and the control plane drains.
 *
 * The durable store lives in the persistence layer, which application code may not import. This
 * is the application's view of it: the persistence store satisfies it structurally, tests replace
 * it with a fake, and nothing above this line knows there is a JSONL file.
 */
export type NewOrchestratorNotification = Omit<
  z.input<typeof OrchestratorNotificationSchema>,
  "id" | "cursor" | "noticedAt" | "deliveredVia" | "acknowledgedAt" | "schemaVersion" | "createdAt"
> & { createdAt?: string };

export interface NotificationAppendOutcome {
  outcome: "appended" | "replaced" | "duplicate";
  record?: OrchestratorNotification;
  /** Records the inbox had to discard under its cap to make room. Never silent. */
  dropped: number;
}

export interface NotificationPendingFilter {
  kinds?: NotificationKind[];
  severities?: Severity[];
}

export interface NotificationNoticeState {
  lastNoticedCursor: number;
  lastNoticedAt?: string;
  headCursor: number;
}

export interface NotificationInboxPort {
  append(
    input: NewOrchestratorNotification,
    options?: { dedupe?: "once" | "replace" },
  ): Promise<NotificationAppendOutcome>;
  listPending(
    controllerId: string,
    afterCursor: number,
    limit: number,
    filter?: NotificationPendingFilter,
  ): OrchestratorNotification[];
  pendingCount(controllerId: string): number;
  headCursor(controllerId: string): number;
  acknowledgeThrough(controllerId: string, cursor: number): Promise<number>;
  /** The wait integration: a wait that delivered a target consumes the matching settled record. */
  acknowledgeByDedupeKey(
    controllerId: string,
    dedupeKey: string,
    via: NotificationDeliveryChannel,
  ): Promise<OrchestratorNotification | undefined>;
  markDelivered(
    controllerId: string,
    ids: readonly string[],
    via: NotificationDeliveryChannel,
  ): Promise<void>;
  markNoticed(controllerId: string, cursor: number): Promise<void>;
  noticeState(controllerId: string): NotificationNoticeState;
  dropped(controllerId: string): { total: number; sinceAcknowledged: number };
  policy(controllerId: string): NotificationPolicy;
  setPolicy(controllerId: string, policy: NotificationPolicy): Promise<NotificationPolicy>;
  controllers(): string[];
  /** Fired after every fsynced mutation, with the controller whose inbox changed. */
  onChange(listener: (controllerId: string) => void): () => void;
}
