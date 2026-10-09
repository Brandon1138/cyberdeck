import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorNotificationDelivery } from "../../src/broker/orchestrator-notification-delivery.js";
import type { InstructionRecord } from "../../src/domain/instruction.js";
import { orchestratorController, type OrchestratorBinding } from "../../src/domain/orchestrator.js";
import { NoticeFileSchema, type NoticeFile, type NoticeShownFile } from "../../src/domain/orchestrator-notice-file.js";
import { DEFAULT_NOTIFICATION_POLICY } from "../../src/domain/orchestrator-notification.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { stableUuid } from "../../src/domain/stable-uuid.js";
import type { WorkerTruth, WorkerTruthState } from "../../src/domain/worker-truth.js";
import { OrchestratorControllerDirectory } from "../../src/orchestration/orchestrator-controller-directory.js";
import type { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import type { NoticeFilePort } from "../../src/orchestration/orchestrator-notice-file-port.js";
import { OrchestratorNotificationStore } from "../../src/persistence/orchestrator-notification-store.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const binding: OrchestratorBinding = {
  key: "fleet", kind: "primary", sessionId: SESSION, provider: "claude", cwd: "/repo",
  sandbox: "workspace-write", scope: { kind: "fleet" },
  grant: { subjectSessionId: SESSION, capabilities: ["thread.read"], scope: { kind: "fleet" } },
  createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z",
};
const CONTROLLER = orchestratorController(binding).controllerId;

class Clock {
  now = Date.parse(binding.createdAt);
  private sequence = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  setTimer = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.now + delay, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimer = (id: ReturnType<typeof setTimeout>) => { this.timers.delete(id as unknown as number); };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.now) { this.timers.delete(id); timer.callback(); }
    }
  }
}

class Files implements NoticeFilePort {
  readonly notices = new Map<string, NoticeFile>();
  readonly shown = new Map<string, NoticeShownFile>();
  write = vi.fn(async (sessionId: string, file: NoticeFile) => { this.notices.set(sessionId, file); });
  remove = vi.fn(async (sessionId: string) => { this.notices.delete(sessionId); });
  async readShown(sessionId: string) { return this.shown.get(sessionId); }
}

describe("OrchestratorNotificationDelivery", () => {
  let directory: string;
  let clock: Clock;
  let store: OrchestratorNotificationStore;
  let files: Files;
  let delivery: OrchestratorNotificationDelivery;
  let state: WorkerTruthState;
  let bindings: OrchestratorBinding[];
  let listeners: Set<(sessionId: string) => void>;
  let status: InstructionRecord["status"];
  let holdReason: string;
  let records: InstructionRecord[];
  let instructions: Pick<InstructionQueue, "enqueueBroker" | "withdraw" | "list" | "flush">;
  let registry: {
    get: ReturnType<typeof vi.fn<(sessionId: string) => SessionRecord>>;
    workerTruth: ReturnType<typeof vi.fn<(sessionId: string) => WorkerTruth>>;
    onSessionUpdate: (listener: (sessionId: string) => void) => () => void;
  };
  const createDelivery = () => new OrchestratorNotificationDelivery({
    inbox: store, controllers: new OrchestratorControllerDirectory({
      list: async () => bindings,
      findBySessionId: async (id) => bindings.find((entry) => entry.sessionId === id),
    }), registry, instructions, noticeFiles: files,
    now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  // Await application background work without advancing the injected clock or consuming a notice.
  // The queue is private in production; this barrier exists only to make no-side-effect checks exact.
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    const tails = (delivery as unknown as { tails: Map<string, Promise<unknown>> }).tails;
    while (tails.size > 0) await Promise.allSettled([...tails.values()]);
  };
  const append = async (wakeEligible = true, summary = "Worker settled") => {
    const result = await store.append({ controllerId: CONTROLLER, kind: "settled", severity: "info",
      sessionId: SESSION, summary, wakeEligible });
    await settle();
    return result.record!;
  };
  const advance = async (ms: number) => { clock.advance(ms); await settle(); };
  const update = async (next: WorkerTruthState) => {
    state = next;
    for (const listener of listeners) listener(SESSION);
    await settle();
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cyberdeck-notification-delivery-"));
    clock = new Clock();
    store = new OrchestratorNotificationStore(directory, { now: () => new Date(clock.now).toISOString() });
    await store.load();
    await store.setPolicy(CONTROLLER, { ...DEFAULT_NOTIFICATION_POLICY, coalesceMs: 100 });
    files = new Files();
    state = "idle";
    bindings = [binding];
    listeners = new Set();
    status = "rendered";
    holdReason = "wake-operator-active";
    records = [];
    registry = {
      get: vi.fn(() => ({ id: SESSION }) as SessionRecord),
      workerTruth: vi.fn(() => ({ state, terminal: false, completedTurns: 0, canonicalTurns: 0,
        pendingInstructions: 0, composerOccupied: false, modalOpen: false, detail: "test" })),
      onSessionUpdate: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    instructions = {
      flush: vi.fn(async () => records),
      enqueueBroker: vi.fn(async (input) => {
        const record: InstructionRecord = { ...input, id: randomUUID(), status, holdReason, hop: 0,
          createdAt: new Date(clock.now).toISOString(), updatedAt: new Date(clock.now).toISOString(), brokerOwned: true };
        records.push(record);
        return record;
      }),
      withdraw: vi.fn(async (sessionId, messageId) => {
        const record = records.find((entry) => entry.targetSessionId === sessionId && entry.messageId === messageId);
        if (record !== undefined && ["accepted", "queued"].includes(record.status)) record.status = "cancelled";
        return record;
      }),
      list: vi.fn(async (sessionId) => records.filter((record) => sessionId === undefined || record.targetSessionId === sessionId)),
    };
    delivery = createDelivery();
    await delivery.start();
  });
  afterEach(async () => {
    delivery.stop();
    await settle();
    await rm(directory, { recursive: true, force: true });
  });

  it("row 1: notices once per head, repeats after quietMinutes, serializes concurrent requests", async () => {
    state = "working";
    const first = await append();
    const results = await Promise.all([delivery.notice(CONTROLLER), delivery.notice(CONTROLLER)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(store.listPending(CONTROLLER, 0, 50)[0]!.deliveredVia).toEqual(["tool-result"]);
    expect(await delivery.notice(CONTROLLER)).toBeUndefined();
    await advance(DEFAULT_NOTIFICATION_POLICY.quietMinutes * 60_000 - 1);
    expect(await delivery.notice(CONTROLLER)).toBeUndefined();
    await advance(1);
    expect(await delivery.notice(CONTROLLER)).toBeDefined();
    await append();
    expect((await delivery.notice(CONTROLLER))!.notice.pending).toBe(2);
    expect(store.noticeState(CONTROLLER).lastNoticedCursor).toBeGreaterThan(first.cursor);
  });

  it("row 3: one deterministic broker wake after coalescing; rendered records are marked, not acknowledged", async () => {
    const notification = await append();
    await advance(99);
    expect(instructions.enqueueBroker).not.toHaveBeenCalled();
    await advance(1);
    expect(instructions.enqueueBroker).toHaveBeenCalledExactlyOnceWith({
      actorSessionId: SESSION, targetSessionId: SESSION,
      message: `[cyberdeck notice] ${files.notices.get(SESSION)!.text}`,
      messageId: stableUuid(`notice:${CONTROLLER}:${notification.cursor}`),
      submissionKind: "wake", wake: { controllerId: CONTROLLER, cursor: notification.cursor, notificationIds: [notification.id] },
    });
    expect(store.listPending(CONTROLLER, 0, 50)[0]!.deliveredVia).toEqual(["wake"]);
    expect(store.pendingCount(CONTROLLER)).toBe(1);
    expect(store.noticeState(CONTROLLER).lastNoticedCursor).toBe(notification.cursor);
    expect(await delivery.notice(CONTROLLER)).toBeUndefined();
  });

  it("row 4: a turn starting before the timer prevents enqueue", async () => {
    await append();
    await update("working");
    await advance(100);
    expect(instructions.enqueueBroker).not.toHaveBeenCalled();
    expect(files.notices.has(SESSION)).toBe(true);
    expect(await delivery.notice(CONTROLLER)).toBeDefined();
  });

  it("row 4: queued wake is withdrawn and forgotten when the orchestrator becomes working", async () => {
    status = "queued";
    await append();
    await advance(100);
    await update("working");
    expect(instructions.withdraw).toHaveBeenCalledExactlyOnceWith(SESSION, records[0]!.messageId);
    expect(records[0]!.status).toBe("cancelled");
    await update("working");
    expect(instructions.withdraw).toHaveBeenCalledTimes(1);
    expect(await delivery.notice(CONTROLLER)).toBeDefined();
    expect(await delivery.notice(CONTROLLER)).toBeUndefined();
  });

  it("row 5: wake-specific holds stay queued and do not block tool-result notices", async () => {
    status = "queued";
    await append();
    await advance(100);
    expect(records[0]).toMatchObject({ status: "queued", holdReason: "wake-operator-active" });
    await append();
    await advance(100);
    expect(instructions.enqueueBroker).toHaveBeenCalledTimes(1);
    expect(await delivery.notice(CONTROLLER)).toBeDefined();
    expect(await delivery.notice(CONTROLLER)).toBeUndefined();
    await settle();
    expect(records[0]!.status).toBe("queued");
  });

  it("row 9: wake off never enqueues but still notices", async () => {
    await store.setPolicy(CONTROLLER, { ...store.policy(CONTROLLER), wake: "off" });
    await append();
    await advance(60_000);
    expect(instructions.enqueueBroker).not.toHaveBeenCalled();
    expect(await delivery.notice(CONTROLLER)).toBeDefined();
  });

  it("row 10: rolling ceiling adds one deduped budget record and retries after expiry", async () => {
    await store.setPolicy(CONTROLLER, { ...store.policy(CONTROLLER), maxWakesPerHour: 2 });
    await append(); await advance(100);
    await append(); await advance(100);
    await append(); await advance(100);
    await append(); await advance(100);
    expect(instructions.enqueueBroker).toHaveBeenCalledTimes(2);
    const budgets = store.listPending(CONTROLLER, 0, 50).filter((record) => record.kind === "budget");
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({ severity: "warning", wakeEligible: false,
      summary: "wake ceiling of 2 per hour reached; wakes suppressed until 2026-10-07T11:00:00.100Z",
      dedupeKey: `wake-budget:${CONTROLLER}:2026-10-07T10:00:00.100Z` });
    await advance(60 * 60 * 1000 - 300);
    expect(instructions.enqueueBroker).toHaveBeenCalledTimes(3);
  });

  it("maxWakesPerHour zero never wakes", async () => {
    await store.setPolicy(CONTROLLER, { ...store.policy(CONTROLLER), maxWakesPerHour: 0 });
    await append(); await advance(100); await advance(100);
    expect(instructions.enqueueBroker).not.toHaveBeenCalled();
    expect(store.listPending(CONTROLLER, 0, 50).filter((record) => record.kind === "budget")).toHaveLength(1);
  });

  it("row 13: fresh store replay rebuilds notices and removes an empty controller's stale file", async () => {
    await append();
    delivery.stop(); await settle();
    store = new OrchestratorNotificationStore(directory, { now: () => new Date(clock.now).toISOString() });
    await store.load();
    files.notices.clear();
    delivery = createDelivery(); await delivery.start();
    expect(files.notices.get(SESSION)!.pending).toBe(1);
    await store.acknowledgeThrough(CONTROLLER, store.headCursor(CONTROLLER)); await settle();
    delivery.stop();
    files.notices.set(SESSION, { schemaVersion: 1, controllerId: CONTROLLER, sessionId: SESSION,
      cursor: 1, noticedCursor: 0, pending: 1, dropped: 0, text: "stale", writtenAt: binding.createdAt });
    store = new OrchestratorNotificationStore(directory); await store.load();
    delivery = createDelivery(); await delivery.start();
    expect(files.notices.has(SESSION)).toBe(false);
  });

  it("hook sidecar at head suppresses piggyback and idle wake", async () => {
    const record = await append();
    files.shown.set(SESSION, { schemaVersion: 1, cursor: record.cursor, shownAt: binding.createdAt });
    expect(await delivery.notice(CONTROLLER)).toBeUndefined();
    await advance(100);
    expect(instructions.enqueueBroker).not.toHaveBeenCalled();
  });

  it("row 16: file matches schema and bounded text, total count exceeds page count", async () => {
    for (let i = 0; i < 51; i++) await append(false);
    await store.append({ controllerId: CONTROLLER, sessionId: SESSION, kind: "intervention",
      severity: "critical", summary: "x".repeat(512), wakeEligible: true }); await settle();
    const notice = (await delivery.noticeFor(CONTROLLER))!;
    expect(notice.notice.pending).toBe(52);
    expect(notice.notice.byKind.settled).toBe(50);
    expect(NoticeFileSchema.safeParse(files.notices.get(SESSION)).success).toBe(true);
    expect(files.notices.get(SESSION)!.text.length).toBeLessThanOrEqual(400);
    await advance(100);
    expect(instructions.enqueueBroker).toHaveBeenCalledTimes(1);
  });

  it("coalesces five changes without restarting the first timer", async () => {
    await append(); await advance(20);
    for (let i = 0; i < 4; i++) await append();
    expect(clock.timers.size).toBe(1);
    await advance(80);
    expect(instructions.enqueueBroker).toHaveBeenCalledTimes(1);
    expect(files.notices.get(SESSION)!.pending).toBe(5);
  });

  it("writes the controller's quiet interval into the notice file so a hook can repeat after it", async () => {
    await store.setPolicy(CONTROLLER, { ...DEFAULT_NOTIFICATION_POLICY, coalesceMs: 100, quietMinutes: 3 });
    await append(false);
    const file = files.notices.get(SESSION)!;
    expect(NoticeFileSchema.safeParse(file).success).toBe(true);
    expect(file.quietMinutes).toBe(3);
    await delivery.notice(CONTROLLER);
    expect(files.notices.get(SESSION)!.quietMinutes).toBe(3);
  });

  it("row 16: long inline intervention is bounded in the notice file", async () => {
    await store.append({ controllerId: CONTROLLER, sessionId: SESSION, kind: "intervention",
      severity: "critical", summary: "x".repeat(512), wakeEligible: true }); await settle();
    const file = files.notices.get(SESSION)!;
    expect(NoticeFileSchema.safeParse(file).success).toBe(true);
    expect(file.text.length).toBeLessThanOrEqual(400);
    expect(file.text).toContain("critical:");
  });

  it("a drain racing the sidecar read prevents enqueue", async () => {
    await append();
    const readShown = vi.spyOn(files, "readShown");
    readShown.mockImplementationOnce(async () => {
      await store.acknowledgeThrough(CONTROLLER, store.headCursor(CONTROLLER));
      return undefined;
    });
    await advance(100);
    expect(instructions.enqueueBroker).not.toHaveBeenCalled();
    expect(files.notices.has(SESSION)).toBe(false);
  });

  it("a working update racing enqueue withdraws the newly held wake", async () => {
    status = "queued";
    const original = instructions.enqueueBroker;
    vi.mocked(instructions.enqueueBroker).mockImplementationOnce(async (input) => {
      const record: InstructionRecord = { ...input, id: randomUUID(), status: "queued", hop: 0,
        createdAt: binding.createdAt, updatedAt: binding.createdAt };
      records.push(record);
      state = "working";
      for (const listener of listeners) listener(SESSION);
      return record;
    });
    await append(); await advance(100);
    expect(instructions.withdraw).toHaveBeenCalledTimes(1);
    expect(records[0]!.status).toBe("cancelled");
    expect(await delivery.notice(CONTROLLER)).toBeDefined();
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("a later rendered wake does not roll the noticed cursor back after a newer tool result", async () => {
    status = "queued";
    await append(); await advance(100);
    await append();
    expect((await delivery.notice(CONTROLLER))!.notice.pending).toBe(2);
    await settle();
    records[0]!.status = "rendered";
    await update("working");
    expect(store.noticeState(CONTROLLER).lastNoticedCursor).toBe(2);
  });

  it.each(["provider-busy", "provider-modal", "composer-occupied"])("honors queued %s holds", async (hold) => {
    status = "queued"; holdReason = hold;
    await append(); await advance(100);
    await append(); await advance(100);
    expect(instructions.enqueueBroker).toHaveBeenCalledTimes(1);
    expect(records[0]!.status).toBe("queued");
    expect(store.noticeState(CONTROLLER).lastNoticedCursor).toBe(0);
  });

  it("a notice snapshot leaves a later producer append eligible for its own notice", async () => {
    state = "working";
    await append();
    const markNoticed = store.markNoticed.bind(store);
    vi.spyOn(store, "markNoticed").mockImplementationOnce(async (controllerId, cursor) => {
      await store.append({ controllerId, sessionId: SESSION, kind: "settled", severity: "info",
        summary: "new during delivery", wakeEligible: true });
      await markNoticed(controllerId, cursor);
    });
    expect((await delivery.notice(CONTROLLER))!.notice.pending).toBe(1);
    expect(store.noticeState(CONTROLLER).lastNoticedCursor).toBe(1);
    expect((await delivery.notice(CONTROLLER))!.notice.pending).toBe(2);
    expect(await delivery.notice(CONTROLLER)).toBeUndefined();
  });

  it("unknown controllers never throw and do not enqueue", async () => {
    bindings = [];
    await append(); await advance(100);
    expect(await delivery.notice(CONTROLLER)).toBeUndefined();
    expect(await delivery.notice("unknown")).toBeUndefined();
    expect(await delivery.shouldNotice("unknown")).toBe(false);
    expect(instructions.enqueueBroker).not.toHaveBeenCalled();
  });

  it("withdraws a queued wake when a drain wins; rendered withdrawal counts as delivered", async () => {
    status = "queued";
    await append(); await advance(100);
    records[0]!.status = "rendered";
    await store.acknowledgeThrough(CONTROLLER, store.headCursor(CONTROLLER)); await settle();
    expect(instructions.withdraw).toHaveBeenCalledTimes(1);
    expect(store.noticeState(CONTROLLER).lastNoticedCursor).toBe(1);
    expect(files.notices.has(SESSION)).toBe(false);
  });

  it.each(["submitted", "acknowledged", "completed"] as const)("%s return marks wake delivered", async (next) => {
    status = next;
    await append(); await advance(100);
    expect(store.listPending(CONTROLLER, 0, 50)[0]!.deliveredVia).toEqual(["wake"]);
  });

  it("queued wake rendering later is reconciled before a tool-result notice", async () => {
    status = "queued";
    await append(); await advance(100);
    records[0]!.status = "rendered";
    await update("working");
    expect(store.listPending(CONTROLLER, 0, 50)[0]!.deliveredVia).toEqual(["wake"]);
    expect(await delivery.notice(CONTROLLER)).toBeUndefined();
  });

  it.each(["SESSION_NOT_FOUND", "OTHER_ERROR"])("contains %s from enqueue and leaves inbox pending", async (code) => {
    vi.mocked(instructions.enqueueBroker).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    await append(); await advance(100);
    expect(store.pendingCount(CONTROLLER)).toBe(1);
    expect(store.noticeState(CONTROLLER).lastNoticedCursor).toBe(0);
    expect(await delivery.notice(CONTROLLER)).toBeDefined();
  });

  it("undelivered terminal wake leaves records pending and permits a later notice", async () => {
    status = "undelivered";
    await append(); await advance(100);
    expect(store.listPending(CONTROLLER, 0, 50)[0]!.deliveredVia).toEqual([]);
    expect(await delivery.notice(CONTROLLER)).toBeDefined();
  });

  it("stop unsubscribes and clears every timer, including budget retry timers", async () => {
    await append();
    delivery.stop();
    expect(clock.timers.size).toBe(0);
    expect(listeners.size).toBe(0);
    await advance(100);
    expect(instructions.enqueueBroker).not.toHaveBeenCalled();
    await store.append({ controllerId: CONTROLLER, sessionId: SESSION, kind: "settled", severity: "info",
      summary: "after stop", wakeEligible: true });
    expect(clock.timers.size).toBe(0);
  });
});
