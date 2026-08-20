import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../../src/domain/session.js";
import { DELIVERY_HOLD_DETAIL } from "../../../src/domain/worker-truth.js";
import type {
  ReplayObservation,
  WorkerTurnEngineEffects,
  WorkerTurnObservationPort,
  WorkerTurnPreviewPort,
  WorkerTurnTranscript,
  WorkerTurnTranscriptPort,
} from "../../../src/orchestration/session/worker-turn-ports.js";
import {
  WorkerTurnEngine,
  WorkerTurnEngineFactory,
} from "../../../src/orchestration/session/worker-turn-engine.js";

function sessionRecord(): SessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "codex",
    cwd: "/tmp/repo",
    detached: true,
    sandbox: "workspace-write",
    createdAt: "2026-08-20T09:00:00.000Z",
    updatedAt: "2026-08-20T09:00:00.000Z",
    executionState: "active",
    attachmentState: "detached",
    pid: 4242,
    exitCode: null,
    childIds: [],
    attentionState: "working",
  };
}

function harness(
  recordOverrides: Partial<SessionRecord> = {},
  options: { preview?: WorkerTurnPreviewPort } = {},
) {
  let frame = "";
  let activity: ReturnType<WorkerTurnObservationPort["activity"]> = "unknown";
  let composer: ReturnType<WorkerTurnObservationPort["composer"]> = {
    modalOpen: false,
    occupied: false,
  };
  const replay: ReplayObservation = {
    appendBytes: (chunk) => { frame += chunk.toString("utf8"); },
    reset: (next) => { frame = next; },
    frameText: () => frame,
    strippedTail: (maxChars) => ({
      text: frame.slice(-maxChars),
      truncated: frame.length > maxChars,
    }),
    tokenCount: () => undefined,
    get version() { return frame.length; },
  };
  const fatalTermination = vi.fn<WorkerTurnObservationPort["fatalTermination"]>()
    .mockReturnValue(undefined);
  const observations: WorkerTurnObservationPort = {
    createReplay: () => replay,
    activity: () => activity,
    composer: () => composer,
    fatalTermination,
    compactFrame: (text) => text,
    compactTerminal: (text) => text,
    fallbackTerminal: (text) => text,
    truncateResult: (text, maxChars) => text.slice(-maxChars),
  };
  const providerTurnObservation = vi.fn<
    (input: Parameters<NonNullable<WorkerTurnTranscriptPort["observeProviderTurns"]>>[0]) =>
    Promise<WorkerTurnTranscript[]>
  >()
    .mockResolvedValue([]);
  const observeProviderTurns = vi.fn<
    NonNullable<WorkerTurnTranscriptPort["observeProviderTurns"]>
  >().mockImplementation(async (input) => ({
    sessionId: input.sessionId,
    provider: input.provider,
    turnNumber: input.turnNumber,
    turns: (await providerTurnObservation(input)).map((turn, index) => ({
      providerTurnId: `test:${input.turnNumber + index}`,
      providerOccurredAt: "2026-08-20T09:00:00.000Z",
      text: turn.text ?? "",
      transport: turn.data?.transport === "provider-native"
        ? "provider-native"
        : "terminal-replay-fallback",
    })),
  }));
  const commitProviderTurns = vi.fn<
    NonNullable<WorkerTurnTranscriptPort["commitProviderTurns"]>
  >().mockImplementation(async (observation) => observation.turns.map((turn) => ({
    text: turn.text,
    data: { ...(turn.data ?? {}), transport: turn.transport },
  })));
  const readTranscriptMessages = vi.fn<
    NonNullable<WorkerTurnTranscriptPort["readTranscriptMessages"]>
  >().mockResolvedValue([]);
  const readObservedModel = vi.fn<
    NonNullable<WorkerTurnTranscriptPort["readObservedModel"]>
  >().mockResolvedValue(undefined);
  const transcripts: WorkerTurnTranscriptPort = {
    append: vi.fn(async () => undefined),
    observeProviderTurns,
    commitProviderTurns,
    readTranscriptMessages,
    readObservedModel,
  };
  const writes: Buffer[] = [];
  const effects: WorkerTurnEngineEffects = {
    snapshot: () => frame,
    write: (data) => { writes.push(Buffer.from(data)); },
    appendEvent: vi.fn(async () => undefined),
    persist: vi.fn(async () => undefined),
    setAttention: vi.fn(async () => undefined),
    notifyInstructionState: vi.fn(),
    notifyDeliveryBoundary: vi.fn(),
    notifySessionUpdate: vi.fn(),
  };
  const record: SessionRecord = { ...sessionRecord(), ...recordOverrides };
  const engine = new WorkerTurnEngineFactory({
    observations,
    transcripts,
    effects,
    workerStallSeconds: 120,
    ...(options.preview === undefined ? {} : { preview: options.preview }),
  }).create(record, 128 * 1024);
  engines.push(engine);
  return {
    engine,
    observations: {
      set activity(next: typeof activity) { activity = next; },
      set composer(next: typeof composer) { composer = next; },
    },
    // Existing scenarios control the side-effect-free observation payload through this mock.
    captureProviderTurns: providerTurnObservation,
    commitProviderTurns,
    effects,
    fatalTermination,
    readObservedModel,
    readTranscriptMessages,
    observeProviderTurns,
    record,
    replay: () => frame,
    writes,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

const engines: WorkerTurnEngine[] = [];

afterEach(() => {
  while (engines.length > 0) engines.pop()?.releaseTimers();
  vi.useRealTimers();
});

describe("WorkerTurnEngine", () => {
  it("never settles an instruction from a turn completed before it was rendered", () => {
    const { engine, observations, replay } = harness();
    const now = "2026-08-20T09:01:00.000Z";

    engine.recordCompletion(1, "older answer", "provider-transcript");
    engine.noteRenderedInstruction({ instructionId: "i-1", expectedTurn: 2, renderedAt: now });
    observations.activity = "working";
    engine.appendOutput(Buffer.from("newer turn"), replay);

    expect(engine.waitResult(1)).toMatchObject({ status: "working" });
  });

  it("holds delivery at a provider modal without writing", async () => {
    const { engine, observations, writes } = harness();
    observations.composer = { occupied: false, modalOpen: true };
    const input = {
      message: "continue after approval",
      encoded: Buffer.from("continue after approval\n"),
      source: "orchestrator" as const,
      instructionId: "i-1",
    };

    expect(await engine.submitInstruction(input)).toEqual({
      state: "queued",
      hold: "provider-modal",
      detail: DELIVERY_HOLD_DETAIL["provider-modal"],
      at: expect.any(String),
    });
    expect(writes).toEqual([]);
  });

  it("holds delivery at an occupied composer without writing", async () => {
    const { engine, observations, writes } = harness();
    observations.composer = { occupied: true, modalOpen: false };

    expect(await engine.submitInstruction({
      message: "do not overwrite this draft",
      encoded: Buffer.from("do not overwrite this draft\n"),
      source: "orchestrator",
      instructionId: "i-2",
    })).toEqual({
      state: "queued",
      hold: "composer-occupied",
      detail: DELIVERY_HOLD_DETAIL["composer-occupied"],
      at: expect.any(String),
    });
    expect(writes).toEqual([]);
  });

  it("banks provider transcript turns with canonical provenance", async () => {
    const { engine, observations, captureProviderTurns, replay } = harness();
    observations.activity = "working";
    engine.appendOutput(Buffer.from("working"), replay);
    captureProviderTurns.mockResolvedValue([{
      text: "canonical",
      data: { transport: "provider-native" },
    }]);

    await engine.reconcileCanonicalTurns();

    expect(engine.canonicalTurns).toBe(1);
    expect(engine.waitResult(1)).toMatchObject({
      status: "completed",
      provenance: "provider-transcript",
      text: "canonical",
    });
  });

  it.each([
    ["unlabelled", { text: "ambiguous" }],
    ["terminal replay", { text: "scraped", data: { transport: "terminal-replay-fallback" } }],
  ])("does not reconcile a %s turn as canonical", async (_label, turn) => {
    const { engine, observations, captureProviderTurns, replay } = harness();
    observations.activity = "working";
    engine.appendOutput(Buffer.from("working"), replay);
    captureProviderTurns.mockResolvedValue([turn]);

    await engine.reconcileCanonicalTurns();

    expect(engine.completedTurns).toBe(0);
    expect(engine.canonicalTurns).toBe(0);
    expect(engine.waitResult(1)).toMatchObject({ status: "working", completedTurns: 0 });
  });

  it("cancels pending turn work and releases held delivery on fatal termination", async () => {
    vi.useFakeTimers();
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      effects,
      fatalTermination,
      record,
      replay,
    } = harness();

    await engine.submitInstruction({
      message: "finish the task",
      encoded: Buffer.from("finish the task\n"),
      source: "orchestrator",
      instructionId: "pending-rendered",
    });
    observations.activity = "working";
    engine.appendOutput(Buffer.from("working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("prompt"), replay);
    observations.composer = { modalOpen: true, occupied: false };
    await expect(engine.submitInstruction({
      message: "held follow-up",
      encoded: Buffer.from("held follow-up\n"),
      source: "orchestrator",
      instructionId: "held-follow-up",
    })).resolves.toMatchObject({ state: "queued", hold: "provider-modal" });

    fatalTermination.mockImplementation((_tail, at) => ({
      kind: "provider-fault",
      reason: "provider rejected the request",
      detail: "API Error: 401 authentication_error",
      at,
    }));
    expect(engine.appendOutput(Buffer.from("API Error: 401 authentication_error\n"), replay))
      .toMatchObject({ fatal: true, termination: { kind: "provider-fault" } });

    expect(effects.notifyInstructionState).toHaveBeenLastCalledWith(expect.objectContaining({
      instructionId: "pending-rendered",
      state: "undelivered",
    }));
    expect(effects.notifyDeliveryBoundary).toHaveBeenCalledOnce();
    expect(engine.projectTruth()).toMatchObject({ pendingInstructions: 0 });

    await vi.runAllTimersAsync();
    expect(captureProviderTurns).not.toHaveBeenCalled();
    expect(commitProviderTurns).not.toHaveBeenCalled();
    expect(engine.completedTurns).toBe(0);
    expect(engine.canonicalTurns).toBe(0);
    expect(engine.waitResult(1).status).not.toBe("completed");

    record.executionState = "failed";
    await expect(engine.settleForResume(replay())).resolves.toBeUndefined();
    record.executionState = "active";
    engine.resetForResume();
    observations.composer = { modalOpen: false, occupied: false };
    await expect(engine.submitInstruction({
      message: "work after fatal resume",
      encoded: Buffer.from("work after fatal resume\n"),
      source: "orchestrator",
      instructionId: "post-fatal-resume",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 1 });
  });

  it("makes a late fallback commit inert after terminal authority rejects its screen", async () => {
    vi.useFakeTimers();
    const lateCommit = deferred<WorkerTurnTranscript[]>();
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      record,
      replay,
    } = harness();
    captureProviderTurns.mockResolvedValueOnce([{
      text: "turn rejected by terminal authority",
      data: { transport: "terminal-replay-fallback" },
    }]);
    commitProviderTurns.mockReturnValueOnce(lateCommit.promise);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("finished screen"), replay);
    await vi.advanceTimersByTimeAsync(200);
    expect(commitProviderTurns).toHaveBeenCalledOnce();

    engine.discardPendingScreenTurns();
    record.executionState = "failed";
    await expect(engine.settleForResume(replay())).resolves.toBeUndefined();
    record.executionState = "active";
    engine.resetForResume();
    await expect(engine.submitInstruction({
      message: "new generation work",
      encoded: Buffer.from("new generation work\n"),
      source: "orchestrator",
      instructionId: "after-discarded-commit",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 1 });

    lateCommit.resolve([{
      text: "turn rejected by terminal authority",
      data: { transport: "terminal-replay-fallback" },
    }]);
    await flushMicrotasks();

    expect(engine.completedTurns).toBe(0);
    expect(engine.canonicalTurns).toBe(0);
    expect(engine.waitResult(1)).toMatchObject({ completedTurns: 0 });
  });

  it("quiesces a stale native observation before a resumed instruction can reuse its ordinal", async () => {
    const oldObservation = deferred<Array<{ text: string; data: { transport: string } }>>();
    const barrierObservation = deferred<Array<{ text: string; data: { transport: string } }>>();
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      effects,
      record,
      replay,
    } = harness();
    captureProviderTurns
      .mockReturnValueOnce(oldObservation.promise)
      .mockReturnValueOnce(barrierObservation.promise);
    observations.activity = "working";
    engine.appendOutput(Buffer.from("old generation working"), replay);
    const staleReconcile = engine.reconcileCanonicalTurns();
    expect(captureProviderTurns).toHaveBeenCalledOnce();
    // A visible prompt behind the unbanked reconcile is the same target, not a second ordinal.
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("old generation prompt"), replay);

    engine.releaseTimers();
    record.executionState = "exited";
    engine.stopPendingInstructions();
    const barrier = engine.settleForResume();

    oldObservation.resolve([{
      text: "old generation answer",
      data: { transport: "provider-native" },
    }]);
    await staleReconcile;
    await flushMicrotasks();

    expect(captureProviderTurns).toHaveBeenCalledTimes(2);
    expect(commitProviderTurns).not.toHaveBeenCalled();
    expect(engine.completedTurns).toBe(0);
    expect(effects.notifyInstructionState).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: "completed" }),
    );

    barrierObservation.resolve([{
      text: "old generation answer",
      data: { transport: "provider-native" },
    }]);
    await barrier;

    expect(commitProviderTurns).toHaveBeenCalledOnce();
    expect(engine.completedTurns).toBe(1);
    expect(engine.waitResult(1)).toMatchObject({
      status: "completed",
      text: "old generation answer",
      provenance: "provider-transcript",
    });

    record.executionState = "active";
    record.exitCode = null;
    engine.resetForResume();
    engine.resetReplay("");
    await expect(engine.submitInstruction({
      message: "new generation task",
      encoded: Buffer.from("new generation task\n"),
      source: "orchestrator",
      instructionId: "new-generation",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });
    vi.mocked(effects.notifyInstructionState).mockClear();
    vi.mocked(effects.setAttention).mockClear();

    captureProviderTurns.mockResolvedValueOnce([{
      text: "new generation answer",
      data: { transport: "provider-native" },
    }]);
    observations.activity = "working";
    engine.appendOutput(Buffer.from("new generation working"), replay);
    await engine.reconcileCanonicalTurns();

    expect(engine.completedTurns).toBe(2);
    expect(engine.canonicalTurns).toBe(2);
    expect(engine.waitResult(2)).toMatchObject({
      status: "completed",
      text: "new generation answer",
      provenance: "provider-transcript",
    });
    expect(vi.mocked(effects.notifyInstructionState).mock.calls.filter(
      ([update]) => update.instructionId === "new-generation"
        && update.state === "completed"
        && update.turn === 2,
    )).toHaveLength(1);
  });

  it("fences a screen capture that returns after a resumed generation starts", async () => {
    vi.useFakeTimers();
    const oldCapture = deferred<Array<{ text: string; data: { transport: string } }>>();
    const {
      engine,
      observations,
      captureProviderTurns,
      effects,
      record,
      replay,
    } = harness({ provider: "cursor" });
    captureProviderTurns.mockReturnValueOnce(oldCapture.promise);
    observations.activity = "working";
    engine.appendOutput(Buffer.from("old turn working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("old turn prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledOnce();
    expect(engine.completedTurns).toBe(0);

    engine.releaseTimers();
    record.executionState = "exited";
    engine.stopPendingInstructions();
    record.executionState = "active";
    record.exitCode = null;
    engine.resetForResume();
    engine.resetReplay("");
    await engine.submitInstruction({
      message: "new task",
      encoded: Buffer.from("new task\n"),
      source: "orchestrator",
      instructionId: "new-screen-generation",
    });
    vi.mocked(effects.notifyInstructionState).mockClear();
    vi.mocked(effects.setAttention).mockClear();

    oldCapture.resolve([{
      text: "stale screen answer",
      data: { transport: "provider-native" },
    }]);
    await flushMicrotasks();

    expect(engine.completedTurns).toBe(0);
    expect(engine.canonicalTurns).toBe(0);
    expect(engine.projectTruth()).toMatchObject({ pendingInstructions: 1 });
    expect(engine.waitResult(1).status).not.toBe("completed");
    expect(effects.notifyInstructionState).not.toHaveBeenCalled();
    expect(effects.setAttention).not.toHaveBeenCalled();
  });

  it("hands a deferred second screen turn to a fresh capture", async () => {
    vi.useFakeTimers();
    const firstCapture = deferred<Array<{ text: string; data: { transport: string } }>>();
    const secondCapture = deferred<Array<{ text: string; data: { transport: string } }>>();
    const {
      engine,
      observations,
      captureProviderTurns,
      effects,
      replay,
    } = harness({ provider: "cursor" });
    captureProviderTurns
      .mockReturnValueOnce(firstCapture.promise)
      .mockReturnValueOnce(secondCapture.promise);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("first turn working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("first turn prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledOnce();

    await expect(engine.submitInstruction({
      message: "run the second turn",
      encoded: Buffer.from("run the second turn\n"),
      source: "orchestrator",
      instructionId: "second-turn-instruction",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });
    observations.activity = "working";
    engine.appendOutput(Buffer.from("second turn working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("second turn prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledOnce();

    firstCapture.resolve([{
      text: "first answer",
      data: { transport: "terminal-replay-fallback" },
    }]);
    await flushMicrotasks();

    expect(engine.completedTurns).toBe(1);
    expect(captureProviderTurns).toHaveBeenCalledTimes(2);
    expect(captureProviderTurns.mock.calls.map(([input]) => input.turnNumber)).toEqual([1, 2]);
    expect(engine.waitResult(2).status).not.toBe("completed");
    expect(vi.mocked(effects.notifyInstructionState).mock.calls.filter(
      ([update]) => update.instructionId === "second-turn-instruction"
        && update.state === "completed",
    )).toHaveLength(0);

    secondCapture.resolve([{
      text: "second answer",
      data: { transport: "terminal-replay-fallback" },
    }]);
    await flushMicrotasks();

    expect(engine.completedTurns).toBe(2);
    expect(engine.waitResult(2)).toMatchObject({ status: "completed", text: "second answer" });
    expect(vi.mocked(effects.notifyInstructionState).mock.calls.filter(
      ([update]) => update.instructionId === "second-turn-instruction"
        && update.state === "completed"
        && update.turn === 2,
    )).toHaveLength(1);
  });

  it("retains a deferred screen high-water mark across single-turn capture handoffs", async () => {
    vi.useFakeTimers();
    const firstCapture = deferred<Array<{ text: string; data: { transport: string } }>>();
    const secondCapture = deferred<Array<{ text: string; data: { transport: string } }>>();
    const thirdCapture = deferred<Array<{ text: string; data: { transport: string } }>>();
    const {
      engine,
      observations,
      captureProviderTurns,
      effects,
      replay,
      writes,
    } = harness({ provider: "cursor" });
    captureProviderTurns
      .mockReturnValueOnce(firstCapture.promise)
      .mockReturnValueOnce(secondCapture.promise)
      .mockReturnValueOnce(thirdCapture.promise);

    await expect(engine.submitInstruction({
      message: "run the first turn",
      encoded: Buffer.from("run the first turn\n"),
      source: "orchestrator",
      instructionId: "high-water-first",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 1 });
    observations.activity = "working";
    engine.appendOutput(Buffer.from("first turn working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("first turn prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledOnce();

    await expect(engine.submitInstruction({
      message: "run the second turn",
      encoded: Buffer.from("run the second turn\n"),
      source: "orchestrator",
      instructionId: "high-water-second",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });
    observations.activity = "working";
    engine.appendOutput(Buffer.from("second turn working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("second turn prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);

    const writesBeforeHeldThird = writes.length;
    await expect(engine.submitInstruction({
      message: "do not render while turn two is owed",
      encoded: Buffer.from("do not render while turn two is owed\n"),
      source: "orchestrator",
      instructionId: "held-third-turn",
    })).resolves.toMatchObject({ state: "queued", hold: "provider-busy" });
    expect(writes).toHaveLength(writesBeforeHeldThird);

    engine.noteRenderedInstruction({
      instructionId: "externally-rendered-third",
      expectedTurn: 3,
      renderedAt: "2026-08-20T10:02:00.000Z",
    });
    observations.activity = "working";
    engine.appendOutput(Buffer.from("third external turn working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("third external turn prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledOnce();

    firstCapture.resolve([{
      text: "first answer",
      data: { transport: "terminal-replay-fallback" },
    }]);
    await flushMicrotasks();
    expect(engine.completedTurns).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledTimes(2);
    expect(captureProviderTurns.mock.calls[1]?.[0].turnNumber).toBe(2);
    secondCapture.resolve([{
      text: "second answer",
      data: { transport: "terminal-replay-fallback" },
    }]);
    await flushMicrotasks();

    expect(engine.completedTurns).toBe(2);
    expect(engine.waitResult(2).status).not.toBe("completed");
    expect(vi.mocked(effects.notifyInstructionState).mock.calls.filter(
      ([update]) => update.instructionId === "high-water-second"
        && update.state === "completed"
        && update.turn === 2,
    )).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledTimes(3);
    expect(captureProviderTurns.mock.calls[2]?.[0].turnNumber).toBe(3);
    thirdCapture.resolve([{
      text: "third answer",
      data: { transport: "terminal-replay-fallback" },
    }]);
    await flushMicrotasks();

    expect(captureProviderTurns.mock.calls.map(([input]) => input.turnNumber)).toEqual([1, 2, 3]);
    expect(engine.completedTurns).toBe(3);
    expect(engine.waitResult(3)).toMatchObject({ status: "completed", text: "third answer" });
    expect(vi.mocked(effects.notifyInstructionState).mock.calls.filter(
      ([update]) => update.instructionId === "high-water-first"
        && update.state === "completed"
        && update.turn === 1,
    )).toHaveLength(1);
    expect(vi.mocked(effects.notifyInstructionState).mock.calls.filter(
      ([update]) => update.instructionId === "externally-rendered-third"
        && update.state === "completed"
        && update.turn === 3,
    )).toHaveLength(1);
    expect(vi.mocked(effects.notifyInstructionState).mock.calls.filter(
      ([update]) => update.instructionId === "held-third-turn"
        && update.state === "completed",
    )).toHaveLength(0);
  });

  it("re-arms a later screen turn after a committed reconcile releases ownership", async () => {
    vi.useFakeTimers();
    const reconciledEvent = deferred<void>();
    const {
      engine,
      observations,
      captureProviderTurns,
      effects,
      replay,
    } = harness();
    captureProviderTurns
      .mockResolvedValueOnce([{
        text: "first canonical answer",
        data: { transport: "provider-native" },
      }])
      .mockResolvedValueOnce([{
        text: "second screen answer",
        data: { transport: "terminal-replay-fallback" },
      }]);
    vi.mocked(effects.appendEvent).mockImplementation((type) =>
      type === "session.turn_reconciled" ? reconciledEvent.promise : Promise.resolve());

    observations.activity = "working";
    engine.appendOutput(Buffer.from("first turn still looked busy"), replay);
    const reconcile = engine.reconcileCanonicalTurns();
    await flushMicrotasks();

    expect(engine.completedTurns).toBe(1);
    expect(effects.appendEvent).toHaveBeenCalledWith(
      "session.turn_reconciled",
      expect.objectContaining({ completionTarget: 1 }),
    );
    await expect(engine.submitInstruction({
      message: "run the second turn",
      encoded: Buffer.from("run the second turn\n"),
      source: "orchestrator",
      instructionId: "post-reconcile-second-turn",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });

    observations.activity = "working";
    engine.appendOutput(Buffer.from("second turn working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("second turn prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledOnce();

    reconciledEvent.resolve();
    await reconcile;

    expect(engine.completedTurns).toBe(1);
    expect(engine.waitResult(2).status).not.toBe("completed");
    expect(vi.mocked(effects.notifyInstructionState).mock.calls.filter(
      ([update]) => update.instructionId === "post-reconcile-second-turn"
        && update.state === "completed",
    )).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks();

    expect(captureProviderTurns).toHaveBeenCalledTimes(2);
    expect(captureProviderTurns.mock.calls.map(([input]) => input.turnNumber)).toEqual([1, 2]);
    expect(engine.completedTurns).toBe(2);
    expect(engine.waitResult(2)).toMatchObject({
      status: "completed",
      text: "second screen answer",
    });
    expect(vi.mocked(effects.notifyInstructionState).mock.calls.filter(
      ([update]) => update.instructionId === "post-reconcile-second-turn"
        && update.state === "completed"
        && update.turn === 2,
    )).toHaveLength(1);
  });

  it("advances later screen deferrals behind the same unbanked reconcile", async () => {
    vi.useFakeTimers();
    const reconcileCapture = deferred<Array<{ text: string; data: { transport: string } }>>();
    const {
      engine,
      observations,
      captureProviderTurns,
      effects,
      replay,
    } = harness();
    captureProviderTurns
      .mockReturnValueOnce(reconcileCapture.promise)
      .mockResolvedValueOnce([{
        text: "second screen answer",
        data: { transport: "terminal-replay-fallback" },
      }]);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("reconcile still reading turn one"), replay);
    const reconcile = engine.reconcileCanonicalTurns();
    expect(captureProviderTurns).toHaveBeenCalledOnce();

    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("first visible prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    engine.noteRenderedInstruction({
      instructionId: "pre-commit-second-turn",
      expectedTurn: 2,
      renderedAt: "2026-08-20T10:03:00.000Z",
    });
    observations.activity = "working";
    engine.appendOutput(Buffer.from("second external turn working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("second external prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledOnce();

    reconcileCapture.resolve([{
      text: "first canonical answer",
      data: { transport: "provider-native" },
    }]);
    await reconcile;

    expect(engine.completedTurns).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks();

    expect(captureProviderTurns).toHaveBeenCalledTimes(2);
    expect(captureProviderTurns.mock.calls.map(([input]) => input.turnNumber)).toEqual([1, 2]);
    expect(engine.completedTurns).toBe(2);
    expect(engine.waitResult(2)).toMatchObject({
      status: "completed",
      text: "second screen answer",
    });
    expect(vi.mocked(effects.notifyInstructionState).mock.calls.filter(
      ([update]) => update.instructionId === "pre-commit-second-turn"
        && update.state === "completed"
        && update.turn === 2,
    )).toHaveLength(1);
  });

  it("fences owner-free preview and model reads across a capture ownership cycle", async () => {
    const oldTranscript = deferred<Array<{ role: "assistant"; text: string }>>();
    const oldModel = deferred<NonNullable<SessionRecord["observedModel"]>>();
    const preview: WorkerTurnPreviewPort = {
      preview: (input) => {
        const text = input.transcript?.at(-1)?.text;
        if (text === "fresh canonical answer") {
          return { kind: "assistant", text: "fresh preview" };
        }
        if (text === "stale transcript answer") {
          return { kind: "assistant", text: "stale preview" };
        }
        return { kind: "none", text: "" };
      },
    };
    const {
      engine,
      observations,
      captureProviderTurns,
      readObservedModel,
      readTranscriptMessages,
      record,
      replay,
    } = harness({}, { preview });
    const freshModel = {
      model: "gpt-5.6-sol",
      effort: "high" as const,
      observedAt: "2026-08-20T10:01:00.000Z",
    };
    readTranscriptMessages.mockReturnValueOnce(oldTranscript.promise);
    readObservedModel
      .mockReturnValueOnce(oldModel.promise)
      .mockResolvedValueOnce(freshModel);
    captureProviderTurns.mockResolvedValueOnce([{
      text: "fresh canonical answer",
      data: { transport: "provider-native" },
    }]);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("working"), replay);
    observations.activity = "needs-input";
    engine.appendOutput(Buffer.from("old modal frame"), replay);
    expect(readTranscriptMessages).toHaveBeenCalledOnce();
    expect(readObservedModel).toHaveBeenCalledOnce();

    await engine.reconcileCanonicalTurns();

    expect(record.latestPreview).toBe("fresh preview");
    expect(record.observedModel).toEqual(freshModel);
    expect(readObservedModel.mock.calls.map(([input]) => input.turnNumber)).toEqual([0, 1]);

    oldTranscript.resolve([{ role: "assistant", text: "stale transcript answer" }]);
    oldModel.resolve({
      model: "stale-model",
      effort: "low",
      observedAt: "2026-08-20T09:59:00.000Z",
    });
    await flushMicrotasks();

    expect(record.latestPreview).toBe("fresh preview");
    expect(record.observedModel).toEqual(freshModel);
  });

  it("does not recapture a deferred turn already covered by a multi-turn capture", async () => {
    vi.useFakeTimers();
    const firstCapture = deferred<Array<{ text: string; data: { transport: string } }>>();
    const {
      engine,
      observations,
      captureProviderTurns,
      effects,
      replay,
    } = harness({ provider: "cursor" });
    captureProviderTurns.mockReturnValueOnce(firstCapture.promise);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("first turn working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("first turn prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    await expect(engine.submitInstruction({
      message: "run the covered second turn",
      encoded: Buffer.from("run the covered second turn\n"),
      source: "orchestrator",
      instructionId: "covered-second-turn",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });
    observations.activity = "working";
    engine.appendOutput(Buffer.from("second turn working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("second turn prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);

    firstCapture.resolve([
      { text: "first native answer", data: { transport: "provider-native" } },
      { text: "second native answer", data: { transport: "provider-native" } },
    ]);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(500);

    expect(captureProviderTurns).toHaveBeenCalledOnce();
    expect(engine.completedTurns).toBe(2);
    expect(engine.canonicalTurns).toBe(2);
    expect(engine.waitResult(2)).toMatchObject({ status: "completed", text: "second native answer" });
    expect(vi.mocked(effects.notifyInstructionState).mock.calls.filter(
      ([update]) => update.instructionId === "covered-second-turn"
        && update.state === "completed"
        && update.turn === 2,
    )).toHaveLength(1);
  });

  it("banks an enqueued stale receipt but fences every generation-local effect", async () => {
    vi.useFakeTimers();
    const commitGate = deferred<WorkerTurnTranscript[]>();
    const preview: WorkerTurnPreviewPort = {
      preview: vi.fn(() => ({ kind: "assistant" as const, text: "must stay fenced" })),
    };
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      effects,
      readObservedModel,
      replay,
    } = harness({ provider: "cursor" }, { preview });
    captureProviderTurns.mockResolvedValue([
      { text: "old one", data: { transport: "provider-native" } },
      { text: "old two", data: { transport: "provider-native" } },
    ]);
    commitProviderTurns.mockReturnValueOnce(commitGate.promise);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("old work"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("old prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    expect(commitProviderTurns).toHaveBeenCalledOnce();

    let settled = false;
    const settlement = engine.settlePendingTurnCommit().then(() => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBe(false);

    engine.releaseTimers();
    await expect(engine.submitInstruction({
      message: "new generation work",
      encoded: Buffer.from("new generation work\n"),
      source: "orchestrator",
      instructionId: "after-stale-commit",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 3 });
    vi.mocked(effects.notifyInstructionState).mockClear();
    vi.mocked(effects.setAttention).mockClear();
    vi.mocked(preview.preview).mockClear();
    readObservedModel.mockClear();

    commitGate.resolve([
      { text: "old one", data: { transport: "provider-native" } },
      { text: "old two", data: { transport: "provider-native" } },
    ]);
    await settlement;
    await flushMicrotasks();

    expect(settled).toBe(true);
    expect(engine.completedTurns).toBe(2);
    expect(engine.waitResult(2)).toMatchObject({
      status: "waiting",
      text: "old two",
      provenance: "provider-transcript",
    });
    expect(engine.waitResult(3).status).not.toBe("completed");
    expect(effects.notifyInstructionState).not.toHaveBeenCalledWith(
      expect.objectContaining({ instructionId: "after-stale-commit", state: "completed" }),
    );
    expect(preview.preview).not.toHaveBeenCalled();
    expect(readObservedModel).not.toHaveBeenCalled();
    expect(effects.setAttention).not.toHaveBeenCalled();
  });

  it("clears a definite synchronous commit failure and uses terminal fallback", async () => {
    vi.useFakeTimers();
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      replay,
      writes,
    } = harness({ provider: "cursor" });
    captureProviderTurns.mockResolvedValue([{
      text: "candidate",
      data: { transport: "provider-native" },
    }]);
    commitProviderTurns.mockImplementationOnce(() => {
      throw new Error("commit did not start");
    });

    observations.activity = "working";
    engine.appendOutput(Buffer.from("fallback work"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("fallback prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks();

    await expect(engine.settlePendingTurnCommit()).resolves.toBeUndefined();
    expect(engine.completedTurns).toBe(1);
    expect(engine.waitResult(1)).toMatchObject({
      status: "completed",
      provenance: "terminal-replay",
      text: "fallback workfallback prompt",
    });
  });

  it("poisons an indeterminate asynchronous commit failure without reusing its ordinal", async () => {
    vi.useFakeTimers();
    const failure = new Error("write rejected after enqueue");
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      replay,
      writes,
    } = harness({ provider: "cursor" });
    captureProviderTurns.mockResolvedValue([{
      text: "possibly durable",
      data: { transport: "provider-native" },
    }]);
    commitProviderTurns.mockRejectedValueOnce(failure);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("indeterminate work"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("indeterminate prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks();

    await expect(engine.settlePendingTurnCommit()).rejects.toBe(failure);
    expect(engine.completedTurns).toBe(0);
    await expect(engine.submitInstruction({
      message: "must not reuse one",
      encoded: Buffer.from("must not reuse one\n"),
      source: "orchestrator",
      instructionId: "after-rejected-commit",
    })).resolves.toMatchObject({ state: "queued", hold: "provider-busy" });
    expect(writes).toEqual([]);
  });

  it.each([
    ["empty", []],
    ["partial", [{ text: "only first", data: { transport: "provider-native" } }]],
  ])("poisons an %s successful receipt and banks only its exact prefix", async (_label, receipt) => {
    vi.useFakeTimers();
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      replay,
      writes,
    } = harness({ provider: "cursor" });
    captureProviderTurns.mockResolvedValue([
      { text: "first candidate", data: { transport: "provider-native" } },
      { text: "second candidate", data: { transport: "provider-native" } },
    ]);
    commitProviderTurns.mockResolvedValueOnce(receipt);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("receipt work"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("receipt prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks();

    await expect(engine.settlePendingTurnCommit()).rejects.toThrow(
      "Provider turn commit receipt did not account for every reserved ordinal",
    );
    expect(engine.completedTurns).toBe(receipt.length);
    if (receipt.length === 1) {
      expect(engine.waitResult(1)).toMatchObject({ status: "completed", text: "only first" });
    }
    await expect(engine.submitInstruction({
      message: "after poisoned receipt",
      encoded: Buffer.from("after poisoned receipt\n"),
      source: "orchestrator",
      instructionId: `after-${_label}-receipt`,
    })).resolves.toMatchObject({ state: "queued", hold: "provider-busy" });
    expect(writes).toEqual([]);
  });

  it("drains deferred old-generation high-water before exposing resumed input", async () => {
    vi.useFakeTimers();
    const firstCommit = deferred<WorkerTurnTranscript[]>();
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      record,
      replay,
    } = harness();
    captureProviderTurns
      .mockResolvedValueOnce([{
        text: "old first",
        data: { transport: "provider-native" },
      }])
      .mockResolvedValueOnce([{
        text: "old deferred second",
        data: { transport: "provider-native" },
      }]);
    commitProviderTurns.mockReturnValueOnce(firstCommit.promise);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("first work"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("first prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    expect(commitProviderTurns).toHaveBeenCalledOnce();

    observations.activity = "working";
    engine.appendOutput(Buffer.from("second work"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("second prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledOnce();

    record.executionState = "exited";
    engine.releaseTimers();
    let barrierSettled = false;
    const barrier = engine.settleForResume().then(() => { barrierSettled = true; });
    await flushMicrotasks();
    expect(barrierSettled).toBe(false);

    firstCommit.resolve([{
      text: "old first",
      data: { transport: "provider-native" },
    }]);
    await barrier;

    expect(barrierSettled).toBe(true);
    expect(captureProviderTurns.mock.calls.map(([input]) => input.turnNumber)).toEqual([1, 2]);
    expect(commitProviderTurns).toHaveBeenCalledTimes(2);
    expect(engine.completedTurns).toBe(2);
    expect(engine.waitResult(2)).toMatchObject({
      status: "completed",
      text: "old deferred second",
    });

    record.executionState = "active";
    record.exitCode = null;
    engine.resetForResume();
    engine.resetReplay("");
    await expect(engine.submitInstruction({
      message: "new generation first",
      encoded: Buffer.from("new generation first\n"),
      source: "orchestrator",
      instructionId: "after-deferred-barrier",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 3 });
  });

  it("releases an empty speculative reconcile without inventing a resume ordinal", async () => {
    const emptyObservation = deferred<Array<{ text: string; data: { transport: string } }>>();
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      record,
      replay,
    } = harness();
    captureProviderTurns.mockReturnValueOnce(emptyObservation.promise);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("speculative reconcile"), replay);
    const reconcile = engine.reconcileCanonicalTurns();
    expect(captureProviderTurns).toHaveBeenCalledOnce();

    record.executionState = "exited";
    engine.releaseTimers();
    const barrier = engine.settleForResume();
    emptyObservation.resolve([]);

    await reconcile;
    await expect(barrier).resolves.toBeUndefined();
    expect(commitProviderTurns).not.toHaveBeenCalled();
    expect(engine.completedTurns).toBe(0);

    record.executionState = "active";
    record.exitCode = null;
    engine.resetForResume();
    await expect(engine.submitInstruction({
      message: "first real resumed turn",
      encoded: Buffer.from("first real resumed turn\n"),
      source: "orchestrator",
      instructionId: "after-empty-reconcile",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 1 });
  });

  it("freezes an armed screen-bank ordinal when resume beats the timer", async () => {
    vi.useFakeTimers();
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      record,
      replay,
    } = harness();
    captureProviderTurns.mockResolvedValueOnce([{
      text: "old prompt result",
      data: { transport: "provider-native" },
    }]);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("old work"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("old prompt"), replay);
    expect(captureProviderTurns).not.toHaveBeenCalled();

    record.executionState = "exited";
    await engine.settleForResume();

    expect(captureProviderTurns).toHaveBeenCalledOnce();
    expect(commitProviderTurns).toHaveBeenCalledOnce();
    expect(engine.completedTurns).toBe(1);
    expect(engine.waitResult(1)).toMatchObject({
      status: "completed",
      text: "old prompt result",
    });

    record.executionState = "active";
    record.exitCode = null;
    engine.resetForResume();
    await expect(engine.submitInstruction({
      message: "new work after fast resume",
      encoded: Buffer.from("new work after fast resume\n"),
      source: "orchestrator",
      instructionId: "after-armed-screen-bank",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });
  });

  it("drains a screen-proven Codex barrier from frozen replay when native truth never lands", async () => {
    vi.useFakeTimers();
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      record,
      replay,
    } = harness();
    captureProviderTurns.mockImplementation(async (input) => input.allowFallback === true
      ? [{ text: input.fallbackText, data: { transport: "terminal-replay-fallback" } }]
      : []);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("old Codex work"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("old Codex fallback answer"), replay);
    record.executionState = "exited";
    const frozenOutgoingReplay = "exact raw outgoing Codex fallback";
    const barrier = engine.settleForResume(frozenOutgoingReplay);
    await vi.runAllTimersAsync();
    await barrier;

    expect(captureProviderTurns.mock.calls.map(([input]) => input.allowFallback))
      .toEqual([false, false, false, true]);
    expect(captureProviderTurns.mock.calls.at(-1)?.[0]).toMatchObject({
      turnNumber: 1,
      fallbackText: frozenOutgoingReplay,
      allowFallback: true,
    });
    expect(commitProviderTurns).toHaveBeenCalledOnce();
    expect(commitProviderTurns.mock.calls[0]?.[0]).toMatchObject({
      turnNumber: 1,
      turns: [{ text: frozenOutgoingReplay, transport: "terminal-replay-fallback" }],
    });
    expect(engine.waitResult(1)).toMatchObject({
      status: "completed",
      provenance: "terminal-replay",
      text: frozenOutgoingReplay,
    });

    record.executionState = "active";
    record.exitCode = null;
    engine.resetForResume();
    engine.resetReplay("");
    await expect(engine.submitInstruction({
      message: "new task after fallback drain",
      encoded: Buffer.from("new task after fallback drain\n"),
      source: "orchestrator",
      instructionId: "after-fallback-barrier",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });
  });

  it("keeps distinct fallback evidence for two old screen-proven ordinals", async () => {
    vi.useFakeTimers();
    const firstObservation = deferred<Array<{ text: string; data: { transport: string } }>>();
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      record,
      replay,
    } = harness();
    let first = true;
    captureProviderTurns.mockImplementation(async (input) => {
      if (first) {
        first = false;
        return firstObservation.promise;
      }
      return input.allowFallback === true
        ? [{ text: input.fallbackText, data: { transport: "terminal-replay-fallback" } }]
        : [];
    });

    observations.activity = "working";
    engine.appendOutput(Buffer.from("turn one working"), () => "turn one working raw");
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("turn one complete"), () => "old@1 exact fallback");
    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledOnce();

    observations.activity = "working";
    engine.appendOutput(Buffer.from("turn two working"), () => "turn two working raw");
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("turn two complete"), () => "old@2 exact fallback");
    await vi.advanceTimersByTimeAsync(200);
    expect(captureProviderTurns).toHaveBeenCalledOnce();

    record.executionState = "exited";
    const barrier = engine.settleForResume("latest outgoing raw replay");
    firstObservation.resolve([]);
    await vi.runAllTimersAsync();
    await barrier;

    expect(captureProviderTurns.mock.calls
      .filter(([input]) => input.allowFallback === true)
      .map(([input]) => ({ turnNumber: input.turnNumber, fallbackText: input.fallbackText })))
      .toEqual([
        { turnNumber: 1, fallbackText: "old@1 exact fallback" },
        { turnNumber: 2, fallbackText: "old@2 exact fallback" },
      ]);
    expect(commitProviderTurns.mock.calls.map(([observation]) => ({
      turnNumber: observation.turnNumber,
      text: observation.turns[0]?.text,
    }))).toEqual([
      { turnNumber: 1, text: "old@1 exact fallback" },
      { turnNumber: 2, text: "old@2 exact fallback" },
    ]);
    expect(engine.waitResult(1)).toMatchObject({
      status: "completed",
      text: "old@1 exact fallback",
      provenance: "terminal-replay",
    });
    expect(engine.waitResult(2)).toMatchObject({
      status: "completed",
      text: "old@2 exact fallback",
      provenance: "terminal-replay",
    });

    record.executionState = "active";
    record.exitCode = null;
    engine.resetForResume();
    engine.resetReplay("");
    await expect(engine.submitInstruction({
      message: "new generation after two old turns",
      encoded: Buffer.from("new generation after two old turns\n"),
      source: "orchestrator",
      instructionId: "after-two-screen-fallbacks",
    })).resolves.toMatchObject({ state: "rendered", expectedTurn: 3 });
  });

  it("drains a three-turn screen backlog from oldest exact evidence before publishing done", async () => {
    vi.useFakeTimers();
    const firstObservation = deferred<Array<{ text: string; data: { transport: string } }>>();
    const secondObservation = deferred<Array<{ text: string; data: { transport: string } }>>();
    const thirdObservation = deferred<Array<{ text: string; data: { transport: string } }>>();
    const {
      engine,
      observations,
      captureProviderTurns,
      commitProviderTurns,
      effects,
      replay,
    } = harness();
    captureProviderTurns
      .mockReturnValueOnce(firstObservation.promise)
      .mockReturnValueOnce(secondObservation.promise)
      .mockReturnValueOnce(thirdObservation.promise);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("turn one working"), replay);
    await expect(engine.submitInstruction({
      message: "wait behind the old backlog",
      encoded: Buffer.from("wait behind the old backlog\n"),
      source: "orchestrator",
      instructionId: "held-through-three-turn-backlog",
    })).resolves.toMatchObject({ state: "queued", hold: "provider-busy" });
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("turn one complete"), () => "old@1 backlog text");
    await vi.advanceTimersByTimeAsync(200);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("turn two working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("turn two complete"), () => "old@2 backlog text");
    await vi.advanceTimersByTimeAsync(200);
    observations.activity = "working";
    engine.appendOutput(Buffer.from("turn three working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("turn three complete"), () => "old@3 backlog text");
    await vi.advanceTimersByTimeAsync(200);

    vi.mocked(effects.setAttention).mockClear();
    vi.mocked(effects.notifyDeliveryBoundary).mockClear();
    firstObservation.resolve([{
      text: "old@1 provider text",
      data: { transport: "provider-native" },
    }]);
    await flushMicrotasks();

    expect(engine.completedTurns).toBe(1);
    expect(captureProviderTurns.mock.calls[1]?.[0]).toMatchObject({
      turnNumber: 2,
      fallbackText: "old@2 backlog text",
    });
    expect(effects.setAttention).not.toHaveBeenCalledWith("done", true);
    expect(effects.notifyDeliveryBoundary).not.toHaveBeenCalled();

    secondObservation.resolve([{
      text: "old@2 backlog text",
      data: { transport: "terminal-replay-fallback" },
    }]);
    await flushMicrotasks();
    expect(engine.completedTurns).toBe(2);
    expect(captureProviderTurns.mock.calls[2]?.[0]).toMatchObject({
      turnNumber: 3,
      fallbackText: "old@3 backlog text",
    });
    expect(effects.setAttention).not.toHaveBeenCalledWith("done", true);
    expect(effects.notifyDeliveryBoundary).not.toHaveBeenCalled();

    thirdObservation.resolve([{
      text: "old@3 backlog text",
      data: { transport: "terminal-replay-fallback" },
    }]);
    await flushMicrotasks();
    expect(engine.completedTurns).toBe(3);
    expect(commitProviderTurns.mock.calls.map(([observation]) => ({
      turnNumber: observation.turnNumber,
      text: observation.turns[0]?.text,
    }))).toEqual([
      { turnNumber: 1, text: "old@1 provider text" },
      { turnNumber: 2, text: "old@2 backlog text" },
      { turnNumber: 3, text: "old@3 backlog text" },
    ]);
    expect(effects.setAttention).toHaveBeenCalledWith("done", true);
    expect(effects.notifyDeliveryBoundary).toHaveBeenCalledOnce();
    expect(engine.waitResult(2)).toMatchObject({ text: "old@2 backlog text" });
    expect(engine.waitResult(3)).toMatchObject({ text: "old@3 backlog text" });
  });

  it("keeps newer working activity ahead while draining older exact evidence", async () => {
    vi.useFakeTimers();
    const oldObservation = deferred<Array<{ text: string; data: { transport: string } }>>();
    const deferredObservation = deferred<Array<{ text: string; data: { transport: string } }>>();
    const {
      engine,
      observations,
      captureProviderTurns,
      effects,
      readObservedModel,
      readTranscriptMessages,
      replay,
      writes,
    } = harness();
    captureProviderTurns
      .mockReturnValueOnce(oldObservation.promise)
      .mockReturnValueOnce(deferredObservation.promise);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("turn one working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("turn one complete"), replay);
    await vi.advanceTimersByTimeAsync(200);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("turn two working"), replay);
    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("turn two complete"), () => "old@2 exact before turn three");
    await vi.advanceTimersByTimeAsync(200);

    // Turn three is live but its latest redraw is temporarily marker-free. `observedWorking` is the
    // only thing protecting its composer, so an old receipt must not clear it or publish Done.
    observations.activity = "working";
    engine.appendOutput(Buffer.from("turn three working"), replay);
    observations.activity = "unknown";
    engine.appendOutput(Buffer.from("turn three marker-free redraw"), replay);
    await expect(engine.submitInstruction({
      message: "must remain behind turn three",
      encoded: Buffer.from("must remain behind turn three\n"),
      source: "orchestrator",
      instructionId: "held-behind-newer-activity",
    })).resolves.toMatchObject({ state: "queued", hold: "provider-busy" });
    vi.mocked(effects.setAttention).mockClear();
    vi.mocked(effects.notifyDeliveryBoundary).mockClear();
    readObservedModel.mockClear();
    readTranscriptMessages.mockClear();

    oldObservation.resolve([
      { text: "old turn one", data: { transport: "provider-native" } },
    ]);
    await flushMicrotasks();

    expect(engine.completedTurns).toBe(1);
    expect(captureProviderTurns.mock.calls[1]?.[0]).toMatchObject({
      turnNumber: 2,
      fallbackText: "old@2 exact before turn three",
    });
    deferredObservation.resolve([{
      text: "old turn two",
      data: { transport: "provider-native" },
    }]);
    await flushMicrotasks();

    expect(engine.completedTurns).toBe(2);
    expect(effects.setAttention).not.toHaveBeenCalledWith("done", true);
    expect(effects.notifyDeliveryBoundary).not.toHaveBeenCalled();
    expect(readObservedModel).not.toHaveBeenCalled();
    expect(readTranscriptMessages).not.toHaveBeenCalled();
    await expect(engine.submitInstruction({
      message: "still behind turn three",
      encoded: Buffer.from("still behind turn three\n"),
      source: "orchestrator",
      instructionId: "still-held-behind-newer-activity",
    })).resolves.toMatchObject({ state: "queued", hold: "provider-busy" });
    expect(writes).toEqual([]);
  });

  it("does not reserve semantic resume ordinals for incomplete Scout screen claims or timers", async () => {
    vi.useFakeTimers();
    const active = harness({ profile: "scout" });
    active.observations.activity = "working";
    active.engine.appendOutput(Buffer.from("scout working"), active.replay);
    active.observations.activity = "awaiting-input";
    active.engine.appendOutput(Buffer.from("scout screen result"), active.replay);
    vi.advanceTimersByTime(200);
    active.record.executionState = "exited";
    await expect(active.engine.settleForResume("raw active Scout screen"))
      .resolves.toBeUndefined();
    expect(active.captureProviderTurns).not.toHaveBeenCalled();
    expect(active.commitProviderTurns).not.toHaveBeenCalled();
    expect(active.engine.completedTurns).toBe(0);

    const armed = harness({ profile: "scout" });
    armed.observations.activity = "working";
    armed.engine.appendOutput(Buffer.from("armed scout working"), armed.replay);
    armed.observations.activity = "awaiting-input";
    armed.engine.appendOutput(Buffer.from("armed scout screen result"), armed.replay);
    armed.record.executionState = "exited";
    await expect(armed.engine.settleForResume("raw armed Scout screen"))
      .resolves.toBeUndefined();
    expect(armed.captureProviderTurns).not.toHaveBeenCalled();
    expect(armed.commitProviderTurns).not.toHaveBeenCalled();
    expect(armed.engine.completedTurns).toBe(0);
  });

  it("finishes completion effects before releasing queued delivery", async () => {
    vi.useFakeTimers();
    const transcriptGate = deferred<Array<{ role: "assistant"; text: string }>>();
    const modelGate = deferred<NonNullable<SessionRecord["observedModel"]>>();
    const preview: WorkerTurnPreviewPort = {
      preview: vi.fn(() => ({ kind: "none" as const, text: "" })),
    };
    const {
      engine,
      observations,
      captureProviderTurns,
      effects,
      readObservedModel,
      readTranscriptMessages,
      replay,
    } = harness({}, { preview });
    captureProviderTurns.mockResolvedValue([{
      text: "completed first turn",
      data: { transport: "provider-native" },
    }]);
    readTranscriptMessages.mockReturnValueOnce(transcriptGate.promise);
    readObservedModel.mockReturnValueOnce(modelGate.promise);

    observations.activity = "working";
    engine.appendOutput(Buffer.from("first work"), replay);
    await expect(engine.submitInstruction({
      message: "queued second turn",
      encoded: Buffer.from("queued second turn\n"),
      source: "orchestrator",
      instructionId: "queued-after-effects",
    })).resolves.toMatchObject({ state: "queued", hold: "provider-busy" });

    let redelivery: ReturnType<WorkerTurnEngine["submitInstruction"]> | undefined;
    vi.mocked(effects.notifyDeliveryBoundary).mockImplementation(() => {
      redelivery = engine.submitInstruction({
        message: "queued second turn",
        encoded: Buffer.from("queued second turn\n"),
        source: "orchestrator",
        instructionId: "queued-after-effects",
      });
    });
    vi.mocked(effects.setAttention).mockClear();

    observations.activity = "awaiting-input";
    engine.appendOutput(Buffer.from("first prompt"), replay);
    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks();

    expect(readTranscriptMessages).toHaveBeenCalledOnce();
    expect(effects.notifyDeliveryBoundary).not.toHaveBeenCalled();
    expect(redelivery).toBeUndefined();

    transcriptGate.resolve([]);
    await flushMicrotasks();
    expect(readObservedModel).toHaveBeenCalledOnce();
    expect(effects.notifyDeliveryBoundary).not.toHaveBeenCalled();

    modelGate.resolve({
      model: "gpt-5.6-sol",
      effort: "high",
      observedAt: "2026-08-20T10:30:00.000Z",
    });
    await flushMicrotasks();
    await expect(redelivery).resolves.toMatchObject({ state: "rendered", expectedTurn: 2 });

    expect(effects.notifyDeliveryBoundary).toHaveBeenCalledOnce();
    expect(vi.mocked(effects.setAttention).mock.calls.map(([state]) => state))
      .toEqual(["done", "working"]);
    expect(engine.waitResult(2).status).not.toBe("completed");
  });
});
