import { describe, expect, it } from "vitest";
import {
  buildNotice, coalescedDedupeKey, DEFAULT_NOTIFICATION_POLICY, NOTIFICATION_LIMITS,
  NotificationDeliveryChannelSchema, NotificationKindSchema, NotificationPolicySchema,
  OrchestratorNotificationSchema, renderNotice, settledDedupeKey, wakeEligible,
  type Notice, type NotificationKind, type OrchestratorNotification, type Severity,
} from "../../src/domain/orchestrator-notification.js";

const NOW = "2026-10-07T10:00:40.000Z";
function notification(overrides: Partial<OrchestratorNotification> = {}): OrchestratorNotification {
  return OrchestratorNotificationSchema.parse({
    id: crypto.randomUUID(), cursor: 1, controllerId: "orchestrator:test", kind: "settled",
    severity: "info", sessionId: crypto.randomUUID(), summary: "Finished", wakeEligible: true,
    createdAt: "2026-10-07T10:00:00.000Z", schemaVersion: 1, ...overrides,
  });
}

describe("orchestrator notification schemas", () => {
  it("uses bounded summaries, references, positive cursors, UUIDs, version and dedupe keys", () => {
    const base = notification();
    for (const patch of [
      { summary: "" }, { summary: "x".repeat(513) }, { refs: Array(9).fill("ref") },
      { cursor: 0 }, { cursor: -1 }, { cursor: 1.5 }, { schemaVersion: 2 },
      { id: "wrong" }, { sessionId: "wrong" }, { controllerId: "" },
      { dedupeKey: "" }, { dedupeKey: "x".repeat(257) }, { createdAt: "wrong" },
      { completionTarget: 0 }, { deliveredVia: ["wrong"] },
    ]) expect(OrchestratorNotificationSchema.safeParse({ ...base, ...patch }).success).toBe(false);
    expect(notification({ summary: "x".repeat(512), refs: Array(8).fill("ref"),
      dedupeKey: "x".repeat(256) })).toMatchObject({ schemaVersion: 1 });
    const { refs: _refs, deliveredVia: _via, ...withoutDefaults } = base;
    expect(OrchestratorNotificationSchema.parse(withoutDefaults)).toMatchObject({ refs: [], deliveredVia: [] });
    expect(NotificationDeliveryChannelSchema.options).toEqual(["tool-result", "hook", "wake", "wait"]);
  });

  it("defaults policy and rejects every policy boundary violation", () => {
    expect(NotificationPolicySchema.parse({})).toEqual(DEFAULT_NOTIFICATION_POLICY);
    expect(DEFAULT_NOTIFICATION_POLICY).toEqual({ wake: "steering-only", quietMinutes: 10,
      maxWakesPerHour: 12, coalesceMs: 3000 });
    for (const patch of [{ wake: "wrong" }, { quietMinutes: 0 }, { quietMinutes: 121 },
      { quietMinutes: 1.5 }, { maxWakesPerHour: -1 }, { maxWakesPerHour: 121 },
      { maxWakesPerHour: 1.5 }, { coalesceMs: -1 }, { coalesceMs: 60001 }, { coalesceMs: 0.5 }]) {
      expect(NotificationPolicySchema.safeParse(patch).success).toBe(false);
    }
    expect(NotificationPolicySchema.parse({ quietMinutes: 120, maxWakesPerHour: 0, coalesceMs: 60000 }))
      .toMatchObject({ quietMinutes: 120, maxWakesPerHour: 0, coalesceMs: 60000 });
  });
});

describe("bounded notices", () => {
  it("renders exact example, orders kinds, and does not mutate inputs", () => {
    const records = [notification(), notification({ cursor: 2 }), notification({ kind: "intervention", cursor: 3 })];
    const before = structuredClone(records);
    const notice = buildNotice(records, NOW, 2)!;
    const { inline: _inline, ...withoutInline } = notice;
    expect(renderNotice(withoutInline)).toBe(
      "cyberdeck: 3 notifications pending (1 intervention, 2 settled; oldest 40s) → cyberdeck_notifications_read · 2 dropped",
    );
    expect(notice.byKind).toEqual({ settled: 2, intervention: 1 });
    expect(records).toEqual(before);
    const all = buildNotice(NotificationKindSchema.options.map((kind) => notification({ kind })), NOW, 0)!;
    expect(renderNotice(all)).toContain(
      "1 intervention, 1 delivery, 1 attention, 1 settled, 1 handoff, 1 risk, 1 budget, 1 progress",
    );
  });

  it("returns no empty notice, but exposes drops even with an empty inbox", () => {
    expect(buildNotice([], NOW, 0)).toBeUndefined();
    expect(renderNotice(buildNotice([], NOW, 2)!)).toBe(
      "cyberdeck: 0 notifications pending (oldest 0s) → cyberdeck_notifications_read · 2 dropped",
    );
    expect(buildNotice([notification({ createdAt: "2026-10-07T10:01:00.000Z" })], NOW, 0)?.oldestAgeSeconds).toBe(0);
  });

  it("inlines only oldest intervention or critical record, with stable cursor tie breaking", () => {
    const notice = buildNotice([
      notification({ kind: "progress", summary: "ordinary oldest", createdAt: "2026-10-07T09:00:00.000Z" }),
      notification({ kind: "intervention", cursor: 3, summary: "newer intervention" }),
      notification({ kind: "risk", severity: "critical", cursor: 2, summary: "old critical" }),
    ], NOW, 0)!;
    expect(notice.inline).toEqual({ kind: "risk", severity: "critical", summary: "old critical" });
    expect(renderNotice(notice)).toContain(" · critical: old critical");
    expect(renderNotice(buildNotice([notification({ kind: "intervention", severity: "error" })], NOW, 0)!))
      .toContain(" · critical: Finished");
    expect(buildNotice([notification()], NOW, 0)?.inline).toBeUndefined();
  });

  it("enforces both length ceilings for adversarial payloads and counts, retaining drain and drops", () => {
    for (const numeric of [0, 200, 1e20, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, Infinity]) {
      const notice: Notice = { pending: numeric, oldestAgeSeconds: numeric, dropped: numeric,
        byKind: Object.fromEntries(NotificationKindSchema.options.map((kind) => [kind, numeric])),
        drain: "cyberdeck_notifications_read" };
      const base = renderNotice(notice);
      expect(base.length).toBeLessThanOrEqual(NOTIFICATION_LIMITS.noticeChars);
      expect(base).toContain("cyberdeck_notifications_read");
      if (numeric > 0) expect(base).toContain("dropped");
      const inline = { ...notice, inline: { kind: "intervention" as const,
        severity: "critical".repeat(100), summary: "long\nsummary\r\u2028".repeat(1000) } };
      const rendered = renderNotice(inline);
      expect(rendered.length).toBeLessThanOrEqual(NOTIFICATION_LIMITS.noticeInlineChars);
      expect(rendered).toBe(renderNotice(inline));
      expect(rendered).not.toMatch(/[\r\n\u2028\u2029]/);
    }
    const built = buildNotice([notification({ kind: "intervention", summary: "x".repeat(512) })], NOW, 1e20)!;
    expect(built.inline!.summary.length).toBeLessThan(512);
    expect(renderNotice(built).length).toBeLessThanOrEqual(400);
    expect(renderNotice(built)).toContain("cyberdeck_notifications_read");
  });
});

describe("wake policy", () => {
  const steering: NotificationKind[] = ["settled", "intervention", "delivery", "handoff"];
  for (const wake of ["all", "steering-only", "off"] as const) {
    for (const kind of NotificationKindSchema.options) {
      for (const modal of [false, true]) {
        for (const severity of ["info", "warning", "error", "critical"] as Severity[]) {
          it(`${wake}, ${kind}, modal=${modal}, ${severity}`, () => {
            const expected = wake === "all" || (wake === "steering-only"
              && (severity === "critical" || steering.includes(kind) || (kind === "attention" && modal)));
            expect(wakeEligible({ kind, modal, severity, policy: { ...DEFAULT_NOTIFICATION_POLICY, wake } })).toBe(expected);
          });
        }
      }
    }
  }
  it("attention without a modal flag stays notice-only", () => {
    expect(wakeEligible({ kind: "attention", severity: "warning", policy: { ...DEFAULT_NOTIFICATION_POLICY } })).toBe(false);
  });
});

it("mints stable, distinct producer dedupe keys", () => {
  const sessionId = crypto.randomUUID();
  expect(settledDedupeKey(sessionId, 1)).toBe(`settled:${sessionId}:1`);
  expect(settledDedupeKey(sessionId)).toBe(`settled:${sessionId}:terminal`);
  expect(settledDedupeKey(sessionId, 2)).not.toBe(settledDedupeKey(sessionId, 1));
  expect(coalescedDedupeKey("progress", sessionId)).toBe(`progress:${sessionId}`);
  expect(coalescedDedupeKey("attention", sessionId)).not.toBe(coalescedDedupeKey("progress", sessionId));
  expect(coalescedDedupeKey("progress", crypto.randomUUID())).not.toBe(coalescedDedupeKey("progress", sessionId));
});
