import { describe, expect, it } from "vitest";
import {
  NoticeFileSchema,
  noticeIsUnseen,
  renderNoticeHookOutput,
  type NoticeFile,
} from "../../src/domain/orchestrator-notice-file.js";
import { stableUuid } from "../../src/domain/stable-uuid.js";

const file: NoticeFile = {
  schemaVersion: 1,
  controllerId: "orchestrator:fleet",
  sessionId: "11111111-1111-4111-8111-111111111111",
  cursor: 7,
  noticedCursor: 3,
  pending: 2,
  dropped: 0,
  text: "cyberdeck: 2 notifications pending (2 settled; oldest 4s) → cyberdeck_notifications_read",
  writtenAt: "2026-10-07T10:00:00.000Z",
};

describe("orchestrator notice file", () => {
  it("validates the broker-written shape and bounds the text", () => {
    expect(NoticeFileSchema.parse(file)).toEqual(file);
    expect(NoticeFileSchema.safeParse({ ...file, text: "x".repeat(401) }).success).toBe(false);
    expect(NoticeFileSchema.safeParse({ ...file, schemaVersion: 2 }).success).toBe(false);
  });

  it("is unseen only when the head moved past both the hook's and the broker's last notice", () => {
    expect(noticeIsUnseen(file, undefined)).toBe(true);
    expect(noticeIsUnseen(file, { schemaVersion: 1, cursor: 7, shownAt: file.writtenAt })).toBe(false);
    expect(noticeIsUnseen(file, { schemaVersion: 1, cursor: 6, shownAt: file.writtenAt })).toBe(true);
    expect(noticeIsUnseen({ ...file, noticedCursor: 7 }, undefined)).toBe(false);
    expect(noticeIsUnseen({ ...file, pending: 0 }, undefined)).toBe(false);
    expect(noticeIsUnseen({ ...file, pending: 0, dropped: 1 }, undefined)).toBe(true);
  });

  it("renders each provider's hook envelope", () => {
    expect(JSON.parse(renderNoticeHookOutput("claude", "hi"))).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "hi" },
    });
    expect(JSON.parse(renderNoticeHookOutput("codex", "hi", "Stop"))).toEqual({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: "hi" },
    });
    expect(JSON.parse(renderNoticeHookOutput("cursor", "hi"))).toEqual({ additional_context: "hi" });
  });
});

describe("stableUuid", () => {
  it("is deterministic and UUID-shaped", () => {
    const first = stableUuid("notice:orchestrator:fleet:7");
    expect(first).toBe(stableUuid("notice:orchestrator:fleet:7"));
    expect(first).not.toBe(stableUuid("notice:orchestrator:fleet:8"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});
