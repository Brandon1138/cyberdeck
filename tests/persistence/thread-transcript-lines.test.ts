import { describe, expect, it } from "vitest";
import { ClaudeTurnStops } from "../../src/persistence/thread-transcript-lines.js";

const timestamp = "2026-08-20T09:00:01.000Z";
const stoppedAt = "2026-08-20T09:00:01.100Z";
const assistant = (content: unknown[]) => JSON.stringify({
  type: "assistant", timestamp,
  message: { id: "assistant-id", role: "assistant", stop_reason: "end_turn", content },
});
const duration = (uuid?: string) => JSON.stringify({ type: "system", subtype: "turn_duration", timestamp: stoppedAt, uuid });

describe("ClaudeTurnStops textless receipts", () => {
  it.each(["stop-id", undefined])("keeps an empty receipt stable across replay with stop uuid %s", (uuid) => {
    const frames = [assistant([]), duration(uuid)];
    const first = new ClaudeTurnStops();
    const replayed = new ClaudeTurnStops();
    const turns = frames.flatMap((line) => first.observe(line, () => "2026-08-20T10:00:00.000Z"));
    expect(turns).toEqual([{ id: `stop:${uuid ?? stoppedAt}`, occurredAt: stoppedAt, text: "" }]);
    expect(frames.flatMap((line) => replayed.observe(line, () => "2026-08-21T10:00:00.000Z"))).toEqual(turns);
    expect(frames.flatMap((line) => first.observe(line, undefined))).toEqual([]);
    first.reset();
    expect(frames.flatMap((line) => first.observe(line, undefined))).toEqual(turns);
  });

  it("closes an early stop when its textless assistant frame arrives", () => {
    const stops = new ClaudeTurnStops();
    expect(stops.observe(duration("early-stop"), undefined)).toEqual([]);
    expect(stops.observe(assistant([{ type: "tool_use", id: "tool", name: "Read", input: {} }]), undefined))
      .toEqual([{ id: "stop:early-stop", occurredAt: stoppedAt, text: "" }]);
  });

  it("preserves text candidate pairing when a later assistant frame has no text", () => {
    const stops = new ClaudeTurnStops();
    expect(stops.observe(assistant([{ type: "text", text: "final text" }]), undefined)).toEqual([]);
    const later = JSON.parse(assistant([])) as { timestamp: string };
    later.timestamp = "2026-08-20T09:00:01.050Z";
    expect(stops.observe(JSON.stringify(later), undefined)).toEqual([]);
    expect(stops.observe(duration("stop-id"), undefined))
      .toEqual([{ id: "assistant-id", occurredAt: stoppedAt, text: "final text" }]);
  });
});
