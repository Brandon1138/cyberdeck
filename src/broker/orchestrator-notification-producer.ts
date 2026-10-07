import type { InstructionRecord } from "../domain/instruction.js";
import {
  coalescedDedupeKey, NOTIFICATION_LIMITS, settledDedupeKey, wakeEligible,
} from "../domain/orchestrator-notification.js";
import type { SessionRecord } from "../domain/session.js";
import type { OwnershipSubject, WorkerEvent } from "../domain/worker-coordination.js";
import type { WorkerTruth } from "../domain/worker-truth.js";
import type { OrchestratorControllerDirectory } from "../orchestration/orchestrator-controller-directory.js";
import type {
  NewOrchestratorNotification, NotificationInboxPort,
} from "../orchestration/orchestrator-notification-ports.js";
import type { InstructionRepository } from "../orchestration/session/session-ports.js";
import type { HandoffBatchObserver, WorkerEventObserver } from "./observed-worker-coordination.js";
import type { WorkerBudgetUpdateListener } from "./worker-coordination.js";

export interface OrchestratorNotificationProducerOptions {
  registry: {
    onSessionUpdate(listener: (sessionId: string) => void): () => void;
    workerTruth(sessionId: string): WorkerTruth;
    get(sessionId: string): SessionRecord;
    list(): SessionRecord[];
  };
  coordination: {
    getSubject(workerId: string): OwnershipSubject | undefined;
    onEventSubmitted(observer: WorkerEventObserver): () => void;
    onHandoffCommitted(observer: HandoffBatchObserver): () => void;
    onBudgetUpdate(listener: WorkerBudgetUpdateListener): () => void;
  };
  controllers: OrchestratorControllerDirectory;
  inbox: NotificationInboxPort;
  instructions?: Pick<InstructionRepository, "list">;
  now?: () => string;
}

type Draft = Omit<NewOrchestratorNotification, "controllerId" | "sessionId" | "summary" | "wakeEligible">
  & { summary: string; modal?: boolean };
const MAX_SEEN_INSTRUCTIONS = 4_096;
const TARGET_STATUSES = new Set(["rendered", "submitted", "acknowledged", "completed"]);
const singleLine = (value: string): string => value.replace(/[\r\n\u2028\u2029]+/g, " ")
  .slice(0, NOTIFICATION_LIMITS.summaryChars);

/** Application-only projection. The inbox owns durability, coalescing and once-dedupe. */
export class OrchestratorNotificationProducer {
  private started = false;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly targets = new Map<string, Set<number>>();
  private readonly truths = new Map<string, WorkerTruth>();
  private readonly instructionStates = new Map<string, string>();
  private readonly budgetStates = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: OrchestratorNotificationProducerOptions) {}

  async start(): Promise<void> {
    if (this.started) return this.tail;
    this.started = true;
    this.unsubscribes.push(
      this.options.registry.onSessionUpdate((sessionId) => {
        if (!this.started) return;
        const record = this.worker(sessionId);
        if (record === undefined) return;
        // Capture each projection now, rather than losing short-lived edges behind async writes.
        const truth = this.options.registry.workerTruth(sessionId);
        this.background(() => this.sessionUpdate(record, truth));
      }),
      this.options.coordination.onEventSubmitted((event, ack) => {
        if (this.started && (ack.code === "accepted" || ack.code === "superseded")) {
          this.background(() => this.event(event));
        }
      }),
      this.options.coordination.onBudgetUpdate((workerId, budget) => {
        if (!this.started) return;
        const revision = budget.revision;
        const state = budget.enforcement.state;
        this.background(async () => {
          const key = `${revision}:${state}`;
          const previous = this.budgetStates.get(workerId);
          this.budgetStates.set(workerId, key);
          if (previous === key || (state !== "soft-pending" && state !== "soft-notified")) return;
          const record = this.worker(workerId);
          if (record !== undefined) await this.write(record, {
            kind: "budget", severity: "warning", dedupeKey: `budget:soft:${workerId}:${revision}`,
            summary: `budget ${state} (revision ${revision})`,
          });
        });
      }),
      this.options.coordination.onHandoffCommitted((_input, result) => {
        if (!this.started || result.handoff === undefined) return;
        const handoff = result.handoff;
        this.background(async () => {
          for (const member of handoff.manifest) {
            const subject = this.options.coordination.getSubject(member.workerId);
            const sessionId = subject?.resources.sessionId;
            const record = sessionId === undefined ? undefined : this.worker(sessionId);
            if (record === undefined || subject === undefined) continue;
            await this.write(record, {
              kind: "handoff", severity: "info",
              dedupeKey: `handoff:${handoff.handoffId}:${subject.subjectId}`,
              summary: `handoff: ${handoff.directive}`, refs: [handoff.handoffId],
              workerId: subject.subjectId,
            }, "once", handoff.recipient.controllerId);
          }
        });
      }),
    );
    const catchUp = this.enqueue(async () => {
      for (const instruction of await this.options.instructions?.list() ?? []) {
        this.rememberInstruction(instruction);
        if (this.worker(instruction.targetSessionId) !== undefined) this.addTarget(instruction);
      }
      for (const record of this.options.registry.list()) {
        if (record.kind === "orchestrator") continue;
        const truth = this.options.registry.workerTruth(record.id);
        // A restart recovers settlement, but must not manufacture fresh attention edges.
        await this.sessionUpdate(record, truth, true);
      }
    });
    try { await catchUp; } catch (error) { this.stop(); throw error; }
  }

  stop(): void {
    this.started = false;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    // Already observed mutations finish writing; stop prevents new input, not durable output.
  }

  observeInstruction(record: InstructionRecord): void {
    if (!this.started) return;
    const worker = this.worker(record.targetSessionId);
    if (worker === undefined) return;
    const snapshot = { ...record };
    this.background(async () => {
      const previous = this.instructionStates.get(snapshot.id);
      const state = this.rememberInstruction(snapshot);
      this.addTarget(snapshot);
      if (previous !== state && snapshot.brokerOwned !== true) {
        const reason = snapshot.status === "undelivered" ? "undelivered"
          : snapshot.status === "queued" && snapshot.holdReason === "human-controller"
            ? "human-controller" : undefined;
        if (reason !== undefined) await this.write(worker, {
          kind: "delivery", severity: "warning",
          dedupeKey: `delivery:${snapshot.id}:${reason}`,
          summary: `instruction ${snapshot.status}: ${snapshot.holdReason ?? "undelivered"}`,
          refs: [snapshot.id, snapshot.messageId],
        });
      }
      // Completion may have been observed before the queue persisted its expectedTurn.
      if (TARGET_STATUSES.has(snapshot.status)) {
        await this.settleTargets(worker, this.options.registry.workerTruth(worker.id));
      }
    });
  }

  private outstanding(sessionId: string): Set<number> {
    let targets = this.targets.get(sessionId);
    if (targets === undefined) { targets = new Set([1]); this.targets.set(sessionId, targets); }
    return targets;
  }

  private addTarget(record: InstructionRecord): void {
    if (record.expectedTurn !== undefined && TARGET_STATUSES.has(record.status)) {
      this.outstanding(record.targetSessionId).add(record.expectedTurn);
    }
  }

  private rememberInstruction(record: InstructionRecord): string {
    const state = `${record.status}:${record.holdReason ?? ""}`;
    this.instructionStates.delete(record.id);
    this.instructionStates.set(record.id, state);
    if (this.instructionStates.size > MAX_SEEN_INSTRUCTIONS) {
      this.instructionStates.delete(this.instructionStates.keys().next().value!);
    }
    return state;
  }

  private async settleTargets(record: SessionRecord, truth: WorkerTruth): Promise<void> {
    const targets = this.outstanding(record.id);
    for (const target of [...targets].sort((a, b) => a - b)) {
      if (target > truth.completedTurns) continue;
      const written = await this.write(record, {
        kind: "settled", severity: "info", completionTarget: target,
        dedupeKey: settledDedupeKey(record.id, target),
        summary: `turn ${target} settled; ${this.truthSummary(record, truth)}`,
        refs: record.profile === "scout" ? ["profile:scout"] : [],
      });
      if (written) targets.delete(target);
    }
  }

  private async sessionUpdate(record: SessionRecord, truth: WorkerTruth, catchUp = false): Promise<void> {
    const previous = this.truths.get(record.id);
    await this.settleTargets(record, truth);
    if (truth.terminal && (catchUp || previous?.terminal !== true)) {
      const completionTarget = [...this.outstanding(record.id)]
        .filter((target) => target > truth.completedTurns).sort((a, b) => a - b)[0];
      await this.write(record, {
        kind: "settled", severity: ["failed", "errored", "provider-limit"].includes(truth.state)
          ? "warning" : "info", completionTarget,
        dedupeKey: settledDedupeKey(record.id), summary: this.truthSummary(record, truth),
        refs: record.profile === "scout" ? ["profile:scout"] : [],
      });
    }
    if (!catchUp && truth.state === "blocked-modal" && previous?.state !== "blocked-modal") {
      const fingerprint = truth.modal?.fingerprint ?? "unknown";
      await this.write(record, {
        kind: "attention", severity: "warning", modal: true,
        dedupeKey: `attention:modal:${record.id}:${fingerprint}`,
        summary: `${truth.detail}${truth.modal === undefined ? "" : `; ${truth.modal.kind}`}`,
        refs: [fingerprint],
      });
    }
    if (!catchUp && truth.state === "stalled" && (previous?.state !== "stalled"
      || Math.floor((truth.stalledForSeconds ?? 0) / 300)
        > Math.floor((previous.stalledForSeconds ?? 0) / 300))) {
      await this.write(record, {
        kind: "attention", severity: "warning", dedupeKey: coalescedDedupeKey("attention", record.id),
        summary: `${truth.detail}; stalled ${truth.stalledForSeconds ?? 0}s`,
      }, "replace");
    }
    this.truths.set(record.id, truth);
  }

  private truthSummary(record: SessionRecord, truth: WorkerTruth): string {
    return `${truth.state}: ${truth.detail}${truth.providerLimit === undefined
      ? "" : `; ${truth.providerLimit.reason}`}${record.profile === "scout"
      ? `; scout${record.scout === undefined ? "" : ` ${record.scout.reportState}`}` : ""}`;
  }

  private async event(event: WorkerEvent): Promise<void> {
    const subject = this.options.coordination.getSubject(event.workerId);
    const record = this.worker(subject?.resources.sessionId ?? event.workerId);
    if (record === undefined) return;
    const intervention = event.kind === "DECISION_REQUEST"
      || (event.kind === "EXCEPTION" && event.interventionRequired)
      || (event.kind === "CHECKPOINT" && event.continuation === "awaiting-response");
    const kind = intervention ? "intervention" : event.kind === "RISK" ? "risk"
      : event.kind === "PROGRESS" || event.kind === "CHECKPOINT" ? "progress" : undefined;
    if (kind === undefined) return;
    await this.write(record, {
      kind, severity: kind === "progress" ? "info" : event.severity,
      dedupeKey: kind === "progress" ? coalescedDedupeKey("progress", record.id) : `event:${event.eventId}`,
      summary: `${event.summary}${event.recommendedAction === undefined ? "" : `; ${event.recommendedAction}`}`,
      refs: [event.eventId, ...(event.checkpointCorrelationId === undefined ? [] : [event.checkpointCorrelationId])],
      workerId: event.workerId, taskId: event.taskId, waveId: event.waveId,
    }, kind === "progress" ? "replace" : "once");
  }

  private worker(sessionId: string): SessionRecord | undefined {
    try {
      const record = this.options.registry.get(sessionId);
      return record.kind === "orchestrator" ? undefined : record;
    } catch { return undefined; }
  }

  private async write(
    record: SessionRecord, draft: Draft, dedupe: "once" | "replace" = "once", recipient?: string,
  ): Promise<boolean> {
    const subject = this.options.coordination.getSubject(record.id);
    const controllerId = recipient ?? subject?.lease.controller?.controllerId
      ?? subject?.origin.creatorControllerId
      ?? (record.parentSessionId === undefined ? undefined
        : (await this.options.controllers.forSession(record.parentSessionId))?.controllerId);
    if (controllerId === undefined) return false;
    const { modal, summary, ...fields } = draft;
    await this.options.inbox.append({
      workerId: subject?.subjectId ?? record.id,
      taskId: subject?.origin.taskId, waveId: subject?.origin.waveId,
      ...fields, controllerId, sessionId: record.id,
      summary: singleLine(`${record.name || record.id}: ${summary}`),
      wakeEligible: wakeEligible({ ...draft, policy: this.options.inbox.policy(controllerId) }),
      createdAt: this.options.now?.() ?? new Date().toISOString(),
    }, { dedupe });
    return true;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    // Keep later observations running even when one write fails. Startup still rejects its caller.
    this.tail = result.catch(() => undefined);
    return result;
  }

  private background(operation: () => Promise<void>): void {
    void this.enqueue(operation).catch(() => {
      process.emitWarning("Orchestrator notification producer write failed; inspect inbox health", {
        code: "ORCHESTRATOR_NOTIFICATION_WRITE_FAILED",
      });
    });
  }
}
