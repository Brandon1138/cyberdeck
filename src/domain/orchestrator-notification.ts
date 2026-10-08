import { z } from "zod";
import { WorkerEventSeveritySchema } from "./worker-coordination.js";

export const NotificationKindSchema = z.enum([
  "settled", "intervention", "attention", "delivery", "risk", "progress", "budget", "handoff",
]);
export const NotificationDeliveryChannelSchema = z.enum(["tool-result", "hook", "wake", "wait"]);

export const NOTIFICATION_LIMITS = {
  summaryChars: 512,
  noticeChars: 200,
  noticeInlineChars: 400,
  drainPageMax: 50,
  refs: 8,
  /**
   * 200 is below the worker-event active queue's default 256 (worker-coordination.ts).
   * Notifications summarize events: half WORKER_EVENT_LIMITS.summaryChars (1024) and
   * half its evidenceRefs (16). Four drain pages bound the controller's active inbox;
   * coalescing and priority drops prevent a fleet multiplying full worker queues here.
   */
  maxUnacknowledgedPerController: 200,
} as const;

export const OrchestratorNotificationSchema = z.object({
  id: z.uuid(),
  cursor: z.number().int().positive(),
  controllerId: z.string().min(1),
  kind: NotificationKindSchema,
  severity: WorkerEventSeveritySchema,
  sessionId: z.uuid(),
  workerId: z.string().optional(),
  taskId: z.string().optional(),
  waveId: z.string().optional(),
  completionTarget: z.number().int().positive().optional(),
  summary: z.string().min(1).max(NOTIFICATION_LIMITS.summaryChars),
  refs: z.array(z.string()).max(NOTIFICATION_LIMITS.refs).default([]),
  wakeEligible: z.boolean(),
  createdAt: z.iso.datetime(),
  noticedAt: z.iso.datetime().optional(),
  deliveredVia: z.array(NotificationDeliveryChannelSchema).default([]),
  acknowledgedAt: z.iso.datetime().optional(),
  schemaVersion: z.literal(1),
  dedupeKey: z.string().min(1).max(256).optional(),
});

export const NotificationPolicySchema = z.object({
  wake: z.enum(["all", "steering-only", "off"]).default("steering-only"),
  quietMinutes: z.number().int().min(1).max(120).default(10),
  maxWakesPerHour: z.number().int().min(0).max(120).default(12),
  coalesceMs: z.number().int().min(0).max(60_000).default(3_000),
});

export type NotificationKind = z.infer<typeof NotificationKindSchema>;
export type NotificationDeliveryChannel = z.infer<typeof NotificationDeliveryChannelSchema>;
export type OrchestratorNotification = z.infer<typeof OrchestratorNotificationSchema>;
export type NotificationPolicy = z.infer<typeof NotificationPolicySchema>;
export type Severity = z.infer<typeof WorkerEventSeveritySchema>;
export const DEFAULT_NOTIFICATION_POLICY: Readonly<NotificationPolicy> = Object.freeze(
  NotificationPolicySchema.parse({}),
);

export interface Notice {
  pending: number;
  byKind: Partial<Record<NotificationKind, number>>;
  oldestAgeSeconds: number;
  dropped: number;
  inline?: { kind: NotificationKind; severity: string; summary: string };
  drain: "cyberdeck_notifications_read";
}

const NOTICE_ORDER: readonly NotificationKind[] = [
  "intervention", "delivery", "attention", "settled", "handoff", "risk", "budget", "progress",
];
const DRAIN = "cyberdeck_notifications_read";
const oneLine = (value: string): string => value.replace(/[\r\n\u2028\u2029]+/g, " ");
const shorten = (value: string, length: number): string => value.length <= length
  ? value : length <= 0 ? "" : `${value.slice(0, length - 1)}…`;
const count = (value: number): string => !Number.isFinite(value) ? "0"
  : Math.max(0, Math.floor(value)).toString();

export function buildNotice(
  pending: readonly OrchestratorNotification[], now: string, dropped: number,
): Notice | undefined {
  if (pending.length === 0 && dropped === 0) return undefined;
  const ordered = [...pending].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    || a.cursor - b.cursor || a.id.localeCompare(b.id));
  const byKind: Notice["byKind"] = {};
  for (const record of pending) byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
  const oldest = ordered[0];
  const notice: Notice = {
    pending: pending.length, byKind, dropped, drain: DRAIN,
    oldestAgeSeconds: oldest === undefined ? 0
      : Math.max(0, Math.floor((Date.parse(now) - Date.parse(oldest.createdAt)) / 1000)),
  };
  const inline = ordered.find((record) => record.kind === "intervention" || record.severity === "critical");
  if (inline !== undefined) {
    notice.inline = { kind: inline.kind, severity: inline.severity, summary: "" };
    const available = NOTIFICATION_LIMITS.noticeInlineChars - renderNotice(notice).length;
    notice.inline.summary = shorten(oneLine(inline.summary), available);
  }
  return notice;
}

/** Preserve the drain and drop count; truncate kind detail before any inline payload. */
export function renderNotice(notice: Notice): string {
  const prefix = `cyberdeck: ${count(notice.pending)} notifications pending (`;
  const suffix = `${Object.values(notice.byKind).some((n) => (n ?? 0) > 0) ? "; " : ""}oldest ${count(notice.oldestAgeSeconds)}s) → ${DRAIN}`
    + (notice.dropped > 0 ? ` · ${count(notice.dropped)} dropped` : "");
  const kinds = NOTICE_ORDER.filter((kind) => (notice.byKind[kind] ?? 0) > 0)
    .map((kind) => `${count(notice.byKind[kind]!)} ${kind}`).join(", ");
  const base = prefix + shorten(kinds, Math.max(0, NOTIFICATION_LIMITS.noticeChars - prefix.length - suffix.length)) + suffix;
  if (notice.inline === undefined) return base;
  const label = " · critical: ";
  return base + label + shorten(oneLine(notice.inline.summary),
    NOTIFICATION_LIMITS.noticeInlineChars - base.length - label.length);
}

export function wakeEligible(input: {
  kind: NotificationKind; severity: Severity; policy: NotificationPolicy; modal?: boolean;
}): boolean {
  if (input.policy.wake === "off") return false;
  if (input.policy.wake === "all" || input.severity === "critical") return true;
  return ["settled", "intervention", "delivery", "handoff"].includes(input.kind)
    || (input.kind === "attention" && input.modal === true);
}

/** Terminal producers omit the target; turn-completion producers pass its positive ordinal. */
export function settledDedupeKey(sessionId: string, completionTarget?: number): string {
  return `settled:${sessionId}:${completionTarget ?? "terminal"}`;
}

export function coalescedDedupeKey(kind: NotificationKind, sessionId: string): string {
  return `${kind}:${sessionId}`;
}
