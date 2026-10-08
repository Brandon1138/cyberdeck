import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_NOTIFICATION_POLICY, NOTIFICATION_LIMITS, NotificationDeliveryChannelSchema,
  NotificationPolicySchema, OrchestratorNotificationSchema,
  type NotificationDeliveryChannel, type NotificationKind, type NotificationPolicy,
  type OrchestratorNotification, type Severity,
} from "../domain/orchestrator-notification.js";
import {
  corrupt, NotificationLogRecordSchema, OrchestratorNotificationStoreError, readNotificationLog,
  type NotificationLogPayload, type NotificationLogRecord,
} from "./orchestrator-notification-log.js";
import { openPrivateAppendFile } from "./private-files.js";

export { OrchestratorNotificationStoreError } from "./orchestrator-notification-log.js";

const NewNotificationSchema = OrchestratorNotificationSchema.omit({
  id: true, cursor: true, noticedAt: true, deliveredVia: true, acknowledgedAt: true, schemaVersion: true,
}).extend({ createdAt: z.iso.datetime().optional() });
export type NewOrchestratorNotification = z.input<typeof NewNotificationSchema>;
export type AppendOutcome = {
  outcome: "appended" | "replaced" | "duplicate";
  record?: OrchestratorNotification;
  dropped: number;
};
export interface OrchestratorNotificationStoreOptions {
  now?: () => string;
  idFactory?: () => string;
}
interface ControllerState {
  records: Map<string, OrchestratorNotification>;
  /** All historical keys, including dropped/replaced records, survive payload eviction. */
  dedupeKeys: Set<string>;
  headCursor: number;
  lastNoticedCursor: number;
  lastNoticedAt?: string;
  totalDropped: number;
  droppedSinceAcknowledged: number;
  policy: NotificationPolicy;
}
const DROP_ORDER: readonly NotificationKind[] = [
  "progress", "budget", "risk", "attention", "handoff", "settled", "delivery", "intervention",
];
const copy = (record: OrchestratorNotification): OrchestratorNotification => ({
  ...record, refs: [...record.refs], deliveredVia: [...record.deliveredVia],
});
const pending = (state: ControllerState): OrchestratorNotification[] => [...state.records.values()]
  .filter((record) => record.acknowledgedAt === undefined).sort((a, b) => a.cursor - b.cursor);

/**
 * One writer instance per log. Mutations (including cursor assignment) are serialized and fsynced
 * before state becomes readable. Call load before reads/writes; load itself is serialized.
 * Pending payloads are capped at 200 and acknowledged payloads at the latest 100 per controller.
 * Historical dedupe keys and log record IDs remain retained: log compaction is out of scope in v1.
 */
export class OrchestratorNotificationStore {
  readonly path: string;
  private writeTail: Promise<unknown> = Promise.resolve();
  private state = new Map<string, ControllerState>();
  private recordIds = new Set<string>();
  private loaded = false;
  private crashTailBytes: number | undefined;
  private readonly changeListeners = new Set<(controllerId: string) => void>();

  constructor(stateDirectory: string, private readonly options: OrchestratorNotificationStoreOptions = {}) {
    this.path = join(stateDirectory, "orchestration", "orchestrator-notifications-v1.jsonl");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result;
    return result;
  }
  /**
   * Told after every fsynced mutation for a controller, with that controller's id.
   *
   * Delivery subscribes here rather than to the producer: the store is the one thing both share,
   * and a change that was not durably written is not a change anyone should act on. A listener
   * that throws cannot undo the write it was told about.
   */
  onChange(listener: (controllerId: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  private announce(controllerId: string): void {
    for (const listener of this.changeListeners) {
      try { listener(controllerId); } catch { /* observation never changes a persisted outcome */ }
    }
  }
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
  private id(): string { return this.options.idFactory?.() ?? randomUUID(); }
  private requireLoaded(): void {
    if (!this.loaded) throw new Error("OrchestratorNotificationStore.load() must succeed first");
  }
  private controller(controllerId: string, states = this.state): ControllerState {
    const existing = states.get(controllerId);
    if (existing !== undefined) return existing;
    const created: ControllerState = {
      records: new Map(), dedupeKeys: new Set(), headCursor: 0, lastNoticedCursor: 0,
      totalDropped: 0, droppedSinceAcknowledged: 0, policy: { ...DEFAULT_NOTIFICATION_POLICY },
    };
    states.set(controllerId, created);
    return created;
  }

  load(): Promise<void> {
    return this.serialize(async () => {
      this.loaded = false;
      const log = await readNotificationLog(this.path);
      const states = new Map<string, ControllerState>();
      for (let index = 0; index < log.records.length; index += 1) {
        this.apply(log.records[index]!, states, index + 1);
      }
      this.state = states;
      this.recordIds = new Set(log.records.map((record) => record.recordId));
      this.crashTailBytes = log.hasCrashTail ? log.completeBytes : undefined;
      this.loaded = true;
    });
  }

  private async persist(payload: NotificationLogPayload): Promise<void> {
    const record = NotificationLogRecordSchema.parse({
      ...payload, schemaVersion: 1, recordId: this.id(), persistedAt: this.now(),
    });
    if (this.recordIds.has(record.recordId)) {
      throw new OrchestratorNotificationStoreError("DUPLICATE_RECORD_ID", "Duplicate notification record ID");
    }
    try {
      const handle = await openPrivateAppendFile(this.path);
      try {
        // Repair the ignored crash fragment before appending; never join valid JSON to a fragment.
        if (this.crashTailBytes !== undefined) await handle.truncate(this.crashTailBytes);
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
        this.crashTailBytes = undefined;
      } finally { await handle.close(); }
      this.recordIds.add(record.recordId);
      this.apply(record, this.state);
      this.announce("notification" in record ? record.notification.controllerId : record.controllerId);
    } catch (error) {
      // A failed write/sync/close may still have committed a line. Replay before assigning another
      // cursor; retrying against stale memory could otherwise corrupt an at-least-once log.
      this.loaded = false;
      throw error;
    }
  }

  private apply(record: NotificationLogRecord, states: Map<string, ControllerState>, line?: number): void {
    const state = this.controller("notification" in record ? record.notification.controllerId : record.controllerId, states);
    switch (record.recordType) {
      case "orchestrator-notification.append":
      case "orchestrator-notification.replace": {
        const notification = record.notification;
        if (notification.cursor !== state.headCursor + 1 || state.records.has(notification.id)
          || notification.acknowledgedAt !== undefined || notification.noticedAt !== undefined
          || notification.deliveredVia.length !== 0) corrupt("Invalid appended notification state", line);
        if (record.recordType === "orchestrator-notification.replace") {
          const prior = state.records.get(record.replacesId);
          if (prior === undefined || prior.acknowledgedAt !== undefined || prior.dedupeKey === undefined
            || prior.dedupeKey !== notification.dedupeKey) corrupt("Invalid notification replacement", line);
          state.records.delete(prior.id);
        }
        if (pending(state).length >= NOTIFICATION_LIMITS.maxUnacknowledgedPerController) {
          corrupt("Notification capacity exceeded without a drop", line);
        }
        state.records.set(notification.id, copy(notification));
        if (notification.dedupeKey !== undefined) state.dedupeKeys.add(notification.dedupeKey);
        state.headCursor = notification.cursor;
        break;
      }
      case "orchestrator-notification.acknowledge":
        if (record.ids !== undefined) {
          for (const id of record.ids) {
            const notification = state.records.get(id);
            if (notification === undefined || notification.cursor > record.throughCursor) {
              corrupt("Selective acknowledgement references an invalid notification", line);
            }
          }
        }
        for (const notification of pending(state)) {
          if (record.ids === undefined ? notification.cursor <= record.throughCursor
            : record.ids.includes(notification.id)) notification.acknowledgedAt = record.at;
        }
        state.droppedSinceAcknowledged = 0;
        break;
      case "orchestrator-notification.deliver":
        for (const id of record.ids) {
          const notification = state.records.get(id);
          if (notification === undefined) corrupt("Delivery references an unknown notification", line);
          if (!notification.deliveredVia.includes(record.via)) notification.deliveredVia.push(record.via);
          notification.noticedAt ??= record.at;
        }
        break;
      case "orchestrator-notification.drop":
        for (const id of record.ids) {
          const notification = state.records.get(id);
          if (notification === undefined || notification.acknowledgedAt !== undefined) {
            corrupt("Drop references a non-pending notification", line);
          }
          state.records.delete(id);
          state.totalDropped += 1;
          state.droppedSinceAcknowledged += 1;
        }
        break;
      case "orchestrator-notification.notice":
        if (record.cursor > state.headCursor) corrupt("Notice cursor exceeds inbox head", line);
        state.lastNoticedCursor = record.cursor;
        state.lastNoticedAt = record.at;
        break;
      case "orchestrator-notification.policy": state.policy = { ...record.policy }; break;
    }
    const acknowledged = [...state.records.values()].filter((n) => n.acknowledgedAt !== undefined)
      .sort((a, b) => b.cursor - a.cursor);
    for (const notification of acknowledged.slice(100)) state.records.delete(notification.id);
  }

  append(input: NewOrchestratorNotification, options?: { dedupe?: "once" | "replace" }): Promise<AppendOutcome> {
    const parsed = NewNotificationSchema.parse(input);
    return this.serialize(async () => {
      this.requireLoaded();
      const state = this.state.get(parsed.controllerId);
      const matching = state === undefined || parsed.dedupeKey === undefined ? undefined
        : [...state.records.values()].find((record) => record.dedupeKey === parsed.dedupeKey
          && record.acknowledgedAt === undefined);
      if (options?.dedupe === "once" && parsed.dedupeKey !== undefined
        && state?.dedupeKeys.has(parsed.dedupeKey)) {
        const retained = matching ?? [...state.records.values()].find((record) => record.dedupeKey === parsed.dedupeKey);
        return { outcome: "duplicate", ...(retained === undefined ? {} : { record: copy(retained) }), dropped: 0 };
      }
      const notification = OrchestratorNotificationSchema.parse({
        ...parsed, id: this.id(), cursor: (state?.headCursor ?? 0) + 1,
        createdAt: parsed.createdAt ?? this.now(), deliveredVia: [], schemaVersion: 1,
      });
      if (state?.records.has(notification.id)) corrupt("Duplicate notification ID");
      const replacesId = options?.dedupe === "replace" ? matching?.id : undefined;
      let dropped = 0;
      if (state !== undefined && replacesId === undefined) {
        const candidates = pending(state).sort((a, b) => DROP_ORDER.indexOf(a.kind) - DROP_ORDER.indexOf(b.kind)
          || a.cursor - b.cursor);
        const ids = candidates.slice(0, Math.max(0, candidates.length - NOTIFICATION_LIMITS.maxUnacknowledgedPerController + 1))
          .map((record) => record.id);
        if (ids.length > 0) {
          await this.persist({ recordType: "orchestrator-notification.drop", controllerId: parsed.controllerId,
            ids, reason: "capacity", at: this.now() });
          dropped = ids.length;
        }
      }
      await this.persist(replacesId === undefined
        ? { recordType: "orchestrator-notification.append", notification }
        : { recordType: "orchestrator-notification.replace", notification, replacesId });
      return { outcome: replacesId === undefined ? "appended" : "replaced", record: copy(notification), dropped };
    });
  }

  listPending(controllerId: string, afterCursor: number, limit: number,
    filter?: { kinds?: NotificationKind[]; severities?: Severity[] }): OrchestratorNotification[] {
    this.requireLoaded();
    const state = this.state.get(controllerId);
    if (state === undefined) return [];
    const pageSize = Number.isNaN(limit) ? 0 : Math.max(0, Math.min(NOTIFICATION_LIMITS.drainPageMax, Math.floor(limit)));
    return pending(state).filter((record) => record.cursor > afterCursor
      && (filter?.kinds === undefined || filter.kinds.includes(record.kind))
      && (filter?.severities === undefined || filter.severities.includes(record.severity)))
      .slice(0, pageSize).map(copy);
  }
  pendingCount(controllerId: string): number {
    this.requireLoaded();
    const state = this.state.get(controllerId);
    return state === undefined ? 0 : pending(state).length;
  }
  headCursor(controllerId: string): number {
    this.requireLoaded();
    return this.state.get(controllerId)?.headCursor ?? 0;
  }

  acknowledgeThrough(controllerId: string, cursor: number): Promise<number> {
    z.string().min(1).parse(controllerId);
    z.number().int().nonnegative().parse(cursor);
    return this.serialize(async () => {
      this.requireLoaded();
      const state = this.state.get(controllerId);
      const changed = state === undefined ? 0 : pending(state).filter((record) => record.cursor <= cursor).length;
      if (changed > 0 || (state?.droppedSinceAcknowledged ?? 0) > 0) {
        await this.persist({ recordType: "orchestrator-notification.acknowledge",
          controllerId, throughCursor: cursor, at: this.now() });
      }
      return changed;
    });
  }

  /**
   * Delivery is fsynced first, then selective acknowledgement; a crash between them leaves the
   * notification pending for retry. The acknowledgement envelope's optional ids avoids consuming
   * older unrelated records. No delivery channel implicitly acknowledges a notification.
   */
  acknowledgeByDedupeKey(controllerId: string, dedupeKey: string,
    via: NotificationDeliveryChannel): Promise<OrchestratorNotification | undefined> {
    NotificationDeliveryChannelSchema.parse(via);
    return this.serialize(async () => {
      this.requireLoaded();
      const state = this.state.get(controllerId);
      const notification = state === undefined ? undefined : pending(state).find((record) => record.dedupeKey === dedupeKey);
      if (notification === undefined) return undefined;
      await this.persist({ recordType: "orchestrator-notification.deliver",
        controllerId, ids: [notification.id], via, at: this.now() });
      await this.persist({ recordType: "orchestrator-notification.acknowledge",
        controllerId, throughCursor: notification.cursor, ids: [notification.id], at: this.now() });
      return copy(notification);
    });
  }

  markDelivered(controllerId: string, ids: readonly string[], via: NotificationDeliveryChannel): Promise<void> {
    NotificationDeliveryChannelSchema.parse(via);
    const requested = new Set(ids);
    return this.serialize(async () => {
      this.requireLoaded();
      const state = this.state.get(controllerId);
      const changed = state === undefined ? [] : [...state.records.values()]
        .filter((record) => requested.has(record.id)
          && (!record.deliveredVia.includes(via) || record.noticedAt === undefined)).map((record) => record.id);
      if (changed.length > 0) await this.persist({ recordType: "orchestrator-notification.deliver",
        controllerId, ids: changed, via, at: this.now() });
    });
  }
  markNoticed(controllerId: string, cursor: number): Promise<void> {
    z.string().min(1).parse(controllerId);
    z.number().int().nonnegative().parse(cursor);
    return this.serialize(async () => {
      this.requireLoaded();
      if (cursor > this.headCursor(controllerId)) throw new Error("Notice cursor exceeds inbox head");
      await this.persist({ recordType: "orchestrator-notification.notice", controllerId, cursor, at: this.now() });
    });
  }
  noticeState(controllerId: string): { lastNoticedCursor: number; lastNoticedAt?: string; headCursor: number } {
    this.requireLoaded();
    const state = this.state.get(controllerId);
    return { lastNoticedCursor: state?.lastNoticedCursor ?? 0,
      ...(state?.lastNoticedAt === undefined ? {} : { lastNoticedAt: state.lastNoticedAt }),
      headCursor: state?.headCursor ?? 0 };
  }
  dropped(controllerId: string): { total: number; sinceAcknowledged: number } {
    this.requireLoaded();
    const state = this.state.get(controllerId);
    return { total: state?.totalDropped ?? 0, sinceAcknowledged: state?.droppedSinceAcknowledged ?? 0 };
  }
  policy(controllerId: string): NotificationPolicy {
    this.requireLoaded();
    return { ...(this.state.get(controllerId)?.policy ?? DEFAULT_NOTIFICATION_POLICY) };
  }
  setPolicy(controllerId: string, policy: NotificationPolicy): Promise<NotificationPolicy> {
    z.string().min(1).parse(controllerId);
    const parsed = NotificationPolicySchema.parse(policy);
    return this.serialize(async () => {
      this.requireLoaded();
      await this.persist({ recordType: "orchestrator-notification.policy", controllerId, policy: parsed });
      return { ...parsed };
    });
  }
  controllers(): string[] {
    this.requireLoaded();
    return [...this.state.keys()].sort();
  }
}
