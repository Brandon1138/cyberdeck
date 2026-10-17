import { randomUUID } from "node:crypto";
import { z } from "zod";
import { grantAllows, type CyberdeckCapability } from "../domain/capability.js";
import {
  ATTENTION_LIMITS, AttentionError, AttentionWakeHeldError, AttentionStatementSchema,
  type AttentionCoverage, type AttentionStatement, type OrchestratorAttention,
} from "../domain/orchestrator-attention.js";
import { orchestratorController, type OrchestratorBinding } from "../domain/orchestrator.js";
import type { OrchestratorBindingDirectory } from "./orchestrator-controller-directory.js";
import type { AttentionStorePort } from "./orchestrator-attention-ports.js";
import {
  attentionDigest, captureAttentionSources, type AttentionSourceOptions, type AttentionSourceSnapshot,
} from "./orchestrator-attention-source.js";
import type { WorkerEventObserver, HandoffBatchObserver } from "../broker/observed-worker-coordination.js";
import type { InstructionRecord } from "../domain/instruction.js";
import type { NotificationInboxPort } from "./orchestrator-notification-ports.js";

/** Reuse the existing grants; old persisted primary and peer bindings need no migration. */
export const ATTENTION_TOOL_CAPABILITIES = {
  cyberdeck_attention_arm: "thread.enqueue",
  cyberdeck_attention_cancel: "thread.enqueue",
  cyberdeck_notifications_read: "thread.read",
} as const satisfies Record<string, CyberdeckCapability>;

export const AgentAttentionArmParamsSchema = AttentionStatementSchema.extend({
  actorSessionId: z.uuid(), mutationId: z.uuid(), previousEpoch: z.uuid().optional(),
}).strict();
export const AgentAttentionCancelParamsSchema = z.object({
  actorSessionId: z.uuid(), epoch: z.uuid(), reason: z.string().trim().min(1).max(1_024).default("Cancelled by orchestrator"),
}).strict();

export interface OrchestratorAttentionOptions extends AttentionSourceOptions {
  store: AttentionStorePort;
  bindings: OrchestratorBindingDirectory;
  inbox: Pick<NotificationInboxPort, "policy">;
  registry: AttentionSourceOptions["registry"] & {
    onSessionUpdate(listener: (sessionId: string) => void): () => void;
    isStopRequested(sessionId: string): boolean;
  };
  coordination: AttentionSourceOptions["coordination"] & {
    onEventSubmitted(listener: WorkerEventObserver): () => void;
    onHandoffCommitted(listener: HandoffBatchObserver): () => void;
    onSubjectChanged?(listener: (sessionId: string) => void): () => void;
  };
  now?: () => string;
  onError?: (error: unknown) => void;
}

export interface AttentionReadPage {
  epoch: string; receiptId: string; snapshotId: string;
  statement: OrchestratorAttention["statement"];
  recovery: OrchestratorAttention["recovery"];
  captured: AttentionCoverage; consumed: AttentionCoverage;
  workers: AttentionSourceSnapshot["workers"]; gaps: OrchestratorAttention["gaps"];
  decision?: OrchestratorAttention["decision"];
  pendingIntent?: OrchestratorAttention["pendingIntent"];
  lastWake?: OrchestratorAttention["lastWake"];
}

/** Explicit waits, source capture and the authority transaction used by the existing wake queue. */
export class OrchestratorAttentionControlPlane {
  private readonly active = new Map<string, OrchestratorAttention>();
  private readonly scheduled = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly unsubscribes: Array<() => void> = [];
  private started = false;
  private readonly listeners = new Set<(controllerId: string) => void>();

  constructor(private readonly options: OrchestratorAttentionOptions) {}
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Subscribe before loading/registration, then reconcile: neither startup nor arm has a blind gap.
    this.unsubscribes.push(this.options.registry.onSessionUpdate((id) => this.changed(id)),
      this.options.coordination.onEventSubmitted((event) => this.changed(event.workerId)),
      this.options.coordination.onHandoffCommitted((_input, result) => {
        for (const member of result.handoff?.manifest ?? []) this.changed(member.workerId);
      }));
    const unsubscribeSubjects = this.options.coordination.onSubjectChanged?.((id) => this.changed(id));
    if (unsubscribeSubjects !== undefined) this.unsubscribes.push(unsubscribeSubjects);
    try {
      for (const record of await this.options.store.list()) this.remember(record);
      for (const controllerId of [...this.active.keys()]) await this.reconcile(controllerId);
    } catch (error) { this.stop(); throw error; }
  }

  stop(): void {
    this.started = false;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  async arm(input: z.input<typeof AgentAttentionArmParamsSchema>): Promise<OrchestratorAttention> {
    const request = AgentAttentionArmParamsSchema.parse(input);
    const binding = await this.requireBinding(request.actorSessionId, ATTENTION_TOOL_CAPABILITIES.cyberdeck_attention_arm);
    const controllerId = orchestratorController(binding).controllerId;
    const { actorSessionId, mutationId, previousEpoch, ...statement } = request;
    const requestHash = attentionDigest(request);
    const record = await this.options.store.update(controllerId, async (current) => {
      await this.revalidate(binding, "thread.enqueue");
      if (current?.armMutationId === mutationId) {
        if (current.armRequestHash !== requestHash) throw new AttentionError("MUTATION_ID_CONFLICT", "Arm mutation ID reused with another request");
        return current; // A cancelled request stays cancelled even after a lost arm response.
      }
      if (current !== undefined && current.epoch !== previousEpoch) {
        // Only the current authorized controller reaches this discovery path. Keep replacement CAS explicit.
        throw new AttentionError("ATTENTION_ALREADY_ARMED",
          `Current attention epoch=${current.epoch} status=${current.status}. Pass this previousEpoch to replace the prior wait, including a cancelled wait`);
      }
      if (previousEpoch !== undefined && current?.epoch !== previousEpoch) this.stale();
      const authorities = statement.targets.map((target) => {
        const worker = this.options.registry.get(target.sessionId);
        if (worker.kind === "orchestrator" || !grantAllows(binding.grant, "thread.read", worker)
          || !grantAllows(binding.grant, "thread.enqueue", worker)) {
          throw new AttentionError("CAPABILITY_DENIED", "Wait target is outside the worker grant");
        }
        const subject = this.options.coordination.getSubject(target.sessionId);
        if (subject?.lease.state !== "active" || subject.lease.controller?.controllerId !== controllerId) {
          throw new AttentionError("OWNERSHIP_LOST", "Wait target is not currently controlled by this orchestrator");
        }
        return { sessionId: target.sessionId, leaseVersion: subject.lease.version, cwd: worker.cwd };
      });
      const at = this.now();
      const actorLedger = await this.options.transcripts.readCompletionLedger(actorSessionId);
      let next: OrchestratorAttention = {
        schemaVersion: 1, controllerId, actorSessionId, bindingKey: binding.key,
        epoch: randomUUID(), armMutationId: mutationId, armRequestHash: requestHash, statement, authorities,
        status: "armed", recovery: "ready", armedAt: at, updatedAt: at, actorTurnFloor: actorLedger.completedTurns, snapshotId: attentionDigest({}),
        coverage: { captured: inheritedCoverage(current, statement, "captured"), evaluated: [], noticed: [], submitted: [],
          consumed: inheritedCoverage(current, statement, "consumed") },
        gaps: [], readSequence: 0, receipts: [],
        ...(current?.lastWake === undefined ? {} : { lastWake: current.lastWake }),
      };
      next = await this.refresh(next);
      await this.revalidate(binding, "thread.enqueue");
      for (const authority of authorities) {
        const subject = this.options.coordination.getSubject(authority.sessionId);
        if (subject?.lease.state !== "active" || subject.lease.controller?.controllerId !== controllerId
          || subject.lease.version !== authority.leaseVersion) throw new AttentionError("OWNERSHIP_LOST", "Wait target changed authority during arm");
      }
      return next;
    });
    this.remember(record!);
    // Register, then take a second source cut. A report committed during the first write is retained.
    const reconciled = (await this.reconcile(controllerId, record!.epoch))!;
    if (reconciled.epoch !== record!.epoch) this.stale();
    return reconciled;
  }

  async cancel(input: z.input<typeof AgentAttentionCancelParamsSchema>): Promise<OrchestratorAttention> {
    const request = AgentAttentionCancelParamsSchema.parse(input);
    const binding = await this.requireBinding(request.actorSessionId, ATTENTION_TOOL_CAPABILITIES.cyberdeck_attention_cancel);
    const record = await this.options.store.update(orchestratorController(binding).controllerId, async (current) => {
      await this.revalidate(binding, "thread.enqueue");
      this.requireEpoch(current, binding, request.epoch);
      return current!.status === "cancelled" ? current : this.cancelled(current!, request.reason);
    });
    this.remember(record!);
    return record!;
  }

  /** Called by the existing manager's binding lifecycle; no second authority derivation. */
  async bindingRemoved(binding: OrchestratorBinding): Promise<void> {
    const record = await this.options.store.update(orchestratorController(binding).controllerId, async (current) =>
      current?.actorSessionId === binding.sessionId && current.status === "armed"
        ? this.cancelled(current, "Orchestrator binding reset") : current);
    if (record !== undefined) this.remember(record);
  }

  async bindingChanged(binding: OrchestratorBinding): Promise<void> {
    const record = await this.options.store.update(orchestratorController(binding).controllerId, async (current) =>
      current !== undefined && current.actorSessionId !== binding.sessionId && current.status === "armed"
        ? this.cancelled(current, "Orchestrator binding replaced") : current);
    if (record !== undefined) this.remember(record);
  }

  async reconcile(controllerId: string, epoch?: string, notify = true): Promise<OrchestratorAttention | undefined> {
    const record = await this.options.store.update(controllerId, async (current) => {
      if (current?.status !== "armed" || (epoch !== undefined && current.epoch !== epoch)) return current;
      return this.refresh(current);
    });
    if (record !== undefined) this.remember(record, notify);
    return record;
  }

  onChange(listener: (controllerId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  schedulingRecords(): Promise<OrchestratorAttention[]> { return this.options.store.list(); }
  schedulingRecord(controllerId: string): Promise<OrchestratorAttention | undefined> { return this.options.store.get(controllerId); }

  async schedulingSnapshot(controllerId: string): Promise<{ record: OrchestratorAttention; sources: AttentionSourceSnapshot } | undefined> {
    let snapshot: { record: OrchestratorAttention; sources: AttentionSourceSnapshot } | undefined;
    await this.options.store.update(controllerId, async (current) => {
      if (current?.status !== "armed") return current;
      const record = await this.refresh(current);
      if (record.status !== "armed") return record;
      const sources = await captureAttentionSources(this.options, record);
      const next = { ...record, snapshotId: sources.snapshotId, gaps: sources.gaps,
        coverage: { ...record.coverage, captured: sources.captured } };
      snapshot = { record: next, sources };
      return next;
    });
    return snapshot;
  }

  /** Every decision application rereads disk and rechecks sources and authority after async I/O. */
  schedulingUpdate(controllerId: string, change: (record: OrchestratorAttention) => OrchestratorAttention): Promise<OrchestratorAttention | undefined> {
    return this.options.store.update(controllerId, async (current) => {
      if (current === undefined) return current;
      const record = current.status === "armed" ? await this.refresh(current) : current;
      if (record.status !== "armed") return record;
      const binding = await this.options.bindings.findBySessionId(record.actorSessionId);
      if (binding === undefined || binding.key !== record.bindingKey || orchestratorController(binding).controllerId !== record.controllerId
        || !this.hasSourceAuthority(binding, record)) return this.cancelled(record, "Orchestrator scheduling authority lost");
      return change(record);
    });
  }

  /** Holds epoch serialization through final binding lookup and the synchronous provider write. */
  async admitWake<T>(instruction: InstructionRecord, apply: () => T | Promise<T>): Promise<T> {
    const wake = instruction.wake!;
    await this.reconcile(wake.controllerId, wake.attentionEpoch, false);
    let result: T | undefined;
    let policyHeld = false;
    await this.options.store.update(wake.controllerId, async (record) => {
      if (wake.attentionEpoch === undefined) {
        if (record !== undefined) throw new AttentionWakeHeldError("attention-owns-wake-policy", true);
      } else {
        if (record === undefined || record.status !== "armed" || record.epoch !== wake.attentionEpoch
          || record.pendingIntent?.messageId !== instruction.messageId
          || record.actorSessionId !== instruction.targetSessionId) throw new AttentionWakeHeldError("attention-obsolete", true);
        const binding = await this.requireBinding(record.actorSessionId, "thread.enqueue");
        this.requireEpoch(record, binding, wake.attentionEpoch);
        if (!this.hasSourceAuthority(binding, record)) throw new AttentionWakeHeldError("attention-authority-lost", true);
        const actor = this.options.registry.get(record.actorSessionId);
        if (record.recovery !== "ready" || actor.exitCode !== null || actor.attentionState === "interrupted") {
          throw new AttentionWakeHeldError("attention-missing-process");
        }
        if (this.options.registry.isStopRequested(record.actorSessionId)) throw new AttentionWakeHeldError("attention-stopped", true);
        for (const authority of record.authorities) {
          const lease = this.options.coordination.getSubject(authority.sessionId)?.lease;
          const held = lease?.state === "active" && lease.controller?.controllerId === record.controllerId && lease.version === authority.leaseVersion;
          const recordedLoss = record.gaps.some((gap) => gap.sessionId === authority.sessionId
            && (gap.reason === "supervision-lost" || gap.reason === "worker-missing"));
          if (held === recordedLoss) throw new AttentionWakeHeldError("attention-source-changed");
        }
        // The policy may change during native preflight or binding I/O. No await from this
        // reading through apply: every write/retry uses the current operator policy.
        if (this.options.inbox.policy(wake.controllerId).wake === "off") {
          policyHeld = true;
          return { ...record, updatedAt: this.now(),
            ...(record.lastWake === undefined ? {} : { lastWake: { ...record.lastWake, holdReason: "notification-wake-off" } }) };
        }
      }
      result = await apply();
      return record;
    });
    // Persist the visible hold without clearing the intent, then let the queue retain eligibility.
    if (policyHeld) throw new AttentionWakeHeldError("notification-wake-off");
    return result as T;
  }

  async readPage(actorSessionId: string, epoch: string, notificationIds: string[], maxChars: number): Promise<AttentionReadPage> {
    const binding = await this.requireBinding(actorSessionId, ATTENTION_TOOL_CAPABILITIES.cyberdeck_notifications_read);
    const controllerId = orchestratorController(binding).controllerId;
    await this.reconcile(controllerId, epoch);
    let page: AttentionReadPage | undefined;
    await this.options.store.update(controllerId, async (current) => {
      this.requireEpoch(current, binding, epoch);
      if (current!.status !== "armed") throw new AttentionError("ATTENTION_CANCELLED", "This wait has been cancelled");
      await this.revalidate(binding, "thread.read");
      this.requireReadable(binding, current!);
      const sources = await captureAttentionSources(this.options, current!, maxChars);
      await this.revalidate(binding, "thread.read");
      this.requireReadable(binding, current!);
      const id = randomUUID();
      page = { epoch, receiptId: id, snapshotId: sources.snapshotId, statement: current!.statement,
        recovery: current!.recovery, captured: sources.captured, consumed: current!.coverage.consumed,
        workers: sources.workers, gaps: sources.gaps,
        ...(current!.decision === undefined ? {} : { decision: current!.decision }),
        ...(current!.pendingIntent === undefined ? {} : { pendingIntent: current!.pendingIntent }),
        ...(current!.lastWake === undefined ? {} : { lastWake: current!.lastWake }) };
      return { ...current!, snapshotId: sources.snapshotId, gaps: sources.gaps,
        coverage: { ...current!.coverage, captured: sources.captured }, updatedAt: this.now(),
        readSequence: current!.readSequence + 1,
        receipts: [...current!.receipts, { id, epoch, sequence: current!.readSequence + 1,
          coverage: sources.received, notificationIds, createdAt: this.now() }].slice(-ATTENTION_LIMITS.receipts) };
    });
    // Persistence is an async authority boundary, not proof that the actor received the page.
    // Read through the store's serialization so a queued cancel/re-arm cannot return stale source data.
    await this.options.store.update(controllerId, async (current) => {
      await this.revalidate(binding, "thread.read");
      this.requireEpoch(current, binding, epoch);
      if (current!.status !== "armed") throw new AttentionError("ATTENTION_CANCELLED", "This wait has been cancelled");
      this.requireReadable(binding, current!);
      this.remember(current!);
      return current;
    });
    return page!;
  }

  /** Bank consumption first. A retry after a crash replays the same selective inbox acknowledgement. */
  async acknowledge(actorSessionId: string, epoch: string, receiptId: string): Promise<string[]> {
    const binding = await this.requireBinding(actorSessionId, ATTENTION_TOOL_CAPABILITIES.cyberdeck_notifications_read);
    let notificationIds: string[] = [];
    const record = await this.options.store.update(orchestratorController(binding).controllerId, async (current) => {
      this.requireEpoch(current, binding, epoch);
      if (current!.status !== "armed") throw new AttentionError("ATTENTION_CANCELLED", "This wait has been cancelled");
      await this.revalidate(binding, "thread.read");
      this.requireReadable(binding, current!);
      const receipt = current!.receipts.find((entry) => entry.id === receiptId);
      if (receipt === undefined) throw new AttentionError("STALE_ATTENTION_RECEIPT", "Read receipt is unknown or no longer retained; read again");
      notificationIds = receipt.notificationIds;
      if (receipt.acknowledgedAt !== undefined) return current;
      const at = this.now();
      const newer = receipt.sequence > (current!.consumption?.sequence ?? 0);
      return { ...current!, updatedAt: at,
        coverage: { ...current!.coverage, consumed: mergeConsumed(current!.coverage.consumed, receipt.coverage, newer) },
        receipts: current!.receipts.map((entry) => entry.id === receiptId ? { ...entry, acknowledgedAt: at } : entry),
        ...(newer ? { consumption: { receiptId, sequence: receipt.sequence, coverage: receipt.coverage, at } } : {}),
      };
    });
    this.remember(record!);
    return notificationIds;
  }

  async flush(): Promise<void> { await Promise.all(this.scheduled.values()); }

  private async refresh(record: OrchestratorAttention): Promise<OrchestratorAttention> {
    const binding = await this.options.bindings.findBySessionId(record.actorSessionId);
    if (binding === undefined || binding.key !== record.bindingKey
      || orchestratorController(binding).controllerId !== record.controllerId) return this.cancelled(record, "Orchestrator binding unavailable or replaced");
    let recovery: OrchestratorAttention["recovery"] = "ready";
    try {
      const actor = this.options.registry.get(record.actorSessionId);
      if (this.options.registry.isStopRequested(record.actorSessionId)
        || (actor.executionState === "cancelled" && actor.attentionState !== "interrupted")) {
        return this.cancelled(record, "Orchestrator stopped or cancelled");
      }
      if (actor.exitCode !== null || actor.attentionState === "interrupted") recovery = "held-missing-process";
    } catch (error) {
      if ((error as { code?: string }).code !== "SESSION_NOT_FOUND") throw error;
      recovery = "held-missing-process";
    }
    if (!this.hasSourceAuthority(binding, record)) return this.cancelled(record, "Orchestrator source authority lost");
    const actorLedger = await this.options.transcripts.readCompletionLedger(record.actorSessionId);
    if (actorLedger.turns.some((turn) => typeof turn.data?.turnNumber === "number"
      && turn.data.turnNumber > record.actorTurnFloor && turn.data.outcome === "cancelled")) {
      return this.cancelled(record, "Orchestrator turn cancelled after arming");
    }
    const sources = await captureAttentionSources(this.options, record);
    const currentBinding = await this.options.bindings.findBySessionId(record.actorSessionId);
    if (currentBinding === undefined || currentBinding.key !== binding.key
      || orchestratorController(currentBinding).controllerId !== record.controllerId) return this.cancelled(record, "Orchestrator binding changed during capture");
    if (!this.hasSourceAuthority(currentBinding, record)) return this.cancelled(record, "Orchestrator source authority lost");
    if (record.snapshotId === sources.snapshotId && record.recovery === recovery) return record;
    return { ...record, recovery, snapshotId: sources.snapshotId, gaps: sources.gaps,
      coverage: { ...record.coverage, captured: sources.captured }, updatedAt: this.now() };
  }

  private async requireBinding(actor: string, capability: CyberdeckCapability): Promise<OrchestratorBinding> {
    const binding = await this.options.bindings.findBySessionId(actor);
    if (binding === undefined) throw new AttentionError("ACTOR_NOT_AUTHORIZED", "Attention requires a bound orchestrator");
    if (!grantAllows(binding.grant, capability, { sessionId: actor, cwd: binding.cwd })) {
      throw new AttentionError("CAPABILITY_DENIED", `Attention requires ${capability}`);
    }
    return binding;
  }

  private async revalidate(binding: OrchestratorBinding, capability: CyberdeckCapability): Promise<void> {
    const current = await this.requireBinding(binding.sessionId, capability);
    if (current.key !== binding.key) throw new AttentionError("ACTOR_BINDING_ORPHANED", "Orchestrator binding changed during the operation");
    if (JSON.stringify(current.grant) !== JSON.stringify(binding.grant)) {
      throw new AttentionError("CAPABILITY_DENIED", "Orchestrator grant changed during the operation");
    }
  }

  private requireReadable(binding: OrchestratorBinding, record: OrchestratorAttention): void {
    for (const authority of record.authorities) {
      let cwd = authority.cwd;
      try { cwd = this.options.registry.get(authority.sessionId).cwd; }
      catch (error) { if ((error as { code?: string }).code !== "SESSION_NOT_FOUND") throw error; }
      if (!grantAllows(binding.grant, "thread.read", { sessionId: authority.sessionId, cwd })) {
        throw new AttentionError("CAPABILITY_DENIED", "Wait sources are outside the current read grant");
      }
    }
  }

  private hasSourceAuthority(binding: OrchestratorBinding, record: OrchestratorAttention): boolean {
    const actor = { sessionId: binding.sessionId, cwd: binding.cwd };
    if (!grantAllows(binding.grant, "thread.enqueue", actor) || !grantAllows(binding.grant, "thread.read", actor)) return false;
    try { this.requireReadable(binding, record); return true; }
    catch (error) {
      // Only ordinary grant loss is a per-record cancellation. Corruption and I/O still fail closed.
      if (error instanceof AttentionError && error.code === "CAPABILITY_DENIED") return false;
      throw error;
    }
  }

  private requireEpoch(record: OrchestratorAttention | undefined, binding: OrchestratorBinding, epoch: string): void {
    if (record === undefined || record.epoch !== epoch) this.stale();
    if (record!.actorSessionId !== binding.sessionId || record!.bindingKey !== binding.key) {
      throw new AttentionError("ACTOR_BINDING_ORPHANED", "Wait belongs to another binding");
    }
  }
  private stale(): never { throw new AttentionError("STALE_ATTENTION_EPOCH", "Wait epoch has changed; this operation cannot affect it"); }
  private cancelled(record: OrchestratorAttention, reason: string): OrchestratorAttention {
    const { pendingIntent: _intent, ...rest } = record;
    return { ...rest, status: "cancelled", cancelledAt: this.now(), cancelReason: reason, updatedAt: this.now(),
      ...(record.lastWake === undefined ? {} : { lastWake: { ...record.lastWake, holdReason: "attention-cancelled" } }) };
  }
  private remember(record: OrchestratorAttention, notify = true): void {
    if (record.status === "armed") this.active.set(record.controllerId, record);
    else this.active.delete(record.controllerId);
    if (notify) for (const listener of this.listeners) listener(record.controllerId);
  }
  private changed(sessionId: string): void {
    if (!this.started) return;
    for (const record of this.active.values()) {
      if (record.actorSessionId === sessionId || record.statement.targets.some((target) => target.sessionId === sessionId)) {
        this.schedule(record.controllerId);
      }
    }
  }
  private schedule(controllerId: string): void {
    this.dirty.add(controllerId);
    if (this.scheduled.has(controllerId)) return;
    const task = Promise.resolve().then(async () => {
      while (this.started && this.dirty.delete(controllerId)) await this.reconcile(controllerId);
    }).catch((error: unknown) => {
      if (this.options.onError !== undefined) this.options.onError(error);
      else process.emitWarning("Attention source capture failed; outstanding state remains pending", { code: "ATTENTION_CAPTURE_FAILED" });
    }).finally(() => this.scheduled.delete(controllerId));
    this.scheduled.set(controllerId, task);
  }
}

function mergeConsumed(prior: AttentionCoverage, received: AttentionCoverage, newer: boolean): AttentionCoverage {
  const points = new Map(prior.map((point) => [point.sessionId, point]));
  for (const point of received) {
    const previous = points.get(point.sessionId);
    points.set(point.sessionId, { ...point, eventOrdinal: Math.max(previous?.eventOrdinal ?? 0, point.eventOrdinal),
      completionTurn: Math.max(previous?.completionTurn ?? 0, point.completionTurn),
      truthKey: !newer && previous !== undefined ? previous.truthKey : point.truthKey });
  }
  return [...points.values()];
}

function inheritedCoverage(current: OrchestratorAttention | undefined, statement: AttentionStatement, kind: "captured" | "consumed"): AttentionCoverage {
  return current?.coverage[kind].filter((point) => statement.targets.some((target) => target.sessionId === point.sessionId))
    .map((point) => ({ ...point, completionTurn: current.statement.targets.find((target) => target.sessionId === point.sessionId)?.completionTarget
      === statement.targets.find((target) => target.sessionId === point.sessionId)?.completionTarget ? point.completionTurn : 0 })) ?? [];
}
