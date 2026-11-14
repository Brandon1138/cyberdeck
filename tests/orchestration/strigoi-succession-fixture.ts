import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, type Mock } from "vitest";
import { BrokerRuntimeConfigSchema } from "../../src/config.js";
import { SessionRegistry } from "../../src/broker/session-registry.js";
import { composeStrigoiRuntime } from "../../src/broker/strigoi-runtime.js";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import { StrigoiAdmission } from "../../src/orchestration/strigoi-admission.js";
import { StrigoiContinuity } from "../../src/orchestration/strigoi-continuity.js";
import type { StrigoiReconciliationParticipant, StrigoiSuccessionTurns } from "../../src/orchestration/strigoi-ports.js";
import { composeStrigoiEvidence } from "../../src/persistence/strigoi-evidence-runtime.js";
import { SessionStore } from "../../src/persistence/session-store.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import type { SessionRuntime } from "../../src/domain/session-runtime.js";
import type { StrigoiState } from "../../src/domain/strigoi.js";
import { AgentActivityStore } from "../../src/persistence/agent-activity-store.js";

export async function successionFixture(native = false) {
  const root = await mkdtemp(join(tmpdir(), "strigoi-succession-"));
  const evidence = composeStrigoiEvidence(root), bindings = evidence.orchestratorStore;
  const activity = await AgentActivityStore.open(join(root, "activity"));
  const sessions = new SessionStore(root), transcripts = new ThreadTranscriptStore(root, { continuity: evidence.transcriptContinuity });
  await evidence.startup(transcripts, sessions);
  const trace: string[] = [], states: StrigoiState[] = [], handles = new Map<string, () => void>();
  let autoExit = true, boundary: Awaited<ReturnType<StrigoiSuccessionTurns["boundary"]>> = "safe", now = Date.now();
  const cas = bindings.strigoi.compareAndSwap.bind(bindings.strigoi);
  vi.spyOn(bindings.strigoi, "compareAndSwap").mockImplementation(async (...args) => {
    const s = await cas(...args); states.push(s);
    if (s.transition?.predecessor) trace.push(s.transition.phase);
    return s;
  });
  const adapter = new CodexProviderAdapter();
  const writes: Mock = vi.fn(), inference: Mock = vi.fn(), initialize: Mock<() => Promise<void>> = vi.fn(async () => {});
  let launchingResident = false, activeResidents = 0, activeHighWater = 0;
  const activeSamples: number[] = [];
  const sample = () => { activeSamples.push(activeResidents); activeHighWater = Math.max(activeHighWater, activeResidents); };
  const spawn: Mock<() => SessionRuntime> = vi.fn((): SessionRuntime => {
    trace.push("launch");
    const resident = launchingResident; let exited = false;
    if (resident) activeResidents++; sample();
    const exits = new Set<(code: number) => void>();
    const exit = () => { if (exited) return; exited = true; if (resident) activeResidents--; sample(); trace.push("confirmed-retirement"); for (const cb of exits) cb(0); };
    // The provisional session is already persisted by the coordinator at this point.
    return { pid: 123, write: writes, snapshot: () => Buffer.alloc(0), resize: () => {},
      kill: () => { trace.push("stop"); if (autoExit) exit(); }, onOutput: () => () => {},
      onExit: (cb) => { exits.add(cb); handles.set(String(spawn.mock.calls.length), exit); return () => { exits.delete(cb); }; } };
  });
  const nativeResults = new Map<string, import("../../src/orchestration/session/worker-turn-ports.js").ObservedWorkerTurn[]>();
  const observations = new WorkerTurnObservationAdapter();
  if (native) {
    vi.spyOn(observations, "activity").mockReturnValue("awaiting-input");
    vi.spyOn(observations, "starting").mockReturnValue(false);
    vi.spyOn(observations, "composer").mockReturnValue({ modalOpen: false, occupied: false, inputReady: true });
    inference.mockImplementation((text: string) => Buffer.from(text));
    vi.spyOn(transcripts, "observeProviderTurns").mockImplementation(async input => {
      const turns = nativeResults.get(input.sessionId) ?? [], last = turns.at(-1);
      return { ...input, nativeSourceAvailable: true, nativeSourceStatus: "available", nativeActivity: "idle", turns,
        nativeActivityEvidence: { kind: "fixture-native-end", id: last?.providerTurnId ?? `startup:${input.sessionId}`, occurredAt: last?.providerOccurredAt ?? input.createdAt } };
    });
  }
  const options = { config: BrokerRuntimeConfigSchema.parse({}),
    adapters: { codex: { id: "codex", buildLaunchSpec: (session, prompt) => { launchingResident = session.kind === "orchestrator"; return adapter.buildLaunchSpec(session, prompt); }, buildResumeSpec: adapter.buildResumeSpec.bind(adapter), initializeSession: initialize, submitInput: inference } },
    sessionRuntimeFactory: spawn, journal: { append: async () => {} }, store: sessions, transcripts,
    workerTurnObservation: observations,
  } satisfies ConstructorParameters<typeof SessionRegistry>[0];
  let registry = new SessionRegistry(options); await registry.ready();
  const results = new Map<string, Awaited<ReturnType<StrigoiSuccessionTurns["observe"]>>>();
  const submitted: { id: string; kind: string }[] = [];
  let autoComplete = true;
  const turns: StrigoiSuccessionTurns = {
    boundary: async () => boundary,
    observe: async (id) => results.get(id) ?? { outcome: "unknown" },
    submit: vi.fn(async (id, identity, kind, packet, admit) => {
      await admit(async () => {
        submitted.push({ id, kind }); trace.push(kind);
        if (autoComplete) results.set(id, kind === "checkpoint" ? { outcome: "completed", checkpoint: "Keep the operator's unresolved question and original constraints." }
          : { outcome: "completed", adoption: { identity, packetHash: packet!.sha256, coverageId: packet!.coverageId, handledSourceIds: [], account: "Read original evidence; pending input remains pending." } });
      });
    }),
  };
  const workers: { reconcile: Mock<StrigoiReconciliationParticipant["reconcile"]> } = { reconcile: vi.fn(async () => { trace.push("workers"); return []; }) };
  const delivery: typeof workers & { hold: Mock<() => Promise<void>>; needsAdoption: Mock<() => Promise<boolean>> } = { needsAdoption: vi.fn(async () => true), hold: vi.fn(async () => { trace.push("hold-input"); }), reconcile: vi.fn(async () => { trace.push("delivery"); return []; }) };
  let bindingObserver: ((binding: import("../../src/domain/orchestrator.js").OrchestratorBinding, session: import("../../src/domain/session.js").SessionRecord | undefined) => Promise<void>) | undefined;
  const make = async () => {
    const admission = new StrigoiAdmission(bindings.strigoi, bindings, registry);
    const reopen = admission.reopen.bind(admission);
    vi.spyOn(admission, "reopen").mockImplementation(async (id) => { await reopen(id); trace.push("release"); });
    const continuity = new StrigoiContinuity({ repository: bindings.strigoi, bindings, admission, packets: evidence.packets, sources: evidence.sources });
    const manager = new OrchestratorManager(registry, bindings, undefined, { list: async () => ({ codex: "automatic" }) }, async () => [], (binding, session) => bindingObserver?.(binding, session) ?? Promise.resolve());
    const composition = await composeStrigoiRuntime({ repository: bindings.strigoi, bindings, admission, registry, manager, continuity,
      beforeDelete: evidence.beforeDelete, withDeletion: evidence.withDeletion, verifyContinuity: evidence.verify,
      succession: { packets: evidence.packets, sources: evidence.sources, turns, workers, delivery, activity, now: () => now } });
    // Tests drive deterministic phase ticks, never the production timer.
    vi.spyOn(composition.lifecycle, "wakeSuccession").mockImplementation(() => {});
    return { ...composition, admission };
  };
  let runtime = await make();
  await runtime.lifecycle.configure({ provider: "codex", model: "gpt-5.6-sol", cwd: root }, "configure");
  await runtime.lifecycle.reconcile();
  trace.length = 0; states.length = 0;
  const original = await bindings.strigoi.read();
  if (!original.activeBinding) throw new Error(`Initial passive launch failed: ${JSON.stringify(original)}`);
  const drive = async (id: string, count = 5) => {
    for (let i = 0; i < count; i++) { await runtime.succession!.advance(id); await Promise.resolve(); }
    return bindings.strigoi.read();
  };
  return { root, evidence, bindings, sessions, transcripts, activity, observations, nativeResults, turns, workers, delivery, submitted, results, trace, states, spawn, initialize, writes, inference, original,
    get activeHighWater() { return activeHighWater; }, activeSamples,
    get registry() { return registry; }, get runtime() { return runtime; },
    setBindingObserver: (observer: NonNullable<typeof bindingObserver>) => { bindingObserver = observer; },
    setBoundary: (v: typeof boundary) => { boundary = v; }, setAutoExit: (v: boolean) => { autoExit = v; },
    setAutoComplete: (v: boolean) => { autoComplete = v; }, tick: (ms: number) => { now += ms; },
    emitExit: (n = 1) => { handles.get(String(n))!(); }, drive,
    reconstruct: async (recoverRegistry = false) => {
      runtime.dispose();
      if (recoverRegistry) { registry = new SessionRegistry({ ...options, recoveredSessions: await sessions.load() }); await registry.ready(); }
      runtime = await make(); return runtime;
    },
    close: async () => { runtime.dispose(); autoExit = true; await registry.stopAll(); await new Promise((r) => setTimeout(r, 30)); await activity.close(); await transcripts.changes(0, 1); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); },
  };
}
