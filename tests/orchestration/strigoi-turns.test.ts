import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StrigoiTurns } from "../../src/orchestration/strigoi-turns.js";
import type { ThreadEvent } from "../../src/domain/thread.js";
import type { SessionInstructionPort } from "../../src/orchestration/session/session-ports.js";

function fixture() {
  const identity = { sessionId: randomUUID(), incarnation: 1, generation: 1 }, events: ThreadEvent[] = [];
  const submit = vi.fn<SessionInstructionPort["submitInstruction"]>(async (_id, _text, _source, metadata, instructionId, admit) => {
    await admit!(async () => events.push({ id: randomUUID(), cursor: events.length + 1, sessionId: identity.sessionId,
      occurredAt: new Date().toISOString(), kind: "instruction", source: "broker", data: { ...metadata, instructionId, instructionState: "rendered", expectedTurn: 1 } }));
    return { state: "rendered", expectedTurn: 1, at: new Date().toISOString() };
  });
  const registry = { get: () => ({ generation: 1 }), workerTruth: () => ({ state: "idle", modalOpen: false }), submitInstruction: submit };
  const transcripts = { append: async (event: Omit<ThreadEvent, "id" | "cursor" | "occurredAt">) => { events.push({ ...event, id: randomUUID(), cursor: events.length + 1, occurredAt: new Date().toISOString() }); },
    read: async (_id: string, cursor = 0) => ({ events: events.filter((e) => e.cursor > cursor), nextCursor: events.length }) };
  const turns = new StrigoiTurns(registry as never, transcripts as never, async () => "checkpoint instruction");
  return { identity, events, submit, turns };
}
describe("real succession instruction transport", () => {
  it("persists intent before rendering, then reconstructs native exact-target completion", async () => {
    const f = fixture(), id = randomUUID();
    await f.turns.submit(id, f.identity, "checkpoint", undefined, async (apply) => { expect(f.events[0]?.data.instructionState).toBe("queued"); return apply(); });
    expect(await f.turns.observe(id, f.identity)).toEqual({ outcome: "unknown" });
    f.events.push({ id: randomUUID(), cursor: 3, sessionId: f.identity.sessionId, occurredAt: new Date().toISOString(), kind: "turn", source: "provider",
      text: '{"checkpoint":"Original meaning retained"}', data: { transport: "provider-native", turnNumber: 1 } });
    expect(await f.turns.observe(id, f.identity)).toEqual({ outcome: "completed", checkpoint: "Original meaning retained" });
    await f.turns.submit(id, f.identity, "checkpoint", undefined, async (apply) => apply());
    expect(f.submit).toHaveBeenCalledOnce();
  });
  it("does not retype after a lost render reply or count a terminal scrape as completion", async () => {
    const f = fixture(), id = randomUUID(), submit = f.submit.getMockImplementation()!;
    f.submit.mockImplementationOnce(async (...args) => { await submit(...args); throw new Error("lost rendered reply"); });
    await expect(f.turns.submit(id, f.identity, "checkpoint", undefined, async (apply) => apply())).rejects.toThrow("lost rendered reply");
    await f.turns.submit(id, f.identity, "checkpoint", undefined, async (apply) => apply());
    f.events.push({ id: randomUUID(), cursor: 3, sessionId: f.identity.sessionId, occurredAt: new Date().toISOString(), kind: "turn", source: "provider",
      text: '{"checkpoint":"Not native"}', data: { transport: "terminal-replay-fallback", turnNumber: 1 } });
    expect(await f.turns.observe(id, f.identity)).toEqual({ outcome: "unknown" }); expect(f.submit).toHaveBeenCalledOnce();
  });
  it("makes a proven preflight refusal retryable and fails closed on malformed native adoption", async () => {
    const f = fixture(), id = randomUUID();
    f.submit.mockResolvedValueOnce({ state: "queued", at: new Date().toISOString(), hold: "provider-busy" });
    await f.turns.submit(id, f.identity, "adoption", undefined, async (apply) => apply());
    expect(await f.turns.observe(id, f.identity)).toEqual({ outcome: "terminated" });
    const next = randomUUID(); await f.turns.submit(next, f.identity, "adoption", undefined, async (apply) => apply());
    f.events.push({ id: randomUUID(), cursor: f.events.length + 1, sessionId: f.identity.sessionId, occurredAt: new Date().toISOString(), kind: "turn", source: "provider",
      text: "No actual adoption receipt", data: { transport: "provider-native", turnNumber: 1 } });
    expect(await f.turns.observe(next, f.identity)).toEqual({ outcome: "completed" });
  });
});
