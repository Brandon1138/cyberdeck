import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { ObservedWorkerCoordinationService } from "../../src/broker/observed-worker-coordination.js";
import { ORCHESTRATOR_GRANT_CAPABILITIES, orchestratorController, type OrchestratorBinding } from "../../src/domain/orchestrator.js";
import { SessionRecordSchema, type SessionRecord } from "../../src/domain/session.js";
import type { WorkerTruth } from "../../src/domain/worker-truth.js";
import type { WorkerEvent } from "../../src/domain/worker-coordination.js";
import { OrchestratorAttentionControlPlane, type OrchestratorAttentionOptions } from "../../src/orchestration/orchestrator-attention-control.js";
import { OrchestratorNotificationControlPlane } from "../../src/orchestration/orchestrator-notification-control.js";
import type { WorkerTruthQueryPort } from "../../src/orchestration/session/session-ports.js";
import { OrchestratorAttentionStore } from "../../src/persistence/orchestrator-attention-store.js";
import { OrchestratorNotificationStore } from "../../src/persistence/orchestrator-notification-store.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";

export const NOW = "2026-10-15T17:00:00.000Z";
export const ACTOR = "11111111-1111-4111-8111-111111111111";
export const WORKER = "22222222-2222-4222-8222-222222222222";
export const OTHER = "33333333-3333-4333-8333-333333333333";
const fixtures: Array<{ directory: string; controls: OrchestratorAttentionControlPlane[] }> = [];
export async function cleanupAttentionHarnesses(): Promise<void> {
  for (const f of fixtures.splice(0)) {
    for (const control of f.controls) { control.stop(); await control.flush(); }
    await rm(f.directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
}

export async function attentionHarness(options: { peer?: boolean; workspace?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-attention-test-"));
  const scope = options.workspace ? { kind: "workspace" as const, cwd: "/repo" } : { kind: "fleet" as const };
  const primaryKey = scope.kind === "fleet" ? "fleet" : "workspace:/repo";
  const bound: OrchestratorBinding = {
    key: options.peer ? `${primaryKey}:peer:${ACTOR}` : primaryKey, kind: options.peer ? "peer" : "primary",
    sessionId: ACTOR, provider: "codex", model: "gpt-6.1-sol", cwd: "/repo", sandbox: "workspace-write", scope,
    grant: { subjectSessionId: ACTOR, capabilities: [...ORCHESTRATOR_GRANT_CAPABILITIES], scope },
    createdAt: NOW, updatedAt: NOW,
  };
  const bindings = new Map([[ACTOR, bound]]);
  const records = new Map<string, SessionRecord>();
  const truths = new Map<string, WorkerTruth>();
  const listeners = new Set<(id: string) => void>();
  const stopped = new Set<string>();
  for (const id of [ACTOR, WORKER, OTHER]) {
    records.set(id, SessionRecordSchema.parse({ id, name: id === ACTOR ? "Orc" : "Worker", cwd: "/repo", provider: "codex",
      kind: id === ACTOR ? "orchestrator" : "worker", detached: true, sandbox: "workspace-write", generation: 1,
      executionState: "active", attentionState: "working", attachmentState: "detached", pid: 123, exitCode: null,
      childIds: [], createdAt: NOW, updatedAt: NOW }));
    truths.set(id, { state: "working", terminal: false, completedTurns: 0, canonicalTurns: 0, pendingInstructions: 0,
      composerOccupied: false, modalOpen: false, detail: "Working" });
  }
  const waitForWorkerResults = vi.fn<WorkerTruthQueryPort["waitForWorkerResults"]>(async () => ({ timedOut: false, results: [] }));
  const registry = {
    get: (id: string) => {
      const record = records.get(id);
      if (record === undefined) throw Object.assign(new Error("missing"), { code: "SESSION_NOT_FOUND" });
      return record;
    },
    workerTruth: (id: string) => truths.get(id)!,
    onSessionUpdate: (listener: (id: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    isStopRequested: (id: string) => stopped.has(id), waitForWorkerResults,
    resume: vi.fn<() => Promise<void>>(),
  };
  const controller = orchestratorController(bound);
  const coordination = new ObservedWorkerCoordinationService({ store: new WorkerCoordinationStore(directory),
    now: () => NOW, eventRateLimit: 1_000 });
  await coordination.initialize();
  const tokens = new Map<string, string>();
  for (const id of [WORKER, OTHER]) {
    const result = await coordination.registerSubject({ mutationId: randomUUID(), actor: controller, subjectId: id,
      origin: { creatorControllerId: controller.controllerId, creatorSessionId: ACTOR, taskId: "attention-test", threadId: id, createdAt: NOW },
      lifecycle: "working", resources: { sessionId: id, worktreePath: "/repo", eventStreamId: `worker:${id}` },
      controller, reason: "test worker registration" });
    tokens.set(id, result.outcomes[0]!.leaseToken!);
  }
  const transcripts = new ThreadTranscriptStore(directory);
  const store = new OrchestratorAttentionStore(directory);
  const inbox = new OrchestratorNotificationStore(directory, { now: () => NOW });
  await inbox.load();
  const controls: OrchestratorAttentionControlPlane[] = [];
  const errors: unknown[] = [];
  const controlOptions = { store, registry, coordination, transcripts, inbox,
    bindings: { list: async () => [...bindings.values()], findBySessionId: async (id: string) => bindings.get(id) },
    now: () => NOW, onError: (error: unknown) => { errors.push(error); } };
  const makeControl = (overrideStore = store, sourceOverrides: Partial<Pick<OrchestratorAttentionOptions, "coordination" | "transcripts">> = {}) => {
    const attention = new OrchestratorAttentionControlPlane({ ...controlOptions, ...sourceOverrides, store: overrideStore });
    controls.push(attention);
    const notifications = new OrchestratorNotificationControlPlane({ inbox, registry, bindings: controlOptions.bindings, attention });
    return { attention, notifications };
  };
  const initial = makeControl();
  await initial.attention.start();
  const sequences = new Map<string, number>();
  const f = {
    directory, bound, bindings, registry, records, truths, stopped, coordination, controller, tokens,
    transcripts, store, inbox, controls, controlOptions, makeControl, errors, ...initial,
    request: (extra = {}) => ({ actorSessionId: ACTOR, mutationId: randomUUID(), objective: "Review the requested change",
      nextAction: "Read the exact result and review it", targets: [{ sessionId: WORKER, completionTarget: 1 }], ...extra }),
    emit(id = WORKER, update: Partial<WorkerTruth> = {}) {
      truths.set(id, { ...truths.get(id)!, ...update });
      for (const listener of listeners) listener(id);
    },
    async report(summary: string, extra: Partial<WorkerEvent> = {}, workerId = WORKER) {
      const sequence = (sequences.get(workerId) ?? 0) + 1; sequences.set(workerId, sequence);
      const event: WorkerEvent = { schemaVersion: 1, eventId: randomUUID(), sequence, workerId, taskId: "attention-test",
        controllerLeaseVersion: 1, kind: "PROGRESS", severity: "info", interventionRequired: false, summary,
        evidenceRefs: [], changedAssumptions: [], continuation: "continuing", timestamp: NOW, ...extra };
      const ack = await coordination.submitEvent({ mutationId: randomUUID(), controller, leaseToken: tokens.get(workerId)!, event });
      if (ack.code !== "accepted" && ack.code !== "superseded") throw new Error(JSON.stringify(ack));
      return event;
    },
    async complete(text = "UNIQUE-RESULT-17", number = 1, id = WORKER) {
      await transcripts.commitProviderTurns({ sessionId: id, provider: "codex", turnNumber: number,
        turns: [{ providerTurnId: `test-turn-${number}`, providerOccurredAt: NOW, text, transport: "provider-native" }] });
      f.emit(id, { state: "idle", completedTurns: number, canonicalTurns: number, detail: "Idle after a durable turn" });
    },
    notify(kind: "progress" | "risk" | "settled" = "progress", id = WORKER) {
      return inbox.append({ controllerId: controller.controllerId, sessionId: id, kind, severity: "info",
        summary: "Notification", wakeEligible: true });
    },
  };
  fixtures.push(f);
  return f;
}
