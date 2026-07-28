import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CheckpointRequestSchema,
  ControllerIdentitySchema,
  EventAckSchema,
  OwnershipMutationResultSchema,
  OwnershipSelectorSchema,
  OwnershipSubjectSchema,
  TERMINAL_WORKER_LIFECYCLES,
  WORKER_COORDINATION_SCHEMA_VERSION,
  WORKER_EVENT_LIMITS,
  WorkerEventSchema,
  type CheckpointRequest,
  type ControllerIdentity,
  type ControllerLiveness,
  type EventAck,
  type MutationReceipt,
  type OwnershipAuditRecord,
  type OwnershipMutationResult,
  type OwnershipOperationSchema,
  type OwnershipOutcome,
  type OwnershipSelector,
  type OwnershipSubject,
  type StoredWorkerEvent,
  type WorkerEvent,
  type WorkerLifecycle,
} from "../domain/worker-coordination.js";
import {
  WorkerCoordinationStore,
  type CoordinationTransaction,
} from "../persistence/worker-coordination-store.js";

type OwnershipOperation = z.infer<typeof OwnershipOperationSchema>;

export class WorkerCoordinationError extends Error {
  constructor(
    readonly code:
      | "SUBJECT_NOT_FOUND"
      | "MUTATION_ID_COLLISION"
      | "IMMUTABLE_ORIGIN_MISMATCH"
      | "LEASE_TOKEN_INVALID"
      | "OWNERSHIP_LOST"
      | "LEASE_EXPIRED"
      | "CHECKPOINT_NOT_FOUND"
      | "EVENT_NOT_FOUND"
      | "INVALID_EVENT",
    message: string,
  ) {
    super(message);
    this.name = "WorkerCoordinationError";
  }
}

export interface WorkerCoordinationOptions {
  store: WorkerCoordinationStore;
  now?: () => string;
  idFactory?: () => string;
  tokenFactory?: () => string;
  leaseDurationMs?: number;
  gracePeriodMs?: number;
  eventRateLimit?: number;
  eventRateWindowMs?: number;
  maxQueuedEventsPerWorker?: number;
  maxProjectionPageSize?: number;
}

export interface RegisterSubjectInput {
  mutationId: string;
  actor: ControllerIdentity;
  subjectId: string;
  subjectKind?: "worker" | "orchestrator";
  origin: OwnershipSubject["origin"];
  lifecycle: WorkerLifecycle;
  resources: OwnershipSubject["resources"];
  controller?: ControllerIdentity;
  reason: string;
}

interface LeaseMutationInput {
  mutationId: string;
  actor: ControllerIdentity;
  selector: OwnershipSelector;
  reason: string;
}

export interface AcquireInput extends LeaseMutationInput {
  controller: ControllerIdentity;
}

export interface AuthenticatedLeaseInput extends LeaseMutationInput {
  controller: ControllerIdentity;
  /** Single-scope convenience. Group scopes use one broker-issued token per subject. */
  leaseToken?: string;
  leaseTokens?: Readonly<Record<string, string>>;
  leaseVersion?: number;
}

export interface TransferInput extends AuthenticatedLeaseInput {
  newController: ControllerIdentity;
}

export interface AdoptInput extends LeaseMutationInput {
  newController: ControllerIdentity;
}

export interface AdoptBatchInput {
  mutationId: string;
  actor: ControllerIdentity;
  newController: ControllerIdentity;
  members: ReadonlyArray<{
    subjectId: string;
    mode: "acquire" | "adopt";
  }>;
  reason: string;
}

export interface AdoptBatchResult extends OwnershipMutationResult {
  committed: boolean;
}

export interface EventSubmissionInput {
  mutationId: string;
  controller: ControllerIdentity;
  leaseToken: string;
  event: unknown;
}

export interface EventResolutionInput {
  mutationId: string;
  controller: ControllerIdentity;
  leaseToken: string;
  eventId: string;
  resolution: "acknowledged" | "answered" | "superseded" | "closed";
  reason: string;
}

export interface EventProjectionFilter {
  workerIds?: string[];
  taskId?: string;
  waveId?: string;
  severities?: WorkerEvent["severity"][];
  kinds?: WorkerEvent["kind"][];
  intervention?: "unresolved" | "resolved" | "any";
}

export interface EventProjection {
  events: StoredWorkerEvent[];
  nextCursor: number;
  hasMore: boolean;
}

export interface CheckpointRequestInput {
  mutationId: string;
  controller: ControllerIdentity;
  leaseToken: string;
  correlationId: string;
  workerId: string;
  focus?: string;
  question?: string;
  mode?: "non-blocking" | "decision-gate";
}

const BROKER_ACTOR: ControllerIdentity = {
  controllerId: "cyberdeck-broker",
  familyId: "cyberdeck-broker",
  scope: { kind: "fleet", scopeId: "local-broker" },
};

/**
 * Durable broker-side state machine for controller leases and bounded worker event streams.
 * No provider, transcript, MCP, CLI, or UI assumptions live here.
 */
export class WorkerCoordinationService {
  private readonly subjects = new Map<string, OwnershipSubject>();
  private readonly events = new Map<string, StoredWorkerEvent>();
  private readonly checkpoints = new Map<string, CheckpointRequest>();
  private readonly audits: OwnershipAuditRecord[] = [];
  private readonly liveness = new Map<string, ControllerLiveness>();
  private readonly receipts = new Map<string, MutationReceipt>();
  private initialized = false;
  private tail = Promise.resolve();
  private nextOrdinal = 1;
  private readonly leaseDurationMs: number;
  private readonly gracePeriodMs: number;
  private readonly eventRateLimit: number;
  private readonly eventRateWindowMs: number;
  private readonly maxQueuedEventsPerWorker: number;
  private readonly maxProjectionPageSize: number;

  constructor(private readonly options: WorkerCoordinationOptions) {
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.gracePeriodMs = options.gracePeriodMs ?? 15_000;
    this.eventRateLimit = options.eventRateLimit ?? 20;
    this.eventRateWindowMs = options.eventRateWindowMs ?? 60_000;
    this.maxQueuedEventsPerWorker = options.maxQueuedEventsPerWorker ?? 256;
    this.maxProjectionPageSize = options.maxProjectionPageSize ?? 100;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const state = await this.options.store.load();
    for (const subject of state.subjects) this.subjects.set(subject.subjectId, subject);
    for (const event of state.events) {
      this.events.set(event.eventId, event);
      this.nextOrdinal = Math.max(this.nextOrdinal, event.ordinal + 1);
    }
    for (const checkpoint of state.checkpoints) {
      this.checkpoints.set(checkpoint.correlationId, checkpoint);
    }
    for (const audit of state.audits) this.audits.push(audit);
    for (const entry of state.liveness) this.liveness.set(entry.controller.controllerId, entry);
    for (const receipt of state.receipts) this.receipts.set(receipt.mutationId, receipt);
    this.initialized = true;
  }

  getSubject(subjectId: string): OwnershipSubject | undefined {
    return this.subjects.get(subjectId);
  }

  listSubjects(): OwnershipSubject[] {
    return [...this.subjects.values()];
  }

  listAudits(subjectId?: string): OwnershipAuditRecord[] {
    return this.audits.filter((entry) => subjectId === undefined || entry.subjectId === subjectId);
  }

  listCheckpoints(workerId?: string, state?: CheckpointRequest["state"]): CheckpointRequest[] {
    return [...this.checkpoints.values()].filter(
      (entry) =>
        (workerId === undefined || entry.workerId === workerId)
        && (state === undefined || entry.state === state),
    );
  }

  async registerSubject(input: RegisterSubjectInput): Promise<OwnershipMutationResult> {
    return this.exclusive(async () => {
      this.assertReady();
      const replay = this.replayOwnership(input.mutationId, "register");
      if (replay !== undefined) return replay;
      const actor = ControllerIdentitySchema.parse(input.actor);
      const existing = this.subjects.get(input.subjectId);
      if (existing !== undefined) {
        if (JSON.stringify(existing.origin) !== JSON.stringify(input.origin)) {
          throw new WorkerCoordinationError(
            "IMMUTABLE_ORIGIN_MISMATCH",
            `Subject ${input.subjectId} origin cannot change`,
          );
        }
        const result = this.result(input.mutationId, "register", [{
          subjectId: existing.subjectId,
          code: existing.lease.controller?.controllerId === input.controller?.controllerId
            ? "ALREADY_CONTROLLED"
            : "NOT_ELIGIBLE",
          leaseVersion: existing.lease.version,
          ...(existing.lease.controller !== undefined
            ? { currentController: existing.lease.controller }
            : {}),
          leaseExpiresAt: existing.lease.expiresAt,
        }]);
        await this.commitWithReceipt(result, {});
        return result;
      }

      const now = this.now();
      const controller = input.controller === undefined
        ? undefined
        : ControllerIdentitySchema.parse(input.controller);
      const token = controller === undefined ? undefined : this.issueToken();
      const subject = OwnershipSubjectSchema.parse({
        schemaVersion: WORKER_COORDINATION_SCHEMA_VERSION,
        subjectId: input.subjectId,
        subjectKind: input.subjectKind ?? "worker",
        origin: input.origin,
        lifecycle: input.lifecycle,
        resources: input.resources,
        lease: {
          leaseId: this.id(),
          version: 1,
          state: controller === undefined ? "orphaned" : "active",
          ...(controller === undefined ? {} : { controller, tokenHash: hashToken(token!) }),
          issuedAt: now,
          renewedAt: now,
          expiresAt: controller === undefined ? now : this.after(now, this.leaseDurationMs),
          ...(controller === undefined ? { orphanedAt: now, reason: input.reason } : {}),
        },
        decisionGate: { state: "none" },
        updatedAt: now,
      });
      const outcome: OwnershipOutcome = {
        subjectId: subject.subjectId,
        code: controller === undefined ? "ORPHANED" : "ACQUIRED",
        leaseVersion: 1,
        ...(token === undefined ? {} : { leaseToken: token }),
        ...(controller === undefined ? {} : { currentController: controller }),
        leaseExpiresAt: subject.lease.expiresAt,
      };
      const audit = this.audit(
        input.mutationId,
        "register",
        subject,
        actor,
        input.reason,
        undefined,
        controller,
        undefined,
        subject.lease.state,
        outcome.code,
      );
      const result = this.result(input.mutationId, "register", [outcome]);
      await this.commitWithReceipt(result, {
        subjects: [subject],
        audits: [audit],
        ...(controller === undefined
          ? {}
          : { liveness: [this.connectedObservation(controller, now, "subject registration")] }),
      });
      return result;
    });
  }

  async acquire(input: AcquireInput): Promise<OwnershipMutationResult> {
    return this.ownershipMutation("acquire", input, (subject, now) => {
      if (TERMINAL_WORKER_LIFECYCLES.has(subject.lifecycle)) {
        return { subject, outcome: this.outcome(subject, "WORKER_TERMINAL") };
      }
      if (isControlled(subject)) {
        if (subject.lease.controller?.controllerId === input.controller.controllerId) {
          return this.withNewController(subject, input.controller, now, "ALREADY_CONTROLLED");
        }
        return this.contested(subject, input.actor, input.reason, now);
      }
      if (subject.lease.state === "orphaned" || subject.lease.state === "expired") {
        return { subject, outcome: this.outcome(subject, "NOT_ELIGIBLE") };
      }
      return this.withNewController(subject, input.controller, now, "ACQUIRED");
    });
  }

  async renew(input: AuthenticatedLeaseInput): Promise<OwnershipMutationResult> {
    return this.authenticatedOwnershipMutation("renew", input, (subject, now) => {
      const renewed = this.renewed(subject, now);
      return { subject: renewed, outcome: this.outcome(renewed, "ALREADY_CONTROLLED") };
    });
  }

  /** Any authenticated controller call uses this same renewal path. */
  async authenticatedCall(input: AuthenticatedLeaseInput): Promise<OwnershipMutationResult> {
    return this.renew(input);
  }

  async release(input: AuthenticatedLeaseInput): Promise<OwnershipMutationResult> {
    return this.authenticatedOwnershipMutation("release", input, (subject, now) => {
      const released: OwnershipSubject = {
        ...subject,
        lease: {
          ...subject.lease,
          state: "released",
          tokenHash: undefined,
          releasedAt: now,
          reason: input.reason,
          contest: undefined,
        },
        updatedAt: now,
      };
      return { subject: released, outcome: this.outcome(released, "RELEASED") };
    });
  }

  async transfer(input: TransferInput): Promise<OwnershipMutationResult> {
    return this.authenticatedOwnershipMutation("transfer", input, (subject, now) =>
      this.withNewController(subject, input.newController, now, "TRANSFERRED"));
  }

  async adopt(input: AdoptInput): Promise<OwnershipMutationResult> {
    return this.ownershipMutation("adopt", input, (subject, now) => {
      if (TERMINAL_WORKER_LIFECYCLES.has(subject.lifecycle)) {
        return { subject, outcome: this.outcome(subject, "WORKER_TERMINAL") };
      }
      if (isControlled(subject)) return this.contested(subject, input.actor, input.reason, now);
      if (subject.lease.state !== "orphaned" && subject.lease.state !== "expired") {
        return { subject, outcome: this.outcome(subject, "NOT_ELIGIBLE") };
      }
      return this.withNewController(subject, input.newController, now, "ACQUIRED");
    });
  }

  /**
   * Atomically acquires every named recovery candidate or changes none of them.
   *
   * Eligibility is rechecked inside the substrate's exclusive section. Successful subjects,
   * audits, controller liveness, and the idempotency receipt share one append transaction, and
   * in-memory visibility changes only after that append succeeds.
   */
  async adoptBatch(input: AdoptBatchInput): Promise<AdoptBatchResult> {
    return this.exclusive(async () => {
      this.assertReady();
      const replay = this.replayAdoptBatch(input.mutationId);
      if (replay !== undefined) return replay;
      const actor = ControllerIdentitySchema.parse(input.actor);
      const newController = ControllerIdentitySchema.parse(input.newController);
      const now = this.now();
      const seen = new Set<string>();
      const candidates: Array<{
        original: OwnershipSubject;
        current: OwnershipSubject;
      }> = [];
      const failures = new Map<string, OwnershipOutcome>();

      for (const member of input.members) {
        if (seen.has(member.subjectId)) {
          throw new Error(`Atomic adoption batch contains duplicate subject ${member.subjectId}`);
        }
        seen.add(member.subjectId);
        const original = this.requireSubject(member.subjectId);
        const current = this.expiredCopy(original, now);
        candidates.push({ original, current });
        if (TERMINAL_WORKER_LIFECYCLES.has(current.lifecycle)) {
          failures.set(member.subjectId, this.outcome(current, "WORKER_TERMINAL"));
          continue;
        }
        if (isControlled(current)) {
          failures.set(member.subjectId, this.outcome(
            current,
            "LEASE_CONFLICT",
            `controlled by ${current.lease.controller?.controllerId ?? "unknown"} until ${current.lease.expiresAt}`,
          ));
          continue;
        }
        const eligible = member.mode === "adopt"
          ? current.lease.state === "orphaned" || current.lease.state === "expired"
          : current.lease.state === "released";
        if (!eligible) failures.set(member.subjectId, this.outcome(current, "NOT_ELIGIBLE"));
      }

      if (failures.size > 0) {
        const outcomes = candidates.map(({ current }) =>
          failures.get(current.subjectId) ?? this.outcome(
            current,
            "NOT_ELIGIBLE",
            "atomic adoption aborted because another batch member was ineligible",
          ));
        const result = this.adoptBatchResult(input.mutationId, false, outcomes);
        await this.persistReceipt(input.mutationId, "adopt", result, {});
        return result;
      }

      const changed: OwnershipSubject[] = [];
      const outcomes: OwnershipOutcome[] = [];
      const audits: OwnershipAuditRecord[] = [];
      for (const { original, current } of candidates) {
        const next = this.withNewController(current, newController, now, "ACQUIRED");
        changed.push(next.subject);
        outcomes.push(next.outcome);
        audits.push(this.audit(
          input.mutationId,
          "adopt",
          next.subject,
          actor,
          input.reason,
          original.lease.controller,
          next.subject.lease.controller,
          original.lease.state,
          next.subject.lease.state,
          next.outcome.code,
        ));
      }
      const result = this.adoptBatchResult(input.mutationId, true, outcomes);
      await this.persistReceipt(input.mutationId, "adopt", result, {
        subjects: changed,
        audits,
        ...(changed.length === 0
          ? {}
          : { liveness: [this.connectedObservation(newController, now, "atomic adopt call")] }),
      });
      return result;
    });
  }

  async observeControllerLiveness(input: {
    mutationId: string;
    actor: ControllerIdentity;
    controller: ControllerIdentity;
    state: "connected" | "disconnected";
    reason: string;
  }): Promise<OwnershipMutationResult> {
    return this.exclusive(async () => {
      this.assertReady();
      const replay = this.replayOwnership(input.mutationId, "liveness");
      if (replay !== undefined) return replay;
      const now = this.now();
      const entry: ControllerLiveness = {
        controller: ControllerIdentitySchema.parse(input.controller),
        state: input.state,
        observedAt: now,
        reason: input.reason,
      };
      const outcomes = [...this.subjects.values()]
        .filter((subject) => subject.lease.controller?.controllerId === input.controller.controllerId)
        .map((subject) => this.outcome(subject, isControlled(subject) ? "ALREADY_CONTROLLED" : "ORPHANED"));
      const result = this.result(input.mutationId, "liveness", outcomes);
      await this.commitWithReceipt(result, { liveness: [entry] });
      return result;
    });
  }

  async expireLeases(input: {
    mutationId: string;
    actor?: ControllerIdentity;
    reason: string;
  }): Promise<OwnershipMutationResult> {
    return this.exclusive(async () => {
      this.assertReady();
      const replay = this.replayOwnership(input.mutationId, "expire");
      if (replay !== undefined) return replay;
      const now = this.now();
      const actor = input.actor ?? BROKER_ACTOR;
      const changed: OwnershipSubject[] = [];
      const audits: OwnershipAuditRecord[] = [];
      const outcomes: OwnershipOutcome[] = [];
      for (const subject of this.subjects.values()) {
        if (!this.isExpired(subject, now)) continue;
        const priorController = subject.lease.controller;
        const expired: OwnershipSubject = {
          ...subject,
          lease: {
            ...subject.lease,
            state: "expired",
            tokenHash: undefined,
            reason: input.reason,
            contest: undefined,
          },
          updatedAt: now,
        };
        const orphaned: OwnershipSubject = {
          ...expired,
          lease: { ...expired.lease, state: "orphaned", orphanedAt: now },
        };
        changed.push(orphaned);
        outcomes.push(this.outcome(orphaned, "ORPHANED"));
        audits.push(
          this.audit(
            input.mutationId,
            "expire",
            expired,
            actor,
            input.reason,
            priorController,
            priorController,
            subject.lease.state,
            "expired",
            "LEASE_EXPIRED",
          ),
          this.audit(
            input.mutationId,
            "expire",
            orphaned,
            actor,
            input.reason,
            priorController,
            priorController,
            "expired",
            "orphaned",
            "ORPHANED",
          ),
        );
      }
      const result = this.result(input.mutationId, "expire", outcomes);
      await this.commitWithReceipt(result, { subjects: changed, audits });
      return result;
    });
  }

  async updateLifecycle(input: AuthenticatedLeaseInput & {
    subjectId: string;
    lifecycle: WorkerLifecycle;
  }): Promise<OwnershipMutationResult> {
    return this.authenticatedOwnershipMutation(
      "lifecycle",
      { ...input, selector: { scope: "single", subjectId: input.subjectId } },
      (subject, now) => {
        const updated = { ...subject, lifecycle: input.lifecycle, updatedAt: now };
        return { subject: updated, outcome: this.outcome(updated, "ALREADY_CONTROLLED") };
      },
    );
  }

  /**
   * Reconcile durable bookkeeping with broker-observed process state.
   *
   * This internal broker boundary repairs stale terminal bookkeeping for a process the registry
   * still owns and records terminal state only after the registry has observed exit.
   */
  async reconcileLifecycle(input: {
    mutationId: string;
    subjectId: string;
    lifecycle: WorkerLifecycle;
    reason: string;
  }): Promise<OwnershipSubject> {
    return this.exclusive(async () => {
      this.assertReady();
      const subject = this.requireSubject(input.subjectId);
      if (subject.lifecycle === input.lifecycle) return subject;
      const updated = OwnershipSubjectSchema.parse({
        ...subject,
        lifecycle: input.lifecycle,
        updatedAt: this.now(),
      });
      await this.commit({
        subjects: [updated],
        audits: [this.audit(
          input.mutationId,
          "lifecycle",
          updated,
          BROKER_ACTOR,
          input.reason,
          subject.lease.controller,
          subject.lease.controller,
          subject.lease.state,
          subject.lease.state,
          "RECONCILED",
        )],
      });
      return updated;
    });
  }

  async submitEvent(input: EventSubmissionInput): Promise<EventAck> {
    return this.exclusive(async () => {
      this.assertReady();
      const replay = this.replayAck(input.mutationId, "event-submit");
      if (replay !== undefined) return replay;
      let serialized: string;
      try {
        const encoded = JSON.stringify(input.event);
        if (encoded === undefined) throw new Error("payload is not JSON-serializable");
        serialized = encoded;
      } catch (error) {
        return this.rejectEvent(
          input.mutationId,
          eventIdOf(input.event),
          "INVALID_EVENT",
          error instanceof Error ? error.message : "payload is not JSON-serializable",
        );
      }
      const payloadBytes = Buffer.byteLength(serialized, "utf8");
      if (payloadBytes > WORKER_EVENT_LIMITS.payloadBytes) {
        return this.rejectEvent(
          input.mutationId,
          eventIdOf(input.event),
          "PAYLOAD_LIMIT_EXCEEDED",
          `event payload is ${payloadBytes} bytes; limit is ${WORKER_EVENT_LIMITS.payloadBytes} bytes`,
        );
      }
      const parsed = WorkerEventSchema.safeParse(input.event);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path.join(".") || "event";
        return this.rejectEvent(
          input.mutationId,
          eventIdOf(input.event),
          issue?.code === "too_big" ? "FIELD_LIMIT_EXCEEDED" : "INVALID_EVENT",
          `${field}: ${issue?.message ?? "invalid event"}`,
        );
      }
      const event = parsed.data;
      const prior = this.events.get(event.eventId);
      if (prior !== undefined) {
        const same = prior.submissionHash === hashEvent(event);
        return this.recordAck(input.mutationId, "event-submit", {
          code: same ? "duplicate" : "rejected",
          eventId: event.eventId,
          sequence: event.sequence,
          ...(!same
            ? { errorCode: "EVENT_ID_COLLISION", message: "eventId already names different payload" }
            : {}),
        });
      }
      const subject = this.subjects.get(event.workerId);
      if (subject === undefined) {
        return this.rejectEvent(input.mutationId, event.eventId, "SUBJECT_NOT_FOUND", "worker not registered");
      }
      if (
        event.taskId !== subject.origin.taskId
        || event.waveId !== subject.origin.waveId
      ) {
        return this.rejectEvent(
          input.mutationId,
          event.eventId,
          "TASK_IDENTITY_MISMATCH",
          "event task/wave identity does not match immutable worker origin",
        );
      }
      const now = this.now();
      const currentSubject = this.expiredCopy(subject, now);
      const auth = this.authCode(
        currentSubject,
        input.controller,
        input.leaseToken,
        event.controllerLeaseVersion,
        now,
      );
      if (auth !== undefined) {
        return this.rejectEvent(
          input.mutationId,
          event.eventId,
          auth,
          authMessage(auth, currentSubject),
          undefined,
          undefined,
          currentSubject === subject ? {} : { subjects: [currentSubject] },
        );
      }
      if (this.rateCount(event.workerId, now) >= this.eventRateLimit) {
        return this.rejectEvent(
          input.mutationId,
          event.eventId,
          "RATE_LIMITED",
          `worker event rate exceeds ${this.eventRateLimit} per ${this.eventRateWindowMs}ms`,
        );
      }

      const workerEvents = [...this.events.values()].filter((entry) => entry.workerId === event.workerId);
      const lastSequence = workerEvents.reduce((highest, entry) => Math.max(highest, entry.sequence), 0);
      const expected = lastSequence + 1;
      if (event.sequence < expected) {
        if (event.kind === "PROGRESS") {
          return this.recordAck(input.mutationId, "event-submit", {
            code: "superseded",
            eventId: event.eventId,
            sequence: event.sequence,
            expectedSequence: expected,
            message: "older progress sequence already superseded",
          });
        }
        return this.rejectEvent(
          input.mutationId,
          event.eventId,
          "SEQUENCE_OUT_OF_ORDER",
          `sequence ${event.sequence} is behind expected ${expected}`,
          event.sequence,
          expected,
        );
      }

      const changedEvents: StoredWorkerEvent[] = [];
      const supersededIds: string[] = [];
      let materialEvent = event;
      if (event.kind === "PROGRESS") {
        const previous = workerEvents
          .filter((entry) => entry.kind === "PROGRESS" && entry.state === "active")
          .sort((left, right) => right.sequence - left.sequence)[0];
        if (previous !== undefined) {
          materialEvent = mergeProgress(previous, event);
          changedEvents.push({
            ...previous,
            ordinal: this.ordinal(),
            state: "superseded",
            supersededBy: event.eventId,
            resolvedAt: now,
          });
          supersededIds.push(previous.eventId);
        }
      }

      const active = workerEvents.filter((entry) => entry.state === "active");
      const growth = event.kind === "PROGRESS" && supersededIds.length > 0 ? 0 : 1;
      if (active.length + growth > this.maxQueuedEventsPerWorker) {
        const evictable = active
          .filter((entry) => !isPinned(entry))
          .sort((left, right) => left.ordinal - right.ordinal)[0];
        if (evictable === undefined) {
          return this.rejectEvent(
            input.mutationId,
            event.eventId,
            "QUEUE_LIMIT_EXCEEDED",
            `worker queue limit ${this.maxQueuedEventsPerWorker} reached by pinned events`,
          );
        }
        changedEvents.push({
          ...evictable,
          ordinal: this.ordinal(),
          state: "closed",
          resolvedAt: now,
          resolvedBy: BROKER_ACTOR,
        });
      }

      const stored: StoredWorkerEvent = {
        ...materialEvent,
        ordinal: this.ordinal(),
        receivedAt: now,
        submissionHash: hashEvent(event),
        state: "active",
      };
      changedEvents.push(stored);
      const checkpoints: CheckpointRequest[] = [];
      let subjectUpdate = this.renewed(currentSubject, now);
      if (event.checkpointCorrelationId !== undefined) {
        const checkpoint = this.checkpoints.get(event.checkpointCorrelationId);
        if (
          event.kind !== "CHECKPOINT"
          || checkpoint === undefined
          || checkpoint.workerId !== event.workerId
          || checkpoint.state !== "pending"
        ) {
          return this.rejectEvent(
            input.mutationId,
            event.eventId,
            "CHECKPOINT_CORRELATION_INVALID",
            `no pending checkpoint ${event.checkpointCorrelationId} for worker`,
          );
        }
        checkpoints.push({
          ...checkpoint,
          state: "answered",
          answeredByEventId: event.eventId,
          answeredAt: now,
        });
        if (
          checkpoint.mode === "decision-gate"
          && subjectUpdate.decisionGate.state === "decision-gate"
          && subjectUpdate.decisionGate.correlationId === checkpoint.correlationId
        ) {
          subjectUpdate = {
            ...subjectUpdate,
            decisionGate: { state: "none" },
          };
        }
      }

      const ack: EventAck = {
        code: "accepted",
        eventId: event.eventId,
        sequence: event.sequence,
        ...(event.sequence > expected
          ? { expectedSequence: expected, sequenceGap: { expected, received: event.sequence } }
          : {}),
        ...(supersededIds.length === 0 ? {} : { supersededEventIds: supersededIds }),
      };
      await this.commitAck(input.mutationId, "event-submit", ack, {
        subjects: [subjectUpdate],
        events: changedEvents,
        checkpoints,
        liveness: [this.connectedObservation(input.controller, now, "authenticated event submission")],
      });
      return ack;
    });
  }

  async resolveEvent(input: EventResolutionInput): Promise<EventAck> {
    return this.exclusive(async () => {
      this.assertReady();
      const replay = this.replayAck(input.mutationId, "event-resolve");
      if (replay !== undefined) return replay;
      const event = this.events.get(input.eventId);
      if (event === undefined) {
        throw new WorkerCoordinationError("EVENT_NOT_FOUND", `Event ${input.eventId} not found`);
      }
      const subject = this.requireSubject(event.workerId);
      const now = this.now();
      const currentSubject = this.expiredCopy(subject, now);
      const auth = this.authCode(
        currentSubject,
        input.controller,
        input.leaseToken,
        currentSubject.lease.version,
        now,
      );
      if (auth !== undefined) {
        return this.rejectEvent(
          input.mutationId,
          input.eventId,
          auth,
          authMessage(auth, currentSubject),
          undefined,
          undefined,
          currentSubject === subject ? {} : { subjects: [currentSubject] },
          "event-resolve",
        );
      }
      const updated: StoredWorkerEvent = {
        ...event,
        ordinal: this.ordinal(),
        state: input.resolution,
        resolvedAt: now,
        resolvedBy: input.controller,
      };
      const renewed = this.renewed(currentSubject, now);
      const ack: EventAck = {
        code: "accepted",
        eventId: event.eventId,
        sequence: event.sequence,
      };
      await this.commitAck(input.mutationId, "event-resolve", ack, {
        subjects: [renewed],
        events: [updated],
        liveness: [this.connectedObservation(input.controller, now, "authenticated event resolution")],
        audits: [this.audit(
          input.mutationId,
          "event-resolve",
          subject,
          input.controller,
          input.reason,
          subject.lease.controller,
          subject.lease.controller,
          subject.lease.state,
          renewed.lease.state,
          input.resolution,
        )],
      });
      return ack;
    });
  }

  projectEvents(input: {
    cursor?: number;
    limit?: number;
    filter?: EventProjectionFilter;
  } = {}): EventProjection {
    this.assertReady();
    const cursor = input.cursor ?? 0;
    const limit = Math.min(Math.max(input.limit ?? this.maxProjectionPageSize, 1), this.maxProjectionPageSize);
    const filter = input.filter;
    const candidates = [...this.events.values()]
      .filter((event) => event.ordinal > cursor)
      .sort((left, right) => left.ordinal - right.ordinal);
    const matches = candidates
      .filter((event) => filter?.workerIds === undefined || filter.workerIds.includes(event.workerId))
      .filter((event) => filter?.taskId === undefined || event.taskId === filter.taskId)
      .filter((event) => filter?.waveId === undefined || event.waveId === filter.waveId)
      .filter((event) => filter?.severities === undefined || filter.severities.includes(event.severity))
      .filter((event) => filter?.kinds === undefined || filter.kinds.includes(event.kind))
      .filter((event) => {
        if (filter?.intervention === "any") return true;
        const unresolved = isPinned(event) && event.state === "active";
        if (filter?.intervention === "resolved") return isPinned(event) && !unresolved;
        if (filter?.intervention === "unresolved") return unresolved;
        return event.state === "active";
      });
    const page = matches.slice(0, limit);
    const hasMore = matches.length > page.length;
    return {
      events: page,
      nextCursor: hasMore
        ? page.at(-1)!.ordinal
        : candidates.at(-1)?.ordinal ?? cursor,
      hasMore,
    };
  }

  async requestCheckpoint(input: CheckpointRequestInput): Promise<CheckpointRequest> {
    return this.exclusive(async () => {
      this.assertReady();
      const receipt = this.receipts.get(input.mutationId);
      if (receipt !== undefined) {
        this.assertReceiptOperation(receipt, "checkpoint-request");
        return CheckpointRequestSchema.parse(receipt.result);
      }
      const subject = this.requireSubject(input.workerId);
      const now = this.now();
      const currentSubject = this.expiredCopy(subject, now);
      const auth = this.authCode(
        currentSubject,
        input.controller,
        input.leaseToken,
        currentSubject.lease.version,
        now,
      );
      if (auth !== undefined) {
        if (currentSubject !== subject) await this.commit({ subjects: [currentSubject] });
        throw new WorkerCoordinationError(
          auth === "LEASE_TOKEN_INVALID"
            ? "LEASE_TOKEN_INVALID"
            : auth === "LEASE_EXPIRED"
              ? "LEASE_EXPIRED"
              : "OWNERSHIP_LOST",
          authMessage(auth, currentSubject),
        );
      }
      const prior = this.checkpoints.get(input.correlationId);
      if (prior !== undefined) {
        await this.persistReceipt(input.mutationId, "checkpoint-request", prior, {
          subjects: [this.renewed(currentSubject, now)],
          liveness: [this.connectedObservation(input.controller, now, "idempotent checkpoint request")],
        });
        return prior;
      }
      const mode = input.mode ?? "non-blocking";
      const checkpoint = CheckpointRequestSchema.parse({
        schemaVersion: WORKER_COORDINATION_SCHEMA_VERSION,
        correlationId: input.correlationId,
        workerId: input.workerId,
        controllerLeaseVersion: subject.lease.version,
        requestedBy: input.controller,
        ...(input.focus === undefined ? {} : { focus: input.focus }),
        ...(input.question === undefined ? {} : { question: input.question }),
        mode,
        state: "pending",
        requestedAt: now,
      });
      const renewed = this.renewed(currentSubject, now);
      const subjectUpdate: OwnershipSubject = mode === "decision-gate"
        ? {
            ...renewed,
            decisionGate: {
              state: "decision-gate",
              correlationId: input.correlationId,
              pausedAt: now,
            },
          }
        : renewed;
      await this.persistReceipt(input.mutationId, "checkpoint-request", checkpoint, {
        subjects: [subjectUpdate],
        checkpoints: [checkpoint],
        liveness: [this.connectedObservation(input.controller, now, "authenticated checkpoint request")],
        audits: [this.audit(
          input.mutationId,
          "checkpoint-request",
          subject,
          input.controller,
          mode,
          subject.lease.controller,
          subject.lease.controller,
          subject.lease.state,
          subjectUpdate.lease.state,
          "REQUESTED",
        )],
      });
      return checkpoint;
    });
  }

  private async ownershipMutation(
    operation: "acquire" | "adopt",
    input: AcquireInput | AdoptInput,
    mutate: (
      subject: OwnershipSubject,
      now: string,
    ) => { subject: OwnershipSubject; outcome: OwnershipOutcome },
  ): Promise<OwnershipMutationResult> {
    return this.exclusive(async () => {
      this.assertReady();
      const replay = this.replayOwnership(input.mutationId, operation);
      if (replay !== undefined) return replay;
      const selector = OwnershipSelectorSchema.parse(input.selector);
      const now = this.now();
      const selected = this.select(selector, now);
      const changed: OwnershipSubject[] = [];
      const outcomes: OwnershipOutcome[] = [];
      const audits: OwnershipAuditRecord[] = [];
      for (const original of selected) {
        const prior = this.expiredCopy(original, now);
        const next = mutate(prior, now);
        changed.push(next.subject);
        outcomes.push(next.outcome);
        audits.push(this.audit(
          input.mutationId,
          operation,
          next.subject,
          input.actor,
          input.reason,
          original.lease.controller,
          next.subject.lease.controller,
          original.lease.state,
          next.subject.lease.state,
          next.outcome.code,
        ));
      }
      const result = this.result(input.mutationId, operation, outcomes);
      const successfulController = operation === "acquire"
        ? (input as AcquireInput).controller
        : (input as AdoptInput).newController;
      const acquired = outcomes.some(
        (outcome) => outcome.code === "ACQUIRED" || outcome.code === "ALREADY_CONTROLLED",
      );
      await this.commitWithReceipt(result, {
        subjects: changed,
        audits,
        ...(acquired
          ? { liveness: [this.connectedObservation(successfulController, now, `${operation} call`)] }
          : {}),
      });
      return result;
    });
  }

  private async authenticatedOwnershipMutation(
    operation: "renew" | "release" | "transfer" | "lifecycle",
    input: AuthenticatedLeaseInput,
    mutate: (
      subject: OwnershipSubject,
      now: string,
    ) => { subject: OwnershipSubject; outcome: OwnershipOutcome },
  ): Promise<OwnershipMutationResult> {
    return this.exclusive(async () => {
      this.assertReady();
      const replay = this.replayOwnership(input.mutationId, operation);
      if (replay !== undefined) return replay;
      const now = this.now();
      const selected = this.select(OwnershipSelectorSchema.parse(input.selector), now);
      const changed: OwnershipSubject[] = [];
      const outcomes: OwnershipOutcome[] = [];
      const audits: OwnershipAuditRecord[] = [];
      for (const original of selected) {
        const subject = this.expiredCopy(original, now);
        const auth = this.authCode(
          subject,
          input.controller,
          this.tokenFor(input, subject.subjectId),
          input.leaseVersion,
          now,
        );
        if (auth !== undefined) {
          const outcome = this.outcome(
            subject,
            auth === "OWNERSHIP_LOST" || auth === "LEASE_TOKEN_INVALID"
              ? "OWNERSHIP_LOST"
              : "ORPHANED",
            authMessage(auth, subject),
          );
          changed.push(subject);
          outcomes.push(outcome);
          audits.push(this.audit(
            input.mutationId,
            operation,
            subject,
            input.actor,
            input.reason,
            original.lease.controller,
            subject.lease.controller,
            original.lease.state,
            subject.lease.state,
            outcome.code,
          ));
          continue;
        }
        const next = mutate(subject, now);
        changed.push(next.subject);
        outcomes.push(next.outcome);
        audits.push(this.audit(
          input.mutationId,
          operation,
          next.subject,
          input.actor,
          input.reason,
          original.lease.controller,
          next.subject.lease.controller,
          original.lease.state,
          next.subject.lease.state,
          next.outcome.code,
        ));
      }
      const result = this.result(input.mutationId, operation, outcomes);
      const authenticated = outcomes.some(
        (outcome) => outcome.code !== "OWNERSHIP_LOST" && outcome.code !== "ORPHANED",
      );
      await this.commitWithReceipt(result, {
        subjects: changed,
        audits,
        ...(authenticated
          ? { liveness: [this.connectedObservation(input.controller, now, `${operation} call`)] }
          : {}),
      });
      return result;
    });
  }

  private select(selector: OwnershipSelector, now: string): OwnershipSubject[] {
    const all = [...this.subjects.values()];
    if (selector.scope === "single") {
      return [this.requireSubject(selector.subjectId)];
    }
    if (selector.scope === "group") {
      return all.filter(
        (subject) =>
          (selector.taskId === undefined || subject.origin.taskId === selector.taskId)
          && (selector.waveId === undefined || subject.origin.waveId === selector.waveId),
      );
    }
    const observed = this.liveness.get(selector.controllerId);
    const disconnectedPastGrace = observed?.state === "disconnected"
      && Date.parse(now) >= Date.parse(observed.observedAt) + this.gracePeriodMs;
    return all.filter((subject) => {
      if (subject.lease.controller?.controllerId !== selector.controllerId) return false;
      if (disconnectedPastGrace) return true;
      return (subject.lease.state === "orphaned" || subject.lease.state === "expired")
        && Date.parse(now) >= Date.parse(subject.lease.expiresAt);
    });
  }

  private expiredCopy(subject: OwnershipSubject, now: string): OwnershipSubject {
    if (!this.isExpired(subject, now)) return subject;
    return {
      ...subject,
      lease: {
        ...subject.lease,
        state: "orphaned",
        tokenHash: undefined,
        orphanedAt: now,
        reason: "lease expired after broker-observed liveness/heartbeat deadline",
        contest: undefined,
      },
      updatedAt: now,
    };
  }

  private isExpired(subject: OwnershipSubject, now: string): boolean {
    if (!isControlled(subject)) return false;
    if (Date.parse(now) >= Date.parse(subject.lease.expiresAt)) return true;
    const observed = subject.lease.controller === undefined
      ? undefined
      : this.liveness.get(subject.lease.controller.controllerId);
    return observed?.state === "disconnected"
      && Date.parse(now) >= Date.parse(observed.observedAt) + this.gracePeriodMs;
  }

  private authCode(
    subject: OwnershipSubject,
    controller: ControllerIdentity,
    token: string,
    leaseVersion: number | undefined,
    now: string,
  ): "OWNERSHIP_LOST" | "LEASE_TOKEN_INVALID" | "LEASE_EXPIRED" | undefined {
    if (this.isExpired(subject, now) || subject.lease.state === "orphaned") return "LEASE_EXPIRED";
    if (
      !isControlled(subject)
      || subject.lease.controller?.controllerId !== controller.controllerId
      || (leaseVersion !== undefined && subject.lease.version !== leaseVersion)
    ) {
      return "OWNERSHIP_LOST";
    }
    if (subject.lease.tokenHash === undefined || subject.lease.tokenHash !== hashToken(token)) {
      return "LEASE_TOKEN_INVALID";
    }
    return undefined;
  }

  private tokenFor(input: AuthenticatedLeaseInput, subjectId: string): string {
    return input.leaseTokens?.[subjectId] ?? input.leaseToken ?? "";
  }

  private renewed(subject: OwnershipSubject, now: string): OwnershipSubject {
    return {
      ...subject,
      lease: {
        ...subject.lease,
        state: "active",
        renewedAt: now,
        expiresAt: this.after(now, this.leaseDurationMs),
        contest: undefined,
      },
      updatedAt: now,
    };
  }

  private withNewController(
    subject: OwnershipSubject,
    controller: ControllerIdentity,
    now: string,
    code: "ACQUIRED" | "ALREADY_CONTROLLED" | "TRANSFERRED",
  ): { subject: OwnershipSubject; outcome: OwnershipOutcome } {
    const token = this.issueToken();
    const updated: OwnershipSubject = {
      ...subject,
      lease: {
        leaseId: subject.lease.leaseId,
        version: subject.lease.version + 1,
        state: "active",
        controller: ControllerIdentitySchema.parse(controller),
        tokenHash: hashToken(token),
        issuedAt: now,
        renewedAt: now,
        expiresAt: this.after(now, this.leaseDurationMs),
      },
      updatedAt: now,
    };
    return {
      subject: updated,
      outcome: {
        ...this.outcome(updated, code),
        leaseToken: token,
      },
    };
  }

  private contested(
    subject: OwnershipSubject,
    actor: ControllerIdentity,
    reason: string,
    now: string,
  ): { subject: OwnershipSubject; outcome: OwnershipOutcome } {
    const contested: OwnershipSubject = {
      ...subject,
      lease: {
        ...subject.lease,
        state: "contested",
        contest: { actor, contestedAt: now, reason },
      },
      updatedAt: now,
    };
    return {
      subject: contested,
      outcome: this.outcome(
        contested,
        "LEASE_CONFLICT",
        `controlled by ${contested.lease.controller?.controllerId ?? "unknown"} until ${contested.lease.expiresAt}`,
      ),
    };
  }

  private outcome(
    subject: OwnershipSubject,
    code: OwnershipOutcome["code"],
    message?: string,
  ): OwnershipOutcome {
    return {
      subjectId: subject.subjectId,
      code,
      leaseVersion: subject.lease.version,
      ...(subject.lease.controller === undefined
        ? {}
        : { currentController: subject.lease.controller }),
      leaseExpiresAt: subject.lease.expiresAt,
      ...(message === undefined ? {} : { message }),
    };
  }

  private result(
    mutationId: string,
    operation: OwnershipOperation,
    outcomes: OwnershipOutcome[],
  ): OwnershipMutationResult {
    return OwnershipMutationResultSchema.parse({
      mutationId,
      operation,
      idempotentReplay: false,
      outcomes,
    });
  }

  private adoptBatchResult(
    mutationId: string,
    committed: boolean,
    outcomes: OwnershipOutcome[],
  ): AdoptBatchResult {
    return {
      ...this.result(mutationId, "adopt", outcomes),
      committed,
    };
  }

  private audit(
    mutationId: string,
    operation: OwnershipOperation,
    subject: OwnershipSubject,
    actor: ControllerIdentity,
    reason: string,
    priorController: ControllerIdentity | undefined,
    newController: ControllerIdentity | undefined,
    priorLeaseState: OwnershipSubject["lease"]["state"] | undefined,
    newLeaseState: OwnershipSubject["lease"]["state"] | undefined,
    outcome: string,
  ): OwnershipAuditRecord {
    return {
      auditId: this.id(),
      mutationId,
      operation,
      subjectId: subject.subjectId,
      actor: ControllerIdentitySchema.parse(actor),
      occurredAt: this.now(),
      ...(priorController === undefined ? {} : { priorController }),
      ...(newController === undefined ? {} : { newController }),
      ...(priorLeaseState === undefined ? {} : { priorLeaseState }),
      ...(newLeaseState === undefined ? {} : { newLeaseState }),
      reason,
      outcome,
    };
  }

  private connectedObservation(
    controller: ControllerIdentity,
    observedAt: string,
    reason: string,
  ): ControllerLiveness {
    return {
      controller,
      state: "connected",
      observedAt,
      reason,
    };
  }

  private async commitWithReceipt(
    result: OwnershipMutationResult,
    transaction: CoordinationTransaction,
  ): Promise<void> {
    await this.persistReceipt(result.mutationId, result.operation, result, transaction);
  }

  private async commitAck(
    mutationId: string,
    operation: "event-submit" | "event-resolve",
    ack: EventAck,
    transaction: CoordinationTransaction,
  ): Promise<void> {
    await this.persistReceipt(mutationId, operation, ack, transaction);
  }

  private async persistReceipt(
    mutationId: string,
    operation: OwnershipOperation,
    result: unknown,
    transaction: CoordinationTransaction,
  ): Promise<void> {
    const receipt: MutationReceipt = {
      mutationId,
      operation,
      recordedAt: this.now(),
      result,
    };
    await this.commit({ ...transaction, receipts: [...(transaction.receipts ?? []), receipt] });
  }

  private async commit(transaction: CoordinationTransaction): Promise<void> {
    await this.options.store.append(transaction);
    for (const subject of transaction.subjects ?? []) this.subjects.set(subject.subjectId, subject);
    for (const event of transaction.events ?? []) this.events.set(event.eventId, event);
    for (const checkpoint of transaction.checkpoints ?? []) {
      this.checkpoints.set(checkpoint.correlationId, checkpoint);
    }
    for (const audit of transaction.audits ?? []) this.audits.push(audit);
    for (const entry of transaction.liveness ?? []) {
      this.liveness.set(entry.controller.controllerId, entry);
    }
    for (const receipt of transaction.receipts ?? []) this.receipts.set(receipt.mutationId, receipt);
  }

  private async rejectEvent(
    mutationId: string,
    eventId: string,
    errorCode: string,
    message: string,
    sequence?: number,
    expectedSequence?: number,
    transaction: CoordinationTransaction = {},
    operation: "event-submit" | "event-resolve" = "event-submit",
  ): Promise<EventAck> {
    return this.recordAck(mutationId, operation, {
      code: "rejected",
      eventId,
      ...(sequence === undefined ? {} : { sequence }),
      ...(expectedSequence === undefined ? {} : { expectedSequence }),
      errorCode,
      message,
    }, transaction);
  }

  private async recordAck(
    mutationId: string,
    operation: "event-submit" | "event-resolve",
    ack: EventAck,
    transaction: CoordinationTransaction = {},
  ): Promise<EventAck> {
    await this.persistReceipt(mutationId, operation, ack, transaction);
    return EventAckSchema.parse(ack);
  }

  private replayOwnership(
    mutationId: string,
    operation: OwnershipOperation,
  ): OwnershipMutationResult | undefined {
    const receipt = this.receipts.get(mutationId);
    if (receipt === undefined) return undefined;
    this.assertReceiptOperation(receipt, operation);
    const prior = OwnershipMutationResultSchema.parse(receipt.result);
    return { ...prior, idempotentReplay: true };
  }

  private replayAdoptBatch(mutationId: string): AdoptBatchResult | undefined {
    const receipt = this.receipts.get(mutationId);
    if (receipt === undefined) return undefined;
    this.assertReceiptOperation(receipt, "adopt");
    if (
      typeof receipt.result !== "object"
      || receipt.result === null
      || !("committed" in receipt.result)
      || typeof receipt.result.committed !== "boolean"
    ) {
      throw new WorkerCoordinationError(
        "MUTATION_ID_COLLISION",
        `mutation ${mutationId} already used for non-batch adopt`,
      );
    }
    return {
      ...OwnershipMutationResultSchema.parse(receipt.result),
      committed: receipt.result.committed,
      idempotentReplay: true,
    };
  }

  private replayAck(mutationId: string, operation: "event-submit" | "event-resolve"): EventAck | undefined {
    const receipt = this.receipts.get(mutationId);
    if (receipt === undefined) return undefined;
    this.assertReceiptOperation(receipt, operation);
    return EventAckSchema.parse(receipt.result);
  }

  private assertReceiptOperation(receipt: MutationReceipt, operation: OwnershipOperation): void {
    if (receipt.operation !== operation) {
      throw new WorkerCoordinationError(
        "MUTATION_ID_COLLISION",
        `mutation ${receipt.mutationId} already used for ${receipt.operation}`,
      );
    }
  }

  private requireSubject(subjectId: string): OwnershipSubject {
    const subject = this.subjects.get(subjectId);
    if (subject === undefined) {
      throw new WorkerCoordinationError("SUBJECT_NOT_FOUND", `Subject ${subjectId} not found`);
    }
    return subject;
  }

  private rateCount(workerId: string, now: string): number {
    const floor = Date.parse(now) - this.eventRateWindowMs;
    return [...this.events.values()].filter(
      (event) => event.workerId === workerId && Date.parse(event.receivedAt) > floor,
    ).length;
  }

  private ordinal(): number {
    const value = this.nextOrdinal;
    this.nextOrdinal += 1;
    return value;
  }

  private id(): string {
    return this.options.idFactory?.() ?? randomUUID();
  }

  private issueToken(): string {
    return this.options.tokenFactory?.() ?? randomBytes(32).toString("base64url");
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private after(timestamp: string, durationMs: number): string {
    return new Date(Date.parse(timestamp) + durationMs).toISOString();
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error("Worker coordination service is not initialized");
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashEvent(event: WorkerEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function isControlled(subject: OwnershipSubject): boolean {
  return (subject.lease.state === "active" || subject.lease.state === "contested")
    && subject.lease.controller !== undefined;
}

function isPinned(event: StoredWorkerEvent): boolean {
  return event.kind === "EXCEPTION"
    || event.kind === "DECISION_REQUEST"
    || event.interventionRequired;
}

function eventIdOf(value: unknown): string {
  if (
    typeof value === "object"
    && value !== null
    && "eventId" in value
    && typeof (value as { eventId?: unknown }).eventId === "string"
  ) {
    return (value as { eventId: string }).eventId.slice(0, 256) || "invalid-event";
  }
  return "invalid-event";
}

function authMessage(code: string, subject: OwnershipSubject): string {
  if (code === "LEASE_EXPIRED") {
    return `lease expired; worker ${subject.subjectId} is orphaned and adoptable`;
  }
  if (code === "LEASE_TOKEN_INVALID") return "lease token does not authenticate current controller";
  return `ownership lost to ${subject.lease.controller?.controllerId ?? "no controller"}; lease version ${subject.lease.version}`;
}

function mergeProgress(previous: StoredWorkerEvent, next: WorkerEvent): WorkerEvent {
  const evidenceRefs = [...new Set([...previous.evidenceRefs, ...next.evidenceRefs])]
    .slice(-WORKER_EVENT_LIMITS.evidenceRefs);
  const changedAssumptions = [
    ...new Set([...previous.changedAssumptions, ...next.changedAssumptions]),
  ].slice(-WORKER_EVENT_LIMITS.changedAssumptions);
  const structuredFacts = Object.fromEntries(
    Object.entries({
      ...(previous.structuredFacts ?? {}),
      ...(next.structuredFacts ?? {}),
    }).slice(-WORKER_EVENT_LIMITS.facts),
  );
  return WorkerEventSchema.parse({
    ...next,
    evidenceRefs,
    changedAssumptions,
    structuredFacts,
  });
}
