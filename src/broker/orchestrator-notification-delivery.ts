import type { InstructionRecord } from "../domain/instruction.js";
import { buildNotice, renderNotice, type Notice, type OrchestratorNotification } from "../domain/orchestrator-notification.js";
import type { SessionRecord } from "../domain/session.js";
import { stableUuid } from "../domain/stable-uuid.js";
import type { WorkerTruth } from "../domain/worker-truth.js";
import type { OrchestratorControllerDirectory } from "../orchestration/orchestrator-controller-directory.js";
import type { InstructionQueue } from "../orchestration/instruction-queue.js";
import type { NoticeFilePort } from "../orchestration/orchestrator-notice-file-port.js";
import type { NotificationInboxPort } from "../orchestration/orchestrator-notification-ports.js";
import { OrchestratorNotificationWakeBudget } from "./orchestrator-notification-wake-budget.js";

export interface OrchestratorNotificationDeliveryOptions {
  inbox: NotificationInboxPort;
  controllers: OrchestratorControllerDirectory;
  registry: {
    workerTruth(sessionId: string): WorkerTruth;
    onSessionUpdate(listener: (sessionId: string) => void): () => void;
    get(sessionId: string): SessionRecord;
  };
  instructions: Pick<InstructionQueue, "enqueueBroker" | "withdraw" | "list">;
  noticeFiles: NoticeFilePort;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface PendingWake {
  sessionId: string;
  messageId: string;
  head: number;
  ids: string[];
}
type RenderedNotice = { notice: Notice; text: string };
const delivered = (record: InstructionRecord): boolean =>
  ["rendered", "submitted", "acknowledged", "completed"].includes(record.status);

/** Inbox observation, hook projection and broker-owned idle wakes, with one writer per controller. */
export class OrchestratorNotificationDelivery {
  private readonly now: () => number;
  private readonly setTimer: NonNullable<OrchestratorNotificationDeliveryOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<OrchestratorNotificationDeliveryOptions["clearTimer"]>;
  private readonly subscriptions: Array<() => void> = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly pendingWakes = new Map<string, PendingWake>();
  private readonly budget = new OrchestratorNotificationWakeBudget();
  private started = false;
  private generation = 0;

  constructor(private readonly options: OrchestratorNotificationDeliveryOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.generation += 1;
    this.subscriptions.push(
      this.options.inbox.onChange((controllerId) => this.background(controllerId, () => this.changed(controllerId))),
      this.options.registry.onSessionUpdate((sessionId) => {
        for (const [controllerId, wake] of this.pendingWakes) {
          if (wake.sessionId === sessionId) this.background(controllerId, () => this.reconcile(controllerId));
        }
      }),
    );
    try {
      for (const controllerId of this.options.inbox.controllers()) {
        await this.serialize(controllerId, () => this.changed(controllerId));
      }
    } catch (error) { this.stop(); throw error; }
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
  }

  private serialize<T>(controllerId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(controllerId) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.tails.set(controllerId, next);
    return next.finally(() => {
      if (this.tails.get(controllerId) === next) this.tails.delete(controllerId);
    });
  }

  private background(controllerId: string, work: () => Promise<void>): void {
    const generation = this.generation;
    void this.serialize(controllerId, async () => {
      if (this.started && generation === this.generation) await work();
    }).catch(() => undefined); // Durable pending records remain available after any background failure.
  }

  async noticeFor(controllerId: string): Promise<RenderedNotice | undefined> {
    return this.snapshot(controllerId).result;
  }

  private snapshot(controllerId: string): { result: RenderedNotice | undefined; head: number; ids: string[] } {
    const inbox = this.options.inbox;
    // The port clamps pages to 50: kind counts and oldest age describe this first page only.
    const page = inbox.listPending(controllerId, 0, 50);
    const notice = buildNotice(page, new Date(this.now()).toISOString(), inbox.dropped(controllerId).sinceAcknowledged);
    if (notice !== undefined) notice.pending = inbox.pendingCount(controllerId);
    // No await between these reads: producers can append independently of our controller queue.
    return {
      head: inbox.headCursor(controllerId), ids: page.map((record) => record.id),
      result: notice === undefined ? undefined : { notice, text: renderNotice(notice) },
    };
  }

  async shouldNotice(controllerId: string): Promise<boolean> {
    const controller = await this.options.controllers.forController(controllerId);
    if (controller === undefined || await this.noticeFor(controllerId) === undefined) return false;
    const inbox = this.options.inbox;
    const shown = await this.options.noticeFiles.readShown(controller.sessionId);
    if (this.snapshot(controllerId).result === undefined) return false;
    const state = inbox.noticeState(controllerId);
    const lastShown = Math.max(state.lastNoticedCursor, shown?.cursor ?? 0);
    return inbox.headCursor(controllerId) > lastShown
      || (state.lastNoticedAt !== undefined
        && this.now() - Date.parse(state.lastNoticedAt) >= inbox.policy(controllerId).quietMinutes * 60_000);
  }

  notice(controllerId: string): Promise<RenderedNotice | undefined> {
    return this.serialize(controllerId, async () => {
      const controller = await this.options.controllers.forController(controllerId);
      if (controller === undefined) return undefined;
      // A queue flush may have rendered a wake since enqueue returned; reconcile before piggybacking.
      await this.reconcile(controllerId);
      if (!await this.shouldNotice(controllerId)) return undefined;
      const { result, head, ids } = this.snapshot(controllerId);
      if (result === undefined) return undefined;
      await this.options.inbox.markNoticed(controllerId, head);
      await this.options.inbox.markDelivered(controllerId, ids, "tool-result");
      await this.rewrite(controllerId);
      return result;
    });
  }

  private async rewrite(controllerId: string): Promise<void> {
    const controller = await this.options.controllers.forController(controllerId);
    if (controller === undefined) return;
    const { result, head } = this.snapshot(controllerId);
    if (result === undefined) {
      await this.options.noticeFiles.remove(controller.sessionId);
      return;
    }
    await this.options.noticeFiles.write(controller.sessionId, {
      schemaVersion: 1, controllerId, sessionId: controller.sessionId,
      cursor: head,
      noticedCursor: this.options.inbox.noticeState(controllerId).lastNoticedCursor,
      pending: result.notice.pending, dropped: result.notice.dropped, text: result.text,
      writtenAt: new Date(this.now()).toISOString(),
    });
  }

  private async changed(controllerId: string): Promise<void> {
    await this.rewrite(controllerId);
    await this.reconcile(controllerId);
    if (this.options.inbox.pendingCount(controllerId) === 0) {
      this.cancelTimer(controllerId);
      return;
    }
    if (!this.pendingWakes.has(controllerId) && this.hasEligible(controllerId)) {
      this.schedule(controllerId, this.options.inbox.policy(controllerId).coalesceMs);
    }
  }

  private hasEligible(controllerId: string): boolean {
    const inbox = this.options.inbox;
    if (inbox.policy(controllerId).wake === "off") return false;
    let after = inbox.noticeState(controllerId).lastNoticedCursor;
    // Wake eligibility must scan beyond the first page; earlier progress can fill all 50 slots.
    for (;;) {
      const page: OrchestratorNotification[] = inbox.listPending(controllerId, after, 50);
      if (page.some((record) => record.wakeEligible)) return true;
      if (page.length < 50) return false;
      after = page.at(-1)!.cursor;
    }
  }

  private cancelTimer(controllerId: string): void {
    const timer = this.timers.get(controllerId);
    if (timer !== undefined) this.clearTimer(timer);
    this.timers.delete(controllerId);
  }

  private schedule(controllerId: string, delay: number): void {
    if (!this.started || this.timers.has(controllerId)) return;
    const generation = this.generation;
    this.timers.set(controllerId, this.setTimer(() => {
      if (!this.started || generation !== this.generation) return;
      this.timers.delete(controllerId);
      this.background(controllerId, () => this.wake(controllerId));
    }, delay));
  }

  private async finishWake(controllerId: string, wake: PendingWake): Promise<void> {
    this.pendingWakes.delete(controllerId);
    await this.options.inbox.markDelivered(controllerId, wake.ids, "wake");
    await this.options.inbox.markNoticed(controllerId,
      Math.max(wake.head, this.options.inbox.noticeState(controllerId).lastNoticedCursor));
    await this.rewrite(controllerId);
  }

  private async reconcile(controllerId: string): Promise<void> {
    const wake = this.pendingWakes.get(controllerId);
    if (wake === undefined) return;
    const inbox = this.options.inbox;
    const withdraw = inbox.pendingCount(controllerId) === 0
      || this.options.registry.workerTruth(wake.sessionId).state === "working";
    const record = withdraw
      ? await this.options.instructions.withdraw(wake.sessionId, wake.messageId)
      : (await this.options.instructions.list(wake.sessionId)).find((entry) => entry.messageId === wake.messageId);
    if (record !== undefined && delivered(record)) await this.finishWake(controllerId, wake);
    else if (withdraw || record === undefined || ["cancelled", "undelivered"].includes(record.status)) {
      this.pendingWakes.delete(controllerId);
    }
  }

  private async wake(controllerId: string): Promise<void> {
    if (!this.hasEligible(controllerId) || this.pendingWakes.has(controllerId)) return;
    const controller = await this.options.controllers.forController(controllerId);
    if (controller === undefined || !this.started) return;
    const sessionId = controller.sessionId;
    this.options.registry.get(sessionId); // SESSION_NOT_FOUND is contained by the background task.
    if (this.options.registry.workerTruth(sessionId).state === "working") return;
    const shown = await this.options.noticeFiles.readShown(sessionId);
    // A drain or a turn can win while the sidecar read is in flight.
    if (!this.started || !this.hasEligible(controllerId)
      || this.options.registry.workerTruth(sessionId).state === "working") return;
    if ((shown?.cursor ?? 0) >= this.options.inbox.headCursor(controllerId)) return;
    const policy = this.options.inbox.policy(controllerId);
    const allowance = this.budget.check(controllerId, policy.maxWakesPerHour, this.now());
    if (!allowance.allowed) {
      // Schedule first: the appended budget record also emits onChange but cannot shorten this hold.
      if (policy.maxWakesPerHour > 0) this.schedule(controllerId, allowance.resumeAt! - this.now());
      await this.options.inbox.append({
        controllerId, kind: "budget", severity: "warning", sessionId,
        summary: `wake ceiling of ${policy.maxWakesPerHour} per hour reached; wakes suppressed until ${new Date(allowance.resumeAt!).toISOString()}`,
        wakeEligible: false, dedupeKey: `wake-budget:${controllerId}:${allowance.windowStartIso!}`,
      }, { dedupe: "once" });
      return;
    }
    const { result, head, ids } = this.snapshot(controllerId);
    if (result === undefined || !this.started) return;
    const wake: PendingWake = {
      sessionId, head, messageId: stableUuid(`notice:${controllerId}:${head}`),
      ids,
    };
    const record = await this.options.instructions.enqueueBroker({
      actorSessionId: sessionId, targetSessionId: sessionId,
      message: `[cyberdeck notice] ${result.text}`, messageId: wake.messageId,
    });
    // Returned held/undelivered records entered the queue; a thrown enqueue has no such proof.
    this.budget.record(controllerId, this.now());
    if (delivered(record)) await this.finishWake(controllerId, wake);
    else if (record.status === "queued" || record.status === "accepted") {
      this.pendingWakes.set(controllerId, wake);
      // Covers an update/drain racing the asynchronous enqueue, before the pending wake existed.
      await this.reconcile(controllerId);
    }
  }
}
