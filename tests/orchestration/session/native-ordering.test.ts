import { SessionLifecycleController } from "../../../src/orchestration/session/session-lifecycle-controller.js";
import { SessionRuntimeAssembly } from "../../../src/orchestration/session/session-runtime-assembly.js";
import { ContainerNativeSource } from "../../../src/runtime/activity/container-native-source.js";
import { ExecutionTranscriptStore } from "../../../src/persistence/execution-transcript-store.js";
import { SessionIoSurface } from "../../../src/orchestration/session/session-io-surface.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile, stat, unlink, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerLedgerStore } from "../../../src/persistence/worker-ledger-store.js";
import { ThreadTranscriptStore } from "../../../src/persistence/thread-transcript-store.js";
import type { SessionRecord } from "../../../src/domain/session.js";
import { DELIVERY_HOLD_DETAIL } from "../../../src/domain/worker-truth.js";
import type {
  ReplayObservation,
  WorkerTurnEngineEffects,
  WorkerTurnObservationPort,
  WorkerTurnPreviewPort,
  WorkerTurnTranscript,
  WorkerTurnLedger,
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
  options: { preview?: WorkerTurnPreviewPort; transcripts?: WorkerTurnTranscriptPort; tokenCount?: number } = {},
) {
  let frame = "";
  let activity: ReturnType<WorkerTurnObservationPort["activity"]> = "unknown";
  let composer: ReturnType<WorkerTurnObservationPort["composer"]> = {
    modalOpen: false,
    occupied: false,
    // These scenarios exercise an already recognized input surface. Startup uses real terminal
    // observations in provider-startup-readiness.test.ts.
    inputReady: true,
  };
  const replay: ReplayObservation = {
    appendBytes: (chunk) => { frame += chunk.toString("utf8"); },
    reset: (next) => { frame = next; },
    frameText: () => frame,
    strippedTail: (maxChars) => ({
      text: frame.slice(-maxChars),
      truncated: frame.length > maxChars,
    }),
    tokenCount: () => options.tokenCount,
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
    transcripts: options.transcripts ?? transcripts,
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
const roots: string[] = [];

afterEach(async () => {
  while (engines.length > 0) engines.pop()?.releaseTimers();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});


function nativeObservation(activity: "idle" | "working", turns: boolean = false) {
  return {sessionId: sessionRecord().id, provider: "codex" as const, turnNumber: 1,
    nativeSourceAvailable: true, activityVersion: "unchanged",
    nativeActivity: activity,
    nativeActivityEvidence: {id: activity === "idle" ? "old" : "new", kind: activity === "idle" ? "task_complete" as const : "task_started" as const, occurredAt: "2026-08-20T09:00:01.000Z"},
    turns: turns ? [{providerTurnId: "old", providerOccurredAt:"2026-08-20T09:00:01.000Z", text:"old completion", transport:"provider-native" as const}] : []};
}
describe("independent native integration regressions", () => {
  it("does not replace current working controls with an unchanged old native idle record", async () => {
    const f=harness();
    f.engine.finishInitialization();
    f.observeProviderTurns.mockResolvedValue(nativeObservation("idle"));
    await f.engine.reconcileCanonicalTurns();
    f.observations.activity="working";
    f.observations.composer={modalOpen:false,occupied:false,inputReady:false};
    f.engine.appendOutput(Buffer.from("current working controls"));
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.projectTruth().state).not.toBe("idle");
  });
  it("notifies session update when a poll banks old completion while finding newer task_started", async () => {
    const f=harness();
    f.engine.finishInitialization();
    f.observations.composer={modalOpen:false,occupied:false,inputReady:false};
    f.observeProviderTurns.mockResolvedValue(nativeObservation("working",true));
    const notified: unknown[]=[];
    vi.mocked(f.effects.notifySessionUpdate).mockImplementation(() => { notified.push(f.engine.projectTruth()); });
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.completedTurns).toBe(1);
    expect(f.engine.projectTruth().state).toBe("working");
    expect(notified).toEqual(expect.arrayContaining([expect.objectContaining({completedTurns:1,state:"working"})]));
  });
  it("uses newer native task_started from screen-triggered capture, not old completion as current idle", async () => {
    vi.useFakeTimers();
    const f=harness();
    f.engine.finishInitialization();
    f.observeProviderTurns.mockResolvedValue(nativeObservation("working",true));
    f.observations.activity="working";
    f.engine.appendOutput(Buffer.from("working"));
    f.observations.activity="awaiting-input";
    f.engine.appendOutput(Buffer.from("old turn final repaint"));
    await vi.advanceTimersByTimeAsync(200);
    await flushMicrotasks();
    expect(f.engine.completedTurns).toBe(1);
    expect(f.engine.projectTruth().state).toBe("working");
    expect(f.effects.setAttention).not.toHaveBeenCalledWith("done",true);
  });
  it("allows next instruction after native turn_aborted settles an observed working turn", async () => {
    const f=harness();
    f.engine.finishInitialization();
    f.observeProviderTurns.mockResolvedValue(nativeObservation("working"));
    await f.engine.reconcileCanonicalTurns();
    const stopped={...nativeObservation("idle"), nativeActivityEvidence:{id:"abort",kind:"turn_aborted" as const,occurredAt:"2026-08-20T09:00:02.000Z"}, turns: [{providerTurnId:"aborted",providerOccurredAt:"2026-08-20T09:00:02.000Z",text:"cancelled",transport:"provider-native" as const,data:{outcome:"cancelled",nativeActivityId:"abort"}}]};
    f.observeProviderTurns.mockResolvedValue(stopped);
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.projectTruth().state).toBe("idle");
    f.observeProviderTurns.mockImplementation(async input => ({ ...stopped, turnNumber: input.turnNumber }));
    const delivered=await f.engine.submitInstruction({source:"orchestrator",message:"next",encoded:Buffer.from("next"),instructionId:"next"});
    expect(delivered.state).toBe("rendered");
  });
});

describe("independent quiet container and old-generation effects", () => {
  it("polls exact native truth for a container even without terminal output", async () => {
    vi.useFakeTimers();
    const f=harness({executor:"orbstack-container"});
    f.engine.finishInitialization(true);
    f.observeProviderTurns.mockResolvedValue(nativeObservation("working"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.observeProviderTurns).toHaveBeenCalled();
    expect(f.engine.projectTruth().state).toBe("working");
  });
  it("does not let a pre-resume completion set new-generation Done attention", async () => {
    const f=harness();
    f.engine.resetForResume();
    f.engine.finishInitialization(true);
    f.observations.composer={modalOpen:false,occupied:false,inputReady:false};
    f.observeProviderTurns.mockResolvedValue(nativeObservation("idle",true));
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.completedTurns).toBe(1);
    expect(f.effects.setAttention).not.toHaveBeenCalledWith("done",true);
  });
});

describe("independent new-instruction ordinal attribution", () => {
  it("does not complete newly rendered instruction from native receipt older than its submission", async () => {
    const f=harness();
    f.engine.finishInitialization();
    f.observeProviderTurns.mockResolvedValue(nativeObservation("idle",true));
    const delivered=await f.engine.submitInstruction({source:"orchestrator",message:"brand new task",encoded:Buffer.from("brand new task"),instructionId:"new-task"});
    expect(["rendered","queued"]).toContain(delivered.state);
    await f.engine.reconcileCanonicalTurns();
    expect(f.effects.notifyInstructionState).not.toHaveBeenCalledWith(expect.objectContaining({instructionId:"new-task",state:"completed"}));
  });
});

describe("independent refused native source fallback", () => {
  it.each(["unbound","conflict","source-error"] as const)("does not bank an in-memory fallback when native source is %s", async(status)=>{
    vi.useFakeTimers();
    const f=harness();
    f.engine.finishInitialization();
    f.observeProviderTurns.mockResolvedValue({sessionId:f.record.id,provider:"codex",turnNumber:1,turns:[],nativeSourceAvailable:false,nativeSourceStatus:status,nativeFallbackAllowed:false,nativeActivity:"unknown"});
    f.observations.activity="working"; f.engine.appendOutput(Buffer.from("Working"));
    f.observations.activity="awaiting-input"; f.engine.appendOutput(Buffer.from("screen answer"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.engine.completedTurns).toBe(0);
    expect(f.engine.projectTruth().state).toBe("unknown");
  });
});


describe("native instruction admission", () => {
  it("holds on a native read failure and banks older receipts before a later retry", async () => {
    const f = harness(); f.engine.finishInitialization();
    f.observeProviderTurns.mockRejectedValueOnce(new Error("native source unreadable"));
    const input = { source: "orchestrator" as const, message: "new work", encoded: Buffer.from("new work"), instructionId: "new" };
    expect(await f.engine.submitInstruction(input)).toMatchObject({ state: "queued", hold: "provider-busy" });
    expect(f.writes).toHaveLength(0);
    f.observeProviderTurns.mockResolvedValueOnce(nativeObservation("idle", true));
    expect(await f.engine.submitInstruction(input)).toMatchObject({ state: "rendered", expectedTurn: 2 });
    expect(f.effects.notifyInstructionState).not.toHaveBeenCalledWith(expect.objectContaining({ instructionId: "new", state: "completed" }));
  });

  it("refuses a late native receipt that predates rendered input even if it missed preflight", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const f = harness(); f.engine.finishInitialization();
    f.observeProviderTurns.mockResolvedValueOnce(nativeObservation("idle"));
    expect(await f.engine.submitInstruction({ source: "orchestrator", message: "new work", encoded: Buffer.from("new work"), instructionId: "new" })).toMatchObject({ state: "rendered", expectedTurn: 1 });
    f.observeProviderTurns.mockResolvedValueOnce(nativeObservation("idle", true));
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.waitStatus(1)).not.toBe("completed");
    expect(f.engine.completedTurns).toBe(0);
    expect(f.effects.notifyInstructionState).not.toHaveBeenCalledWith(expect.objectContaining({ instructionId: "new", state: "completed" }));
    const next = { ...nativeObservation("idle", true),
      nativeActivityEvidence: { id: "current-end", kind: "task_complete", occurredAt: "2026-08-20T09:00:06.000Z" },
      turns: [{ providerTurnId: "new-end", providerOccurredAt: "2026-08-20T09:00:06.000Z", text: "new answer", transport: "provider-native" as const }] };
    f.observeProviderTurns.mockResolvedValueOnce(next);
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.waitResult(1, 500)).toMatchObject({ status: "completed", text: "new answer" });
  });

  it("serializes concurrent admissions while native preflight is unresolved", async () => {
    const f = harness(); f.engine.finishInitialization();
    const pending = deferred<Awaited<ReturnType<NonNullable<WorkerTurnTranscriptPort["observeProviderTurns"]>>>>();
    f.observeProviderTurns.mockReturnValueOnce(pending.promise);
    const first = f.engine.submitInstruction({ source: "orchestrator", message: "first", encoded: Buffer.from("first"), instructionId: "first" });
    await flushMicrotasks();
    expect(await f.engine.submitInstruction({ source: "orchestrator", message: "second", encoded: Buffer.from("second"), instructionId: "second" })).toMatchObject({ state: "queued", hold: "provider-busy" });
    expect(f.writes).toHaveLength(0);
    pending.resolve({ sessionId: f.record.id, provider: "codex", turnNumber: 1, turns: [] });
    expect(await first).toMatchObject({ state: "rendered", expectedTurn: 1 });
    expect(f.writes.map(bytes => bytes.toString())).toEqual(["first"]);
  });

  it("refuses automation when operator input arrives during native preflight", async () => {
    const f = harness(); f.engine.finishInitialization();
    const pending = deferred<Awaited<ReturnType<NonNullable<WorkerTurnTranscriptPort["observeProviderTurns"]>>>>();
    f.observeProviderTurns.mockReturnValueOnce(pending.promise);
    const admitted = f.engine.submitInstruction({ source: "orchestrator", message: "automation", encoded: Buffer.from("automation"), instructionId: "auto" });
    await flushMicrotasks(); f.engine.noteHumanInput();
    pending.resolve({ sessionId: f.record.id, provider: "codex", turnNumber: 1, turns: [] });
    expect(await admitted).toMatchObject({ state: "queued", hold: "provider-busy" });
    expect(f.writes).toHaveLength(0);
  });

  it("cancels an aborted instruction without reporting successful completion or reusing its target", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-20T09:00:02.000Z"));
    const f = harness(); f.engine.finishInitialization();
    let current: Awaited<ReturnType<NonNullable<WorkerTurnTranscriptPort["observeProviderTurns"]>>> = nativeObservation("idle");
    f.observeProviderTurns.mockImplementation(async input => ({ ...current, turnNumber: input.turnNumber }));
    expect(await f.engine.submitInstruction({ source: "orchestrator", message: "cancel me", encoded: Buffer.from("cancel me"), instructionId: "cancel-me" })).toMatchObject({ state: "rendered", expectedTurn: 1 });
    current = { ...nativeObservation("working"), nativeActivityEvidence: { id: "start", kind: "task_started", occurredAt: "2026-08-20T09:00:03.000Z" } };
    await f.engine.reconcileCanonicalTurns();
    current = { ...nativeObservation("idle"), nativeActivityEvidence: { id: "abort", kind: "turn_aborted", occurredAt: "2026-08-20T09:00:04.000Z" }, turns: [{providerTurnId:"aborted",providerOccurredAt:"2026-08-20T09:00:04.000Z",text:"cancelled",transport:"provider-native",data:{outcome:"cancelled",nativeActivityId:"abort"}}] };
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.waitResult(1, 500)).toMatchObject({ status: "stopped", turnOutcome: "cancelled" });
    expect(f.effects.notifyInstructionState).toHaveBeenCalledWith(expect.objectContaining({ instructionId: "cancel-me", state: "cancelled", turn: 1 }));
    expect(f.effects.notifyInstructionState).not.toHaveBeenCalledWith(expect.objectContaining({ instructionId: "cancel-me", state: "completed" }));
    expect(await f.engine.submitInstruction({ source: "orchestrator", message: "next", encoded: Buffer.from("next"), instructionId: "next" })).toMatchObject({ state: "rendered", expectedTurn: 2 });
    expect(f.engine.completedTurns).toBe(1);
  });
});

describe("independent repaired integration adversarial cases", () => {
  it("installs current native evidence on a fresh poll after an older in-flight read raced a redraw", async () => {
    const f=harness(); f.engine.finishInitialization();
    const pending=deferred<Awaited<ReturnType<NonNullable<WorkerTurnTranscriptPort["observeProviderTurns"]>>>>();
    f.observeProviderTurns.mockReturnValueOnce(pending.promise);
    const old=f.engine.reconcileCanonicalTurns();
    await flushMicrotasks();
    f.observations.activity="unknown";
    f.observations.composer={modalOpen:false,occupied:false,inputReady:false};
    f.engine.appendOutput(Buffer.from("a harmless unclassified repaint"));
    pending.resolve(nativeObservation("working")); await old;
    f.observeProviderTurns.mockResolvedValue(nativeObservation("working"));
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.projectTruth().state).toBe("working");
  });

  it("retains native working evidence across unclassified redraws without a new input or lifecycle event", async () => {
    const f=harness(); f.engine.finishInitialization();
    f.observeProviderTurns.mockResolvedValue(nativeObservation("working"));
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.projectTruth().state).toBe("working");
    f.observations.activity="unknown";
    f.observations.composer={modalOpen:false,occupied:false,inputReady:false};
    f.engine.appendOutput(Buffer.from("native working turn streaming text"));
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.projectTruth().state).toBe("working");
  });
});

async function actualCodexStore(extraOptions: { maxBytes?: number; retainedFiles?: number } = {}) {
  const root=await mkdtemp(join(tmpdir(),"status-independent-abort-")); roots.push(root);
  const sessions=join(root,"sessions"), day=join(sessions,"2026","08","20");
  await mkdir(day,{recursive:true});
  const path=join(day,"rollout-native.jsonl");
  const frame=(type:string,id:string,at="2026-08-20T09:00:02.000Z") => ({type:"event_msg",timestamp:at,payload:{type,turn_id:id,last_agent_message:"answer"}});
  const lines=(frames:unknown[]) => frames.map(x=>JSON.stringify(x)).join("\n")+"\n";
  await writeFile(path,lines([
    {type:"session_meta",payload:{id:"native",timestamp:sessionRecord().createdAt,cwd:sessionRecord().cwd,originator:"codex-tui"}},
    {type:"response_item",payload:{type:"message",role:"developer",content:[{type:"input_text",text:`[cyberdeck-native-session:${sessionRecord().id}]`}]}}]));
  const options={codexSessionsDirectory:sessions,...extraOptions};
  const store=new ThreadTranscriptStore(root,options);
  return {root,path,options,store,frame,lines};
}
describe("independent durable native abort boundaries", () => {
  it.each([false,true])("captures next native completion after a cancelled receipt (restart=%s)", async (restart) => {
    const f=await actualCodexStore();
    const h=harness({}, {transcripts:f.store}); h.engine.finishInitialization();
    await appendFile(f.path,f.lines([f.frame("task_started","aborted"),f.frame("turn_aborted","aborted")]));
    await h.engine.reconcileCanonicalTurns();
    expect(h.engine.completedTurns).toBe(1);
    expect((await f.store.readCompletionLedger(h.record.id)).turns[0]?.data?.outcome).toBe("cancelled");
    await h.engine.reconcileCanonicalTurns();
    expect(h.engine.completedTurns).toBe(1);
    if (restart) h.engine.releaseTimers();
    const store=restart ? new ThreadTranscriptStore(f.root,f.options) : f.store;
    await appendFile(f.path,f.lines([f.frame("task_started","next","2026-08-20T09:00:03.000Z"),f.frame("task_complete","next","2026-08-20T09:00:04.000Z")]));
    const next=await store.observeProviderTurns({sessionId:h.record.id,provider:"codex",cwd:h.record.cwd,createdAt:h.record.createdAt,turnNumber:2});
    expect(next.turns.map(t=>t.providerTurnId)).toEqual(["next"]);
  });

  it("does not bank the same cancellation at another ordinal when an engine is reconstructed", async () => {
    const f=await actualCodexStore();
    const first=harness({}, {transcripts:f.store}); first.engine.finishInitialization();
    await appendFile(f.path,f.lines([f.frame("task_started","aborted"),f.frame("turn_aborted","aborted")]));
    await first.engine.reconcileCanonicalTurns();
    expect(first.engine.completedTurns).toBe(1); first.engine.releaseTimers();
    const second=harness({}, {transcripts:new ThreadTranscriptStore(f.root,f.options)}); second.engine.finishInitialization();
    await second.engine.reconcileCanonicalTurns();
    expect(second.engine.completedTurns).toBe(1);
  });
});


describe("independent abort hidden by newer native activity", () => {
  it("does not complete an aborted instruction with the next native turn when both arrive between polls", async () => {
    const f=await actualCodexStore();
    const h=harness({}, {transcripts:f.store}); h.engine.finishInitialization();
    h.engine.noteRenderedInstruction({instructionId:"abort-me",expectedTurn:1,renderedAt:"2026-08-20T09:00:01.000Z"});
    await appendFile(f.path,f.lines([
      f.frame("task_started","aborted","2026-08-20T09:00:02.000Z"),
      f.frame("turn_aborted","aborted","2026-08-20T09:00:03.000Z"),
      f.frame("task_started","next","2026-08-20T09:00:04.000Z"),
      f.frame("task_complete","next","2026-08-20T09:00:05.000Z")
    ]));
    await h.engine.reconcileCanonicalTurns();
    expect(h.effects.notifyInstructionState).not.toHaveBeenCalledWith(expect.objectContaining({instructionId:"abort-me",state:"completed"}));
    expect(h.engine.waitResult(1,500)).toMatchObject({status:"stopped",turnOutcome:"cancelled"});
    expect(h.engine.completedTurns).toBe(2);
  });
});


function ioHarness(f: ReturnType<typeof harness>, humanPersistence?: Promise<void>) {
  let now=0;
  const runtime={record:f.record,turns:f.engine,watchers:new Map(),sessionRuntime:{write:vi.fn(),snapshot:()=>Buffer.from("")},controller:undefined as any};
  const bus={onSessionUpdate:vi.fn(),notifyDeliveryBoundary:vi.fn(),notifyControllerReleased:vi.fn()};
  const catalog={options:{now:()=>now},sessions:new Map([[f.record.id,runtime]]),
    requireRuntime:()=>runtime,assertMayConsume:()=>{},requireAdapter:()=>({submitInput:(s:string)=>Buffer.from(s)}),
    appendEvent:vi.fn(async()=>{}),appendTranscript:vi.fn(async()=>{await humanPersistence;}),persist:vi.fn(async()=>{})};
  const io=new SessionIoSurface({catalog:catalog as any,bus:bus as any});
  now=5000;
  return {io,bus,runtime};
}
describe("independent input authority during native preflight",()=>{
  it("refuses an instruction if a human controller attaches during native preflight",async()=>{
    const f=harness();f.engine.finishInitialization(); const h=ioHarness(f);
    const pending=deferred<any>();f.observeProviderTurns.mockReturnValueOnce(pending.promise);
    const delivery=h.io.submitInstruction(f.record.id,"automated");
    await flushMicrotasks();await h.io.attach(f.record.id,"human","control",()=>{});
    pending.resolve({sessionId:f.record.id,provider:"codex",turnNumber:1,turns:[]});
    await expect(delivery).rejects.toMatchObject({code:"SESSION_BUSY"});
    expect(f.writes).toHaveLength(0);
  });

  it("releases a wake held by a human submit that began during native preflight",async()=>{
    const f=harness({kind:"orchestrator"});f.engine.finishInitialization();
    const humanPersistence=deferred<void>(); const h=ioHarness(f,humanPersistence.promise);
    const pending=deferred<any>();f.observeProviderTurns.mockReturnValueOnce(pending.promise);
    const delivery=h.io.submitInstruction(f.record.id,"wake","broker",{brokerOwned:true,submissionKind:"wake",actorSessionId:f.record.id});
    await flushMicrotasks();
    const human=h.io.submit(f.record.id,undefined,"human message");await flushMicrotasks();
    pending.resolve({sessionId:f.record.id,provider:"codex",turnNumber:1,turns:[]});
    await expect(delivery).rejects.toMatchObject({holdReason:"wake-turn-in-flight"});
    expect(f.writes).toHaveLength(0);
    humanPersistence.resolve();await human;
    expect(h.bus.notifyDeliveryBoundary).toHaveBeenCalledWith(f.record.id);
  });
});


describe("retained target evidence", () => {
  it("does not turn an evicted cancellation receipt into success from an aggregate count", () => {
    const f = harness(); f.engine.finishInitialization();
    f.engine.recordCompletion(1, "cancelled", "provider-transcript", "cancelled");
    for (let turn = 2; turn <= 66; turn += 1) f.engine.recordCompletion(turn, `answer ${turn}`, "provider-transcript");
    expect(f.engine.waitStatus(1)).not.toBe("completed");
    expect(f.engine.waitStatus(66)).toBe("completed");
  });
});

describe("independent withheld late-history lifecycle model",()=>{
  it("does not let normal exit finalization assign withheld older history to the rendered target",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const source=await actualCodexStore(); const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("task_complete","banked-history","2026-08-20T09:00:02.000Z")]));
    expect(await f.engine.submitInstruction({source:"orchestrator",message:"current task",encoded:Buffer.from("current task"),instructionId:"current-before-exit"})).toMatchObject({state:"rendered",expectedTurn:2});
    await appendFile(source.path,source.lines([source.frame("task_complete","withheld-history","2026-08-20T09:00:03.000Z")]));
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.completedTurns).toBe(1);
    f.observations.activity="working";f.engine.appendOutput(Buffer.from("current work controls"));
    f.observations.activity="awaiting-input";f.engine.appendOutput(Buffer.from("current idle before exit"));
    await f.engine.startTerminalFinalization(()=>"current idle before exit");
    expect(f.effects.notifyInstructionState).not.toHaveBeenCalledWith(expect.objectContaining({instructionId:"current-before-exit",state:"completed"}));
    expect(f.engine.completedTurns).toBe(1);
  });

  it("does not reuse an undelivered target for previously withheld history after ordinary resume",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const source=await actualCodexStore(); const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("task_complete","banked-history","2026-08-20T09:00:02.000Z")]));
    expect(await f.engine.submitInstruction({source:"orchestrator",message:"current task",encoded:Buffer.from("current task"),instructionId:"current-before-resume"})).toMatchObject({state:"rendered",expectedTurn:2});
    await appendFile(source.path,source.lines([source.frame("task_complete","withheld-history","2026-08-20T09:00:03.000Z")]));
    await f.engine.reconcileCanonicalTurns();expect(f.engine.completedTurns).toBe(1);
    // Actual lifecycle ordering: fence outgoing generation, retire its pending instructions, drain,
    // then reset before native polling in replacement generation.
    f.record.executionState="cancelled";f.record.exitCode=130;
    const barrier=f.engine.settleForResume();f.engine.stopPendingInstructions();await barrier;
    f.record.executionState="active";f.record.exitCode=null;
    f.engine.resetForResume();f.engine.finishInitialization(true);
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.waitResult(2,500).status).not.toBe("completed");
  });
});


describe("independent first-seen native idle versus current positive working",()=>{
  it("does not let a first-seen older native end supersede later Working controls",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const source=await actualCodexStore();const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("task_complete","old-end","2026-08-20T09:00:02.000Z")]));
    // The broker has positively observed newer provider work; it need not have originated the
    // input (remote control or a provider continuation can start it).
    f.observations.activity="working";f.engine.appendOutput(Buffer.from("current positive Working controls"));
    expect(f.engine.projectTruth().state).toBe("working");
    await f.engine.reconcileCanonicalTurns();
    expect.soft(f.engine.completedTurns).toBe(1); // Older receipt is valid history.
    expect.soft(f.engine.projectTruth().state).toBe("working");
    expect.soft(f.effects.setAttention).not.toHaveBeenCalledWith("done",true);
    const delivery=await f.engine.submitInstruction({source:"orchestrator",message:"must remain queued",encoded:Buffer.from("must remain queued"),instructionId:"queued-behind-current"});
    expect.soft(delivery.state).toBe("queued");
    expect.soft(f.writes).toHaveLength(0);
  });

  it("keeps positive screen Working when a first native end is rejected by the newer input timestamp",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const source=await actualCodexStore();const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("task_complete","old-end","2026-08-20T09:00:02.000Z")]));
    f.engine.noteHumanInput();
    f.observations.activity="working";f.engine.appendOutput(Buffer.from("current positive Working controls"));
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.projectTruth().state).toBe("working");
    expect(f.effects.setAttention).not.toHaveBeenCalledWith("done",true);
  });
});


describe("independent terminal negative receipt followons",()=>{
  it("does not infer success for an evicted negative target from high water",()=>{
    const f=harness();f.engine.finishInitialization();
    f.engine.recordCompletion(1,"cancelled","provider-transcript","cancelled");
    for(let turn=2;turn<=66;turn++) f.engine.recordCompletion(turn,`answer ${turn}`,"provider-transcript");
    expect(f.engine.waitStatus(1)).not.toBe("completed");
    expect(f.engine.waitStatus(66)).toBe("completed");
  });

  it.each([2,66])("preserves all pending instruction outcomes when %s receipts finish during terminal finalization",async(count)=>{
    const f=harness();f.engine.finishInitialization();
    f.engine.noteRenderedInstruction({instructionId:"cancel-first",expectedTurn:1,renderedAt:"2026-08-20T09:00:00.100Z"});
    f.engine.noteRenderedInstruction({instructionId:"finish-last",expectedTurn:count,renderedAt:"2026-08-20T09:00:00.100Z"});
    const turns=Array.from({length:count},(_,i)=>({providerTurnId:`turn-${i+1}`,providerOccurredAt:"2026-08-20T09:00:01.000Z",text:i===0?"cancelled":"done",transport:"provider-native" as const,...(i===0?{data:{outcome:"cancelled",nativeActivityId:"abort-first"}}:{})}));
    f.observeProviderTurns.mockResolvedValue({...nativeObservation("idle"),turns});
    const commit=deferred<WorkerTurnTranscript[]>();f.commitProviderTurns.mockReturnValueOnce(commit.promise);
    const poll=f.engine.reconcileCanonicalTurns();await flushMicrotasks();
    expect(f.commitProviderTurns).toHaveBeenCalledOnce();
    const exit=f.engine.startTerminalFinalization(()=>"");
    expect(exit).toBeDefined();
    commit.resolve(turns.map(t=>({text:t.text,data:{...t.data,transport:t.transport}})));
    await poll;await exit;
    expect.soft(f.effects.notifyInstructionState).toHaveBeenCalledWith(expect.objectContaining({instructionId:"cancel-first",state:"cancelled",turn:1}));
    expect.soft(f.effects.notifyInstructionState).not.toHaveBeenCalledWith(expect.objectContaining({instructionId:"cancel-first",state:"completed"}));
    expect.soft(f.effects.notifyInstructionState).toHaveBeenCalledWith(expect.objectContaining({instructionId:"finish-last",state:"completed",turn:count}));
  });
});


describe("independent terminal outcome batch retention",()=>{
  it("retains first rendered instruction outcome across a 66 receipt terminal commit",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:00.100Z"));
    const f=harness();f.engine.finishInitialization();
    expect(await f.engine.submitInstruction({source:"orchestrator",message:"cancel me",encoded:Buffer.from("cancel me"),instructionId:"actually-rendered-first"})).toMatchObject({state:"rendered",expectedTurn:1});
    expect(f.writes).toHaveLength(1);
    const turns=Array.from({length:66},(_,i)=>({providerTurnId:`turn-${i+1}`,providerOccurredAt:"2026-08-20T09:00:01.000Z",text:i===0?"cancelled":"done",transport:"provider-native" as const,...(i===0?{data:{outcome:"cancelled",nativeActivityId:"abort-first"}}:{})}));
    f.observeProviderTurns.mockResolvedValue({...nativeObservation("idle"),turns});
    const commit=deferred<WorkerTurnTranscript[]>();f.commitProviderTurns.mockReturnValueOnce(commit.promise);
    const poll=f.engine.reconcileCanonicalTurns();await flushMicrotasks();
    expect(f.commitProviderTurns).toHaveBeenCalledOnce();
    const exit=f.engine.startTerminalFinalization(()=>"");expect(exit).toBeDefined();
    commit.resolve(turns.map(t=>({text:t.text,data:{...t.data,transport:t.transport}})));
    await poll;await exit;
    f.engine.stopPendingInstructions();
    expect.soft(f.effects.notifyInstructionState).toHaveBeenCalledWith(expect.objectContaining({instructionId:"actually-rendered-first",state:"cancelled",turn:1}));
    expect.soft(f.effects.notifyInstructionState).not.toHaveBeenCalledWith(expect.objectContaining({instructionId:"actually-rendered-first",state:"undelivered"}));
  });
});


describe("independent durable instruction target retirement",()=>{
  it.each([false,true])("keeps target2 negative after store and engine reconstruction (retiredBeforeRestart=%s)",async(retiredBeforeRestart)=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const source=await actualCodexStore();const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("task_complete","banked-history","2026-08-20T09:00:02.000Z")]));
    expect(await f.engine.submitInstruction({source:"orchestrator",message:"current task",encoded:Buffer.from("current task"),instructionId:"target-before-restart"})).toMatchObject({state:"rendered",expectedTurn:2});
    await appendFile(source.path,source.lines([source.frame("task_complete","withheld-history","2026-08-20T09:00:03.000Z")]));
    await f.engine.reconcileCanonicalTurns();expect(f.engine.completedTurns).toBe(1);
    if(retiredBeforeRestart){f.engine.stopPendingInstructions();await f.engine.settlePendingTurnCommit();}
    f.engine.releaseTimers();
    const store=new ThreadTranscriptStore(source.root,source.options);
    const resumed=harness({executionState:"cancelled",exitCode:-1},{transcripts:store});
    await resumed.engine.restoreDurableCompletions();
    const barrier=resumed.engine.settleForResume();resumed.engine.stopPendingInstructions();await barrier;
    resumed.record.executionState="active";resumed.record.exitCode=null;
    resumed.engine.resetForResume();resumed.engine.finishInitialization(true);
    await resumed.engine.reconcileCanonicalTurns();
    expect(resumed.engine.waitResult(2,500)).toMatchObject({status:"stopped",turnOutcome:"cancelled"});
    const ledger=await store.readCompletionLedger(resumed.record.id);
    expect(ledger.turns.find(t=>t.data?.turnNumber===2)?.data?.outcome).toBe("cancelled");
  });
});

describe("independent undated native end versus Working",()=>{
  it("does not grant an undated first native end authority over positive current Working",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const source=await actualCodexStore();const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([{type:"event_msg",payload:{type:"task_complete",turn_id:"undated-old-end",last_agent_message:"answer"}}]));
    f.observations.activity="working";f.engine.appendOutput(Buffer.from("positive current Working controls"));
    await f.engine.reconcileCanonicalTurns();
    expect.soft(f.engine.projectTruth().state).toBe("working");
    expect.soft(f.effects.setAttention).not.toHaveBeenCalledWith("done",true);
    const delivery=await f.engine.submitInstruction({source:"orchestrator",message:"keep queued",encoded:Buffer.from("keep queued"),instructionId:"undated-current-working"});
    expect.soft(delivery.state).toBe("queued");expect.soft(f.writes).toHaveLength(0);
  });
});

describe("independent retirement journal rotation",()=>{
  it.each([false,true])("does not recycle target2 after unrelated-session rotation (alreadyRetired=%s)",async(alreadyRetired)=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const source=await actualCodexStore({maxBytes:4096,retainedFiles:1});const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("task_complete","banked-history","2026-08-20T09:00:02.000Z")]));
    expect(await f.engine.submitInstruction({source:"orchestrator",message:"current task",encoded:Buffer.from("current task"),instructionId:"target-before-rotation"})).toMatchObject({state:"rendered",expectedTurn:2});
    await appendFile(source.path,source.lines([source.frame("task_complete","withheld-history","2026-08-20T09:00:03.000Z")]));
    await f.engine.reconcileCanonicalTurns();expect(f.engine.completedTurns).toBe(1);
    if(alreadyRetired){f.engine.stopPendingInstructions();await f.engine.settlePendingTurnCommit();}
    f.engine.releaseTimers();
    expect((await source.store.readCompletionLedger(f.record.id)).instructionTargets).toEqual(expect.arrayContaining([expect.objectContaining({expectedTurn:2})]));
    for(let n=0;n<30;n++)await source.store.append({sessionId:"22222222-2222-4222-8222-222222222222",kind:"lifecycle",source:"broker",text:`unrelated-${n}-`+"x".repeat(400)});
    const reopened=new ThreadTranscriptStore(source.root,source.options);
    const resumed=harness({executionState:"cancelled",exitCode:-1},{transcripts:reopened});await resumed.engine.restoreDurableCompletions();
    const barrier=resumed.engine.settleForResume();resumed.engine.stopPendingInstructions();await barrier;
    resumed.record.executionState="active";resumed.record.exitCode=null;resumed.engine.resetForResume();resumed.engine.finishInitialization(true);
    await resumed.engine.reconcileCanonicalTurns();
    expect(resumed.engine.waitResult(2,500).status).not.toBe("completed");
  });
});

describe("independent undated receipt with dated newer activity",()=>{
  it("does not lend the latest started timestamp to a separate undated completion",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const source=await actualCodexStore();const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("task_complete","banked-history","2026-08-20T09:00:02.000Z")]));
    expect(await f.engine.submitInstruction({source:"orchestrator",message:"current task",encoded:Buffer.from("current task"),instructionId:"dated-new-input"})).toMatchObject({state:"rendered",expectedTurn:2});
    await appendFile(source.path,source.lines([{type:"event_msg",payload:{type:"task_complete",turn_id:"undated-old-history",last_agent_message:"older"}},source.frame("task_started","new-current-work","2026-08-20T09:00:06.000Z")]));
    await f.engine.reconcileCanonicalTurns();
    expect.soft(f.effects.notifyInstructionState).not.toHaveBeenCalledWith(expect.objectContaining({instructionId:"dated-new-input",state:"completed"}));
    expect.soft(f.engine.waitResult(2,500).status).not.toBe("completed");
  });
});


describe("independent retirement ordering and retained outcomes",()=>{
  it("keeps cancelled target2 separate from later history3 and restores each exact provenance",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const source=await actualCodexStore();const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("task_complete","banked-history","2026-08-20T09:00:02.000Z")]));
    expect(await f.engine.submitInstruction({source:"orchestrator",message:"unanswered",encoded:Buffer.from("unanswered"),instructionId:"exact-negative-target"})).toMatchObject({state:"rendered",expectedTurn:2});
    await appendFile(source.path,source.lines([source.frame("task_complete","withheld-history","2026-08-20T09:00:03.000Z")]));
    await f.engine.reconcileCanonicalTurns();expect(f.engine.completedTurns).toBe(1);
    const barrier=f.engine.settleForResume();f.engine.stopPendingInstructions();await barrier;
    expect(f.engine.waitResult(2,500)).toMatchObject({status:"stopped",turnOutcome:"cancelled",provenance:"broker-lifecycle"});
    f.engine.resetForResume();f.engine.finishInitialization(true);await f.engine.reconcileCanonicalTurns();await f.engine.reconcileCanonicalTurns();
    expect(f.engine.completedTurns).toBe(3);expect(f.engine.canonicalTurns).toBe(2);
    expect(f.engine.waitResult(2,500)).toMatchObject({status:"stopped",turnOutcome:"cancelled",provenance:"broker-lifecycle"});
    expect(f.engine.waitResult(3,500)).toMatchObject({status:"completed",provenance:"provider-transcript"});
    const ledger=await source.store.readCompletionLedger(f.record.id);
    expect(ledger.turns.map(t=>[t.data?.turnNumber,t.data?.transport,t.data?.outcome])).toEqual([[1,"provider-native",undefined],[2,"broker-lifecycle","cancelled"],[3,"provider-native",undefined]]);
    f.engine.releaseTimers();const recovered=harness({}, {transcripts:new ThreadTranscriptStore(source.root,source.options)});
    await recovered.engine.restoreDurableCompletions();
    expect(recovered.engine.waitResult(2,500)).toMatchObject({status:"stopped",turnOutcome:"cancelled",provenance:"broker-lifecycle"});
    expect(recovered.engine.waitResult(3,500)).toMatchObject({status:"completed",provenance:"provider-transcript"});
    expect(recovered.engine.completedTurns).toBe(3);expect(recovered.engine.canonicalTurns).toBe(2);
  });

  it.each([false,true])("blocks writes during pending or failed retirement (reject=%s)",async(reject)=>{
    const f=harness();f.engine.finishInitialization();
    expect(await f.engine.submitInstruction({source:"orchestrator",message:"first",encoded:Buffer.from("first"),instructionId:"retire-before-next"})).toMatchObject({state:"rendered",expectedTurn:1});
    const commit=deferred<WorkerTurnTranscript[]>();f.commitProviderTurns.mockReturnValueOnce(commit.promise);
    f.engine.stopPendingInstructions();await flushMicrotasks();expect(f.commitProviderTurns).toHaveBeenCalledOnce();
    expect(await f.engine.submitInstruction({source:"orchestrator",message:"next",encoded:Buffer.from("next"),instructionId:"blocked-next"})).toMatchObject({state:"queued",hold:"provider-busy"});expect(f.writes).toHaveLength(1);
    const settlement=f.engine.settlePendingTurnCommit();
    if(reject){commit.reject(new Error("temporary retirement write rejected"));await expect(settlement).rejects.toThrow();
      expect(await f.engine.submitInstruction({source:"orchestrator",message:"retry",encoded:Buffer.from("retry"),instructionId:"blocked-retry"})).toMatchObject({state:"queued",hold:"provider-busy"});expect(f.writes).toHaveLength(1);
    }else{commit.resolve([{text:"cancelled",data:{transport:"broker-lifecycle",outcome:"cancelled",turnNumber:1}}]);await settlement;
      expect(f.engine.waitResult(1,500)).toMatchObject({status:"stopped",turnOutcome:"cancelled",provenance:"broker-lifecycle"});expect(f.engine.canonicalTurns).toBe(0);}
  });

  it("waits for an already enqueued positive native commit before choosing any retirement receipt",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:00.000Z"));
    const f=harness();f.engine.finishInitialization();await f.engine.submitInstruction({source:"orchestrator",message:"first",encoded:Buffer.from("first"),instructionId:"already-native-owned"});
    const observation={...nativeObservation("idle"),turns:[{providerTurnId:"actual-native-end",providerOccurredAt:"2026-08-20T09:00:01.000Z",text:"completed",transport:"provider-native" as const}]};
    f.observeProviderTurns.mockResolvedValue(observation);const commit=deferred<WorkerTurnTranscript[]>();f.commitProviderTurns.mockReturnValueOnce(commit.promise);
    const capture=f.engine.reconcileCanonicalTurns();await flushMicrotasks();expect(f.commitProviderTurns).toHaveBeenCalledOnce();
    const barrier=f.engine.settleForResume();f.engine.stopPendingInstructions();
    commit.resolve([{text:"completed",data:{transport:"provider-native",turnNumber:1}}]);await capture;await barrier;
    expect(f.commitProviderTurns).toHaveBeenCalledOnce();expect(f.engine.completedTurns).toBe(1);expect(f.engine.canonicalTurns).toBe(1);
    expect(f.engine.waitResult(1,500)).toMatchObject({status:"completed",provenance:"provider-transcript"});
  });
});

describe("independent repeated native end identity",()=>{
  it.each([false,true])("preserves one successful ordinal when completion is followed by late same-ID abort (pollBetween=%s)",async(pollBetween)=>{
    const source=await actualCodexStore();const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("task_complete","already-done","2026-08-20T09:00:02.000Z")]));
    if(pollBetween){await f.engine.reconcileCanonicalTurns();expect(f.engine.completedTurns).toBe(1);}
    await appendFile(source.path,source.lines([source.frame("turn_aborted","already-done","2026-08-20T09:00:03.000Z")]));
    await f.engine.reconcileCanonicalTurns();
    expect.soft(f.engine.completedTurns).toBe(1);expect.soft(f.engine.canonicalTurns).toBe(1);
    expect.soft(f.engine.waitResult(1,500).status).toBe("completed");expect.soft(f.engine.waitResult(2,500).status).not.toBe("completed");
    await appendFile(source.path,source.lines([source.frame("task_complete","distinct-next","2026-08-20T09:00:04.000Z")]));
    await f.engine.reconcileCanonicalTurns();await f.engine.reconcileCanonicalTurns();
    expect(f.engine.completedTurns).toBe(2);expect(f.engine.canonicalTurns).toBe(2);
    expect(f.engine.waitResult(2,500).status).toBe("completed");
    expect(await source.store.readCompletionLedger(f.record.id)).toMatchObject({completedTurns:2,canonicalTurns:2});
  });

  it.each([false,true])("keeps the first negative outcome then accepts a distinct next turn (pollBetween=%s)",async(pollBetween)=>{
    const source=await actualCodexStore();const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("turn_aborted","cancel-first","2026-08-20T09:00:02.000Z")]));
    if(pollBetween)await f.engine.reconcileCanonicalTurns();
    await appendFile(source.path,source.lines([source.frame("task_complete","cancel-first","2026-08-20T09:00:03.000Z")]));
    await f.engine.reconcileCanonicalTurns();
    expect(f.engine.completedTurns).toBe(1);expect(f.engine.waitResult(1,500)).toMatchObject({status:"stopped",turnOutcome:"cancelled"});
    await appendFile(source.path,source.lines([source.frame("task_complete","distinct-next","2026-08-20T09:00:04.000Z")]));
    await f.engine.reconcileCanonicalTurns();await f.engine.reconcileCanonicalTurns();
    expect(f.engine.completedTurns).toBe(2);expect(f.engine.canonicalTurns).toBe(2);
    expect(f.engine.waitResult(1,500)).toMatchObject({status:"stopped",turnOutcome:"cancelled"});
    expect(f.engine.waitResult(2,500).status).toBe("completed");
  });

  it("does not bank the same container turn ID twice when completed and aborted arrive together",async()=>{
    const root=await mkdtemp(join(tmpdir(),"status-independent-container-ends-"));roots.push(root);
    const record={...sessionRecord(),executor:"orbstack-container",generation:1,execution:{brokerId:"22222222-2222-4222-8222-222222222222",executionId:"33333333-3333-4333-8333-333333333333",workerId:sessionRecord().id,sessionId:sessionRecord().id,generation:1,executor:"orbstack-container",workspaceId:"/tmp/repo"}} as SessionRecord;
    const source=new ContainerNativeSource(join(root,"containers"));const dir=join(source.stateRoot(record.id),".codex","sessions","2026","08","20");await mkdir(dir,{recursive:true});
    const lines=[{type:"session_meta",payload:{id:"44444444-4444-4444-8444-444444444444",timestamp:record.createdAt,cwd:"/workspace",originator:"codex-tui"}},
      {type:"event_msg",timestamp:"2026-08-20T09:00:02.000Z",payload:{type:"task_complete",turn_id:"same",last_agent_message:"answer"}},
      {type:"event_msg",timestamp:"2026-08-20T09:00:03.000Z",payload:{type:"turn_aborted",turn_id:"same"}}];
    await writeFile(join(dir,"rollout.jsonl"),lines.map(l=>JSON.stringify(l)).join("\n")+"\n");
    const store=new ExecutionTranscriptStore(join(root,"state"),{},source,()=>record);const f=harness(record,{transcripts:store});f.engine.finishInitialization();await f.engine.reconcileCanonicalTurns();
    expect.soft(f.engine.completedTurns).toBe(1);expect.soft(f.engine.canonicalTurns).toBe(1);
    expect.soft(f.engine.waitResult(1,500).status).toBe("completed");expect.soft(f.engine.waitResult(2,500).status).not.toBe("completed");
    await appendFile(join(dir,"rollout.jsonl"),JSON.stringify({type:"event_msg",timestamp:"2026-08-20T09:00:04.000Z",payload:{type:"task_complete",turn_id:"distinct-next",last_agent_message:"next answer"}})+"\n");
    await f.engine.reconcileCanonicalTurns();await f.engine.reconcileCanonicalTurns();
    expect(f.engine.completedTurns).toBe(2);expect(f.engine.canonicalTurns).toBe(2);expect(f.engine.waitResult(2,500).status).toBe("completed");
  });
});


describe("independent worker ledger failure recovery",()=>{
  it("persists a journal-recovered positive receipt before unrelated rotation can lose it again",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const source=await actualCodexStore({maxBytes:4096,retainedFiles:1});const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("task_complete","banked-history","2026-08-20T09:00:02.000Z")]));
    expect(await f.engine.submitInstruction({source:"orchestrator",message:"current",encoded:Buffer.from("current"),instructionId:"snapshot-failure-input"})).toMatchObject({state:"rendered",expectedTurn:2});
    await appendFile(source.path,source.lines([source.frame("task_complete","actual-current-answer","2026-08-20T09:00:06.000Z")]));
    const fail=vi.spyOn(WorkerLedgerStore.prototype,"write").mockRejectedValueOnce(new Error("injected snapshot write failure"));
    try {expect(await f.engine.reconcileCanonicalTurns()).toBe(false);expect(fail).toHaveBeenCalledOnce();} finally {fail.mockRestore();}
    f.engine.releaseTimers();
    const firstRecoveryStore=new ThreadTranscriptStore(source.root,source.options);const first=harness({executionState:"cancelled",exitCode:-1},{transcripts:firstRecoveryStore});
    await first.engine.restoreDurableCompletions();
    expect(first.engine.waitResult(2,500)).toMatchObject({status:"completed",provenance:"provider-transcript"});
    first.engine.releaseTimers();
    for(let n=0;n<30;n++)await firstRecoveryStore.append({sessionId:"22222222-2222-4222-8222-222222222222",kind:"lifecycle",source:"broker",text:`noise-${n}-`+"x".repeat(400)});
    const nextStore=new ThreadTranscriptStore(source.root,source.options);const second=harness({executionState:"cancelled",exitCode:-1},{transcripts:nextStore});
    await second.engine.restoreDurableCompletions();
    const barrier=second.engine.settleForResume();second.engine.stopPendingInstructions();await barrier;
    expect.soft(second.engine.waitResult(2,500).status).toBe("completed");
    expect.soft(second.engine.waitResult(2,500).provenance).toBe("provider-transcript");
  });
});


describe("independent ledger retirement deletion ordering",()=>{
  it("does not recreate deleted ledger when an older capture finally releases pending retirement",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-08-20T09:00:05.000Z"));
    const source=await actualCodexStore();const f=harness({}, {transcripts:source.store});f.engine.finishInitialization();
    await appendFile(source.path,source.lines([source.frame("task_complete","initial-idle","2026-08-20T09:00:02.000Z")]));
    await f.engine.submitInstruction({source:"orchestrator",message:"pending",encoded:Buffer.from("pending"),instructionId:"delete-pending"});
    const read=deferred<Awaited<ReturnType<ThreadTranscriptStore["observeProviderTurns"]>>>();
    const observation=vi.spyOn(source.store,"observeProviderTurns").mockReturnValueOnce(read.promise);
    const capture=f.engine.reconcileCanonicalTurns();await flushMicrotasks();
    f.record.executionState="cancelled";f.engine.discardPendingScreenTurns();
    // Explicit-stop exit publishes immediately, and retires input while the capture still awaits I/O.
    f.engine.stopPendingInstructions();f.record.exitCode=130;
    // Execute real lifecycle deletion and real cleanup, including the engine retirement hook.
    const runtime={record:f.record,turns:f.engine,launchTail:Promise.resolve()};
    const catalog={sessions:new Map([[f.record.id,runtime]]),requireRuntime:()=>runtime,
      options:{adapters:{},transcripts:source.store,store:{delete:vi.fn(async()=>{})}},
      appendEvent:vi.fn(async()=>{}),persist:vi.fn(async()=>{}),
      appendTranscript:(sessionId:string,kind:any,sourceKind:any,text:string,data:any)=>source.store.append({sessionId,kind,source:sourceKind,text,data})};
    const assembly=new SessionRuntimeAssembly({catalog,bus:{},scoutSupervision:{}} as any);
    const lifecycle=new SessionLifecycleController({catalog,assembly,bus:{},observer:{}} as any);
    const retire=vi.spyOn(f.engine,"retire");
    await lifecycle.delete(f.record.id);
    expect(retire).toHaveBeenCalledOnce();expect(catalog.sessions.has(f.record.id)).toBe(false);
    read.resolve({sessionId:f.record.id,provider:"codex",turnNumber:2,turns:[],nativeSourceAvailable:true,nativeActivity:"unknown"});
    await capture;await f.engine.settlePendingTurnCommit();observation.mockRestore();
    expect(await new WorkerLedgerStore(source.root).read(f.record.id)).toBeUndefined();
    const reopened = new ThreadTranscriptStore(source.root, source.options); await reopened.init();
    expect(await new WorkerLedgerStore(source.root).read(f.record.id)).toBeUndefined();
    expect(await reopened.readCompletionLedger(f.record.id)).toMatchObject({ completedTurns: 0, turns: [] });
  });
});


describe("independent ledger safety and cost controls",()=>{
  it("rejects non-UUID paths, leaf symlinks, corrupt and oversized snapshots and writes private modes",async()=>{
    const source=await actualCodexStore();const id=sessionRecord().id;const ledgers=new WorkerLedgerStore(source.root);
    await expect(ledgers.read("../outside")).rejects.toThrow();
    await source.store.append({sessionId:id,kind:"instruction",source:"broker",text:"input",data:{instructionState:"rendered",instructionId:"safe-input",expectedTurn:1,renderedAt:"2026-08-20T09:00:01.000Z"}});
    const path=join(source.root,"threads","turn-ledgers",`${id}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);expect((await stat(join(source.root,"threads","turn-ledgers"))).mode & 0o777).toBe(0o700);
    const other=join(source.root,"other-ledger");await writeFile(other,"unchanged");await unlink(path);await symlink(other,path);
    await expect(ledgers.read(id)).rejects.toThrow();expect(await readFile(other,"utf8")).toBe("unchanged");
    await unlink(path);await writeFile(path,"{broken");await expect(ledgers.read(id)).rejects.toThrow();
    await writeFile(path," ".repeat(8*1024*1024+1));await expect(ledgers.read(id)).rejects.toThrow("WORKER_LEDGER_INVALID");
  });

  it("hydrates once and performs no checkpoint writes on repeated ledger reads",async()=>{
    const source=await actualCodexStore();const read=vi.spyOn(WorkerLedgerStore.prototype,"read");const write=vi.spyOn(WorkerLedgerStore.prototype,"write");
    try {
      await source.store.readCompletionLedger(sessionRecord().id);const writeCount=write.mock.calls.length;
      await Promise.all(Array.from({length:100},()=>source.store.readCompletionLedger(sessionRecord().id)));
      expect(read).toHaveBeenCalledOnce();expect(write.mock.calls.length).toBe(writeCount);
    }finally{read.mockRestore();write.mockRestore();}
  });

  it("preserves last native boundary outside the64 receipts through79 broker negatives and rotation",async()=>{
    const source=await actualCodexStore({maxBytes:4096,retainedFiles:1});const input={sessionId:sessionRecord().id,provider:"codex",cwd:sessionRecord().cwd,createdAt:sessionRecord().createdAt,turnNumber:1};
    await appendFile(source.path,source.lines([source.frame("task_complete","native-before-negatives","2026-08-20T09:00:02.000Z")]));
    await source.store.captureProviderTurns(input);
    const before=performance.now();
    await source.store.commitProviderTurns({...input,turnNumber:2,turns:Array.from({length:79},(_,i)=>({providerTurnId:`broker-instruction:${i}`,providerOccurredAt:"2026-08-20T09:00:03.000Z",text:"cancelled",transport:"broker-lifecycle" as const,data:{outcome:"cancelled"}}))});
    const elapsedMs=performance.now()-before;
    const file=join(source.root,"threads","turn-ledgers",`${input.sessionId}.json`);const size=(await stat(file)).size;
    const reopened=new ThreadTranscriptStore(source.root,source.options);const ledger=await reopened.readCompletionLedger(input.sessionId);
    expect(ledger).toMatchObject({completedTurns:80,canonicalTurns:1,lastNativeTurn:{data:{semanticTurnId:"codex:native-before-negatives",turnNumber:1}}});expect(ledger.turns).toHaveLength(64);
    await appendFile(source.path,source.lines([source.frame("task_complete","native-after-negatives","2026-08-20T09:00:04.000Z")]));
    const next=await reopened.observeProviderTurns({...input,turnNumber:81});expect(next.turns.map(t=>t.providerTurnId)).toEqual(["native-after-negatives"]);
    await reopened.commitProviderTurns(next);expect(await reopened.readCompletionLedger(input.sessionId)).toMatchObject({completedTurns:81,canonicalTurns:2});
    await writeFile("/private/tmp/status-independent-ledger-cost.json",JSON.stringify({method:"One local temporary-store batch of79 short broker negative receipts, fsynced per receipt; no live broker/provider",elapsedMs,msPerReceipt:elapsedMs/79,sidecarBytes:size,retainedReceipts:ledger.turns.length},null,2));
  });
});
