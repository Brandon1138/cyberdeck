import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StrigoiTurns } from "../../src/orchestration/strigoi-turns.js";
import type { ThreadEvent } from "../../src/domain/thread.js";
import type { SessionInstructionPort } from "../../src/orchestration/session/session-ports.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { SessionIoSurface } from "../../src/orchestration/session/session-io-surface.js";
import { WorkerTurnEngineFactory } from "../../src/orchestration/session/worker-turn-engine.js";
import { RegistryError } from "../../src/orchestration/session/session-registry-ports.js";
import type { AppendWorkerTurnTranscriptEvent } from "../../src/orchestration/session/worker-turn-ports.js";

function fixture() {
  const identity = { sessionId: randomUUID(), incarnation: 1, generation: 1 }, events: ThreadEvent[] = [];
  const submit = vi.fn<SessionInstructionPort["submitInstruction"]>(async (_id, _text, _source, metadata, instructionId, admit) => {
    await admit!(async () => events.push({ id: randomUUID(), cursor: events.length + 1, sessionId: identity.sessionId,
      occurredAt: new Date().toISOString(), kind: "instruction", source: "broker", data: { ...metadata, instructionId, instructionState: "rendered", expectedTurn: 1 } }));
    return { state: "rendered", expectedTurn: 1, at: new Date().toISOString() };
  });
  const registry = { get: () => ({ generation: 1 }), workerTruth: () => ({ state: "idle", modalOpen: false }), submitInstruction: submit };
  const transcripts = { append: async (event: AppendWorkerTurnTranscriptEvent) => { events.push({ ...event, data: event.data ?? {}, id: randomUUID(), cursor: events.length + 1, occurredAt: new Date().toISOString() }); },
    read: async (_id: string, cursor = 0) => ({ events: events.filter((e) => e.cursor > cursor), nextCursor: events.length }) };
  const turns = new StrigoiTurns(registry as never, transcripts as never, async () => "checkpoint instruction");
  return { identity, events, submit, turns, transcripts };
}

function productionFixture() {
  const f = fixture(), writes = vi.fn();
  const record: SessionRecord = { id: f.identity.sessionId, generation: 1, provider: "codex", cwd: "/tmp",
    detached: true, sandbox: "workspace-write", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    executionState: "active", attachmentState: "detached", pid: 123, exitCode: null, childIds: [] };
  const observeProviderTurns = vi.fn(async () => ({ sessionId: record.id, provider: "codex" as const, turnNumber: 1, turns: [] }));
  const transcripts = { ...f.transcripts, observeProviderTurns, commitProviderTurns: async () => [], readTranscriptMessages: async () => [] };
  const engine = new WorkerTurnEngineFactory({ transcripts,
    observations: { createReplay: () => ({ appendBytes: () => {}, reset: () => {}, frameText: () => "", strippedTail: () => ({ text: "", truncated: false }), tokenCount: () => undefined, version: 0 }),
      activity: () => "awaiting-input", starting: () => false, composer: () => ({ modalOpen: false, occupied: false, inputReady: true }),
      fatalTermination: () => undefined, compactFrame: (s) => s, compactTerminal: (s) => s, fallbackTerminal: (s) => s, truncateResult: (s) => s },
    effects: { write: writes, snapshot: () => "", appendEvent: async () => {}, persist: async () => {}, setAttention: async () => {},
      notifyInstructionState: () => {}, notifyDeliveryBoundary: () => {}, notifySessionUpdate: () => {} }, workerStallSeconds: 120,
  }).create(record, 128 * 1024);
  engine.finishInitialization();
  const runtime = { record, turns: engine, watchers: new Map(), sessionRuntime: { snapshot: () => Buffer.alloc(0) } };
  const io = new SessionIoSurface({ catalog: { options: {}, sessions: new Map([[record.id, runtime]]), requireRuntime: () => runtime,
    assertMayConsume: () => {}, requireAdapter: () => ({ submitInput: (s: string) => Buffer.from(s) }), appendEvent: async () => {} } as never,
    bus: { onSessionUpdate: () => {}, notifyControllerReleased: () => {} } as never });
  const turns = new StrigoiTurns({ get: () => record, workerTruth: () => engine.projectTruth(), submitInstruction: io.submitInstruction.bind(io) }, transcripts, async () => "checkpoint");
  return { ...f, turns, io, engine, writes, observeProviderTurns };
}
describe("real succession instruction transport", () => {
  it.each(["before submission", "during native preflight"])("records a production human-control refusal %s and continues after detach", async (when) => {
    const f = productionFixture(), id = randomUUID(), admission = vi.fn(async (apply: () => Promise<unknown>) => apply());
    try {
      expect(await f.turns.boundary(f.identity)).toBe("safe");
      if (when === "before submission") await f.io.attach(f.identity.sessionId, "human", "control", () => {});
      else f.observeProviderTurns.mockImplementationOnce(async () => {
        await f.io.attach(f.identity.sessionId, "human", "control", () => {});
        return { sessionId: f.identity.sessionId, provider: "codex", turnNumber: 1, turns: [] };
      });
      await f.turns.submit(id, f.identity, "checkpoint", undefined, admission as never);
      expect(await f.turns.boundary(f.identity)).toBe("busy");
      expect(await f.turns.observe(id, f.identity)).toEqual({ outcome: "terminated" });
      expect(f.writes).not.toHaveBeenCalled();
      if (when === "before submission") { expect(admission).not.toHaveBeenCalled(); expect(f.observeProviderTurns).not.toHaveBeenCalled(); }
      await f.io.detach(f.identity.sessionId, "human");
      expect(await f.turns.boundary(f.identity)).toBe("safe");
      const retry = randomUUID();
      await f.turns.submit(retry, f.identity, "checkpoint", undefined, async (apply) => apply());
      expect(f.writes).toHaveBeenCalledOnce();
      const rendered = f.events.find((e) => e.data.instructionId === retry && e.data.instructionState === "rendered")!;
      await f.transcripts.append({ sessionId: f.identity.sessionId, kind: "turn", source: "provider", text: '{"checkpoint":"Retained context"}',
        data: { transport: "provider-native", turnNumber: rendered.data.expectedTurn } });
      expect(await f.turns.observe(retry, f.identity)).toEqual({ outcome: "completed", checkpoint: "Retained context" });
      await f.turns.submit(id, f.identity, "checkpoint", undefined, async (apply) => apply());
      await f.turns.submit(retry, f.identity, "checkpoint", undefined, async (apply) => apply());
      expect(f.writes).toHaveBeenCalledOnce();
    } finally { f.engine.releaseTimers(); }
  });
  it("does not treat a SESSION_BUSY code after writing as proof of refusal", async () => {
    const f = productionFixture(), id = randomUUID();
    try {
      f.writes.mockImplementationOnce(() => { throw new RegistryError("SESSION_BUSY", "ambiguous reply"); });
      await expect(f.turns.submit(id, f.identity, "checkpoint", undefined, async (apply) => apply())).rejects.toThrow("ambiguous reply");
      expect(await f.turns.observe(id, f.identity)).toEqual({ outcome: "unknown" });
      expect(f.events.some((e) => e.data.instructionState === "rendered")).toBe(false);
      await f.turns.submit(id, f.identity, "checkpoint", undefined, async (apply) => apply());
      expect(f.writes).toHaveBeenCalledOnce();
    } finally { f.engine.releaseTimers(); }
  });
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
