import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import { orchestratorController } from "../../src/domain/orchestrator.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { OrchestratorNotificationControlPlane } from "../../src/orchestration/orchestrator-notification-control.js";
import type { WorkerResultSnapshot } from "../../src/orchestration/session/session-ports.js";
import { OrchestratorNotificationStore } from "../../src/persistence/orchestrator-notification-store.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const FOREIGN = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-10-07T10:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function binding(scope: OrchestratorBinding["scope"] = { kind: "fleet" }): OrchestratorBinding {
  return {
    key: scope.kind === "fleet" ? "fleet" : `workspace:${scope.cwd}`,
    kind: "primary",
    sessionId: ACTOR,
    provider: "claude",
    cwd: "/repo",
    sandbox: "workspace-write",
    scope,
    grant: { subjectSessionId: ACTOR, capabilities: ["thread.read"], scope },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function session(id: string, cwd: string): SessionRecord {
  return {
    id, cwd, provider: "codex", detached: true, sandbox: "workspace-write", kind: "worker", generation: 1,
    createdAt: NOW, updatedAt: NOW, executionState: "active", attachmentState: "detached", pid: 1,
    exitCode: null, childIds: [], attentionState: "working",
  } as SessionRecord;
}

async function harness(options: { binding?: OrchestratorBinding; deliveries?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-notification-control-"));
  directories.push(directory);
  const inbox = new OrchestratorNotificationStore(directory, { now: () => NOW });
  await inbox.load();
  const bound = options.binding ?? binding();
  const controllerId = orchestratorController(bound).controllerId;
  let deliveries = options.deliveries ?? 0;
  const sessions = new Map([[WORKER, session(WORKER, "/repo")], [FOREIGN, session(FOREIGN, "/elsewhere")]]);
  const waitForWorkerResults = vi.fn(async (targets: Array<{ sessionId: string; completionTarget: number }>) => ({
    timedOut: false,
    results: targets.map((target): WorkerResultSnapshot => {
      // The real coordinator requires a runtime for every target and throws otherwise.
      if (!sessions.has(target.sessionId)) throw Object.assign(new Error("missing"), { code: "SESSION_NOT_FOUND" });
      deliveries += 1;
      return {
        sessionId: target.sessionId,
        provider: "codex",
        status: "completed",
        completedTurns: target.completionTarget,
        text: `turn ${target.completionTarget} done`,
        truth: {
          state: "idle", terminal: false, completedTurns: target.completionTarget, canonicalTurns: 1,
          pendingInstructions: 0, composerOccupied: false, modalOpen: false, detail: "Idle",
        },
        retrieval: deliveries === 1 ? "fresh" : "replay",
      };
    }),
  }));
  const notice = vi.fn(async () => ({ notice: { pending: 1, byKind: { settled: 1 }, oldestAgeSeconds: 2, dropped: 0, drain: "cyberdeck_notifications_read" as const }, text: "cyberdeck: 1 notifications pending → cyberdeck_notifications_read" }));
  const control = new OrchestratorNotificationControlPlane({
    inbox,
    bindings: { findBySessionId: async (id) => (id === ACTOR ? bound : undefined) },
    registry: {
      get: (id) => {
        const record = sessions.get(id);
        if (record === undefined) throw Object.assign(new Error("missing"), { code: "SESSION_NOT_FOUND" });
        return record;
      },
      waitForWorkerResults: waitForWorkerResults as never,
    },
    delivery: { notice },
  });
  const settled = (sessionId: string, target: number) => inbox.append({
    controllerId, kind: "settled", severity: "info", sessionId, completionTarget: target,
    summary: `${sessionId} completed turn ${target}`, wakeEligible: true,
    dedupeKey: `settled:${sessionId}:${target}`,
  }, { dedupe: "once" });
  return { inbox, control, controllerId, settled, waitForWorkerResults, notice };
}

describe("OrchestratorNotificationControlPlane", () => {
  it("drains by cursor, replays an unacknowledged page, and never repeats after acknowledgement (row 11)", async () => {
    const { control, settled, inbox, controllerId } = await harness();
    await settled(WORKER, 1);
    await inbox.append({ controllerId, kind: "progress", severity: "info", sessionId: WORKER, summary: "half way", wakeEligible: false, dedupeKey: `progress:${WORKER}` }, { dedupe: "replace" });
    const first = await control.read({ actorSessionId: ACTOR });
    expect(first.notifications.map((entry) => entry.kind)).toEqual(["settled", "progress"]);
    expect(first).toMatchObject({ nextCursor: 2, pending: 2, dropped: 0, policy: { wake: "steering-only" } });
    const replay = await control.read({ actorSessionId: ACTOR });
    expect(replay.notifications.map((entry) => entry.cursor)).toEqual([1, 2]);
    const after = await control.read({ actorSessionId: ACTOR, acknowledgeThrough: first.nextCursor });
    expect(after.notifications).toEqual([]);
    expect(after.pending).toBe(0);
    const again = await control.read({ actorSessionId: ACTOR, acknowledgeThrough: first.nextCursor });
    expect(again.notifications).toEqual([]);
  });

  it("embeds the bounded worker result on a settled record and makes the next wait a replay (row 12)", async () => {
    const { control, settled, waitForWorkerResults } = await harness();
    await settled(WORKER, 1);
    const drained = await control.read({ actorSessionId: ACTOR, maxResultChars: 300 });
    expect(drained.notifications[0]!.result).toMatchObject({
      status: "completed", completedTurns: 1, text: "turn 1 done", retrieval: "notification",
    });
    expect(waitForWorkerResults).toHaveBeenCalledWith([{ sessionId: WORKER, completionTarget: 1 }], 0, 300);
    const later = await waitForWorkerResults([{ sessionId: WORKER, completionTarget: 1 }]);
    expect(later.results[0]!.retrieval).toBe("replay");
    const replayed = await control.read({ actorSessionId: ACTOR });
    expect(replayed.notifications[0]!.result?.retrieval).toBe("replay");
  });

  it("filters records about workers outside the grant but still moves the cursor past them (row 14)", async () => {
    const { control, settled } = await harness({ binding: binding({ kind: "workspace", cwd: "/repo" }) });
    await settled(FOREIGN, 1);
    await settled(WORKER, 1);
    const drained = await control.read({ actorSessionId: ACTOR });
    expect(drained.notifications.map((entry) => entry.sessionId)).toEqual([WORKER]);
    expect(drained.nextCursor).toBe(2);
  });

  it("keeps a record whose worker the registry no longer knows", async () => {
    const { control, settled } = await harness();
    await settled("55555555-5555-4555-8555-555555555555", 1);
    const drained = await control.read({ actorSessionId: ACTOR });
    expect(drained.notifications).toHaveLength(1);
    expect(drained.notifications[0]!.result).toBeUndefined();
  });

  it("filters by kind and severity and bounds the page", async () => {
    const { control, settled, inbox, controllerId } = await harness();
    await settled(WORKER, 1);
    await inbox.append({ controllerId, kind: "risk", severity: "critical", sessionId: WORKER, summary: "disk full", wakeEligible: true });
    const risks = await control.read({ actorSessionId: ACTOR, kinds: ["risk"] });
    expect(risks.notifications.map((entry) => entry.kind)).toEqual(["risk"]);
    const critical = await control.read({ actorSessionId: ACTOR, severities: ["critical"], limit: 1 });
    expect(critical.notifications).toHaveLength(1);
    await expect(control.read({ actorSessionId: ACTOR, limit: 51 })).rejects.toThrow();
  });

  it("reads and merges the policy, and refuses an unbound actor", async () => {
    const { control } = await harness();
    await expect(control.configure({ actorSessionId: ACTOR })).resolves.toEqual({
      policy: { wake: "steering-only", quietMinutes: 10, maxWakesPerHour: 12, coalesceMs: 3000 },
    });
    await expect(control.configure({ actorSessionId: ACTOR, policy: { wake: "off", quietMinutes: 5 } })).resolves.toEqual({
      policy: { wake: "off", quietMinutes: 5, maxWakesPerHour: 12, coalesceMs: 3000 },
    });
    await expect(control.configure({ actorSessionId: ACTOR, policy: { maxWakesPerHour: 1 } })).resolves.toEqual({
      policy: { wake: "off", quietMinutes: 5, maxWakesPerHour: 1, coalesceMs: 3000 },
    });
    await expect(control.read({ actorSessionId: FOREIGN })).rejects.toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
  });

  it("answers the busy-path notice through delivery and nothing for an unbound actor", async () => {
    const { control, controllerId, notice } = await harness();
    await expect(control.notice({ actorSessionId: ACTOR })).resolves.toMatchObject({
      notice: { pending: 1, text: expect.stringContaining("cyberdeck_notifications_read") },
    });
    expect(notice).toHaveBeenCalledWith(controllerId);
    await expect(control.notice({ actorSessionId: FOREIGN })).resolves.toEqual({});
  });
});
