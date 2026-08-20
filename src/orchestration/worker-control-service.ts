import { randomUUID } from "node:crypto";
import { z } from "zod";
import { grantAllows, type CapabilityGrant, type CyberdeckCapability } from "../domain/capability.js";
import { orchestratorController, type OrchestratorBinding } from "../domain/orchestrator.js";
import type { SessionRecord } from "../domain/session.js";
import {
  TERMINAL_WORKER_LIFECYCLES,
  WorkerEventKindSchema,
  WorkerEventSeveritySchema,
  type ControllerIdentity,
  type OwnershipOutcome,
  type OwnershipSubject,
  type StoredWorkerEvent,
} from "../domain/worker-coordination.js";
import {
  handoffBriefing,
  type HandoffManifestEntry,
} from "../domain/worker-handoff.js";
import type { WorkerTruth } from "../domain/worker-truth.js";
import type { WorkerCoordinationService } from "../broker/worker-coordination.js";
import {
  BrokerWorkerLeaseCredentialCustodian,
  type WorkerLeaseCredentialCustodian,
} from "../broker/worker-lease-credential-custodian.js";
import type { InstructionQueue } from "./instruction-queue.js";
import type { OrchestratorStore } from "../persistence/orchestrator-store.js";
import type {
  SessionLookupPort,
  SessionProcessControlPort,
  SessionUpdatePort,
  WorkerTruthQueryPort,
} from "./session/session-ports.js";

/**
 * Orchestrator-facing control plane over the MIK-55 Wave 1 lease/event substrate.
 *
 * Two rules shape everything here. Lease tokens never leave the broker: an Orc proves authority with
 * its durable orchestrator binding, and the token custody map below translates that into the
 * substrate's fenced token. And substrate outcome codes are returned verbatim, because an Orc that
 * cannot tell LEASE_CONFLICT from NOT_ELIGIBLE cannot choose a recovery action.
 */

export const LeaseActionSchema = z.enum(["acquire", "renew", "release", "transfer", "adopt"]);
export const LeaseScopeSchema = z.enum(["worker", "wave", "all-eligible"]);
export const WorkerControlActionSchema = z.enum(["stop", "redirect", "request_checkpoint"]);
export const WorkerEventViewSchema = z.enum(["active", "unresolved", "resolved", "all"]);

const ReasonSchema = z.string().trim().min(1).max(500);

export const AgentLeaseParamsSchema = z.object({
  actorSessionId: z.uuid(),
  action: LeaseActionSchema,
  scope: LeaseScopeSchema,
  workerId: z.uuid().optional(),
  waveId: z.string().min(1).max(256).optional(),
  newControllerSessionId: z.uuid().optional(),
  reason: ReasonSchema,
  mutationId: z.string().min(1).max(200).optional(),
  preview: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.scope === "worker" && value.workerId === undefined) {
    context.addIssue({ code: "custom", message: "scope worker requires workerId", path: ["workerId"] });
  }
  if (value.scope === "wave" && value.waveId === undefined) {
    context.addIssue({ code: "custom", message: "scope wave requires waveId", path: ["waveId"] });
  }
  if (value.action === "transfer" && value.newControllerSessionId === undefined) {
    context.addIssue({
      code: "custom",
      message: "transfer requires newControllerSessionId",
      path: ["newControllerSessionId"],
    });
  }
  if (value.preview && value.action !== "adopt" && value.action !== "acquire") {
    context.addIssue({
      code: "custom",
      message: "preview is only defined for acquire and adopt",
      path: ["preview"],
    });
  }
});

export const AgentWorkerControlParamsSchema = z.object({
  actorSessionId: z.uuid(),
  action: WorkerControlActionSchema,
  workerId: z.uuid(),
  reason: ReasonSchema,
  mode: z.enum(["graceful", "force"]).default("graceful"),
  instruction: z.string().trim().min(1).max(16_384).optional(),
  messageId: z.uuid().optional(),
  correlationId: z.string().min(1).max(256).optional(),
  focus: z.string().trim().min(1).max(1_024).optional(),
  question: z.string().trim().min(1).max(1_024).optional(),
  decisionGate: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.action === "redirect" && value.instruction === undefined) {
    context.addIssue({ code: "custom", message: "redirect requires instruction", path: ["instruction"] });
  }
  if (value.action === "request_checkpoint" && value.correlationId === undefined) {
    context.addIssue({
      code: "custom",
      message: "request_checkpoint requires correlationId",
      path: ["correlationId"],
    });
  }
});

/** Hard page cap. An Orc reading events must never be able to ask for a transcript-sized page. */
export const MAX_EVENT_PAGE = 50;
/** Handoffs duplicate a bounded manifest plus briefing, so one delivery per poll is the safe cap. */
export const MAX_HANDOFF_PAGE = 1;

export const AgentWorkerEventsParamsSchema = z.object({
  actorSessionId: z.uuid(),
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(MAX_EVENT_PAGE).default(20),
  workerId: z.uuid().optional(),
  waveId: z.string().min(1).max(256).optional(),
  kinds: z.array(WorkerEventKindSchema).min(1).max(5).optional(),
  severities: z.array(WorkerEventSeveritySchema).min(1).max(4).optional(),
  view: WorkerEventViewSchema.default("active"),
  acknowledgeHandoffIds: z.array(z.uuid()).min(1).max(MAX_HANDOFF_PAGE).optional(),
});

/** Trim caps. These exist so an Orc's context cost per read stays predictable, not to hide data. */
const SUMMARY_CHARS = 320;
const RECOMMENDATION_CHARS = 240;
const FIELD_CHARS = 160;
const MAX_FACTS = 8;
const MAX_LIST_FIELDS = 3;
const MAX_STATE_ENTRIES = 25;

export type LeaseResultCode = OwnershipOutcome["code"];

export interface LeaseSubjectResult {
  workerId: string;
  code: LeaseResultCode;
  leaseVersion?: number;
  leaseExpiresAt?: string;
  currentController?: string;
  currentControllerScope?: ControllerIdentity["scope"];
  message?: string;
}

export interface RecoveryCandidate {
  workerId: string;
  taskId: string;
  waveId?: string;
  lifecycle: OwnershipSubject["lifecycle"];
  leaseState: OwnershipSubject["lease"]["state"];
  priorController?: string;
  leaseExpiresAt: string;
  via: "adopt" | "acquire";
  decisionGate: boolean;
  unresolvedEvents: number;
  pendingCheckpoints: number;
  sessionKnownToBroker: boolean;
  executionState?: SessionRecord["executionState"];
}

export interface RecoveryBlocker {
  workerId: string;
  code: "LEASE_CONFLICT" | "WORKER_TERMINAL" | "ALREADY_CONTROLLED" | "CONTESTED" | "SUBJECT_UNKNOWN_TO_BROKER";
  detail: string;
  currentController?: string;
  leaseExpiresAt?: string;
}

export interface RecoveryPlan {
  eligible: RecoveryCandidate[];
  blocked: RecoveryBlocker[];
}

export interface LeaseControlResult {
  action: z.infer<typeof LeaseActionSchema>;
  scope: z.infer<typeof LeaseScopeSchema>;
  mutationId: string;
  controllerId: string;
  idempotentReplay: boolean;
  results: LeaseSubjectResult[];
  summary: Record<string, number>;
  plan?: RecoveryPlan;
  /** Present when substrate eligibility rejected the whole batch before ownership changed. */
  aborted?: { code: "ADOPTION_ABORTED"; cause: LeaseSubjectResult[] };
}

export type WorkerControlCode =
  | "STOPPED"
  | "STOP_REQUESTED"
  | "ALREADY_TERMINAL"
  | "APPROVAL_REQUIRED"
  /** Bytes are in the provider input surface. Not a claim that the provider consumed them. */
  | "RENDERED"
  | "QUEUED"
  | "CHECKPOINT_REQUESTED"
  | "CHECKPOINT_REPLAY"
  | "WORKER_TERMINAL"
  | "NOT_CONTROLLER"
  | "OWNERSHIP_LOST"
  | "LEASE_EXPIRED"
  | "LEASE_CONFLICT"
  | "SUBJECT_NOT_FOUND"
  | "DENIED";

export interface WorkerControlResult {
  action: z.infer<typeof WorkerControlActionSchema>;
  workerId: string;
  code: WorkerControlCode;
  detail?: string;
  lifecycle?: OwnershipSubject["lifecycle"];
  executionState?: SessionRecord["executionState"];
  exitCode?: number | null;
  mode?: "graceful" | "force";
  escalation?: string;
  currentController?: string;
  leaseExpiresAt?: string;
  instructionId?: string;
  correlationId?: string;
  checkpointMode?: "non-blocking" | "decision-gate";
  /**
   * How far the instruction got, in the vocabulary of the worker state machine. `delivered` is
   * deliberately absent: it used to be returned for bytes written at a PTY, which at a permission
   * modal meant text sitting unsent in the composer while the caller was told it had landed.
   */
  delivery?: "rendered" | "queued" | "deferred" | "undelivered" | "unavailable";
  /** Why an instruction is held rather than written, when it is held. */
  holdReason?: string;
}

export interface WorkerStateSummary {
  workerId: string;
  lifecycle: OwnershipSubject["lifecycle"];
  leaseState: OwnershipSubject["lease"]["state"];
  controllerId?: string;
  leaseExpiresAt: string;
  decisionGate?: string;
  unresolvedEvents: number;
  pendingCheckpoints: number;
  lastOrdinal: number;
  /** The broker projection of what this worker is actually doing. Absent once its runtime is gone. */
  truth?: WorkerTruth;
}

/**
 * A directed handoff, as the orchestrator that received it reads it back.
 *
 * `briefing` is the same prose the composer nudge carried, so an Orc that saw both is never told
 * two different things. It repeats until a later poll explicitly acknowledges its `handoffId`.
 */
export interface WorkerHandoffNotice {
  handoffId: string;
  directive: string;
  issuedAt: string;
  manifest: HandoffManifestEntry[];
  briefing: string;
}

export interface WorkerEventsResult {
  cursor: number;
  nextCursor: number;
  hasMore: boolean;
  returned: number;
  view: z.infer<typeof WorkerEventViewSchema>;
  state: WorkerStateSummary[];
  /** Oldest pending page. Repeated unchanged until a later call acknowledges its IDs. */
  handoffs?: WorkerHandoffNotice[];
  /** True when finite handoff page left older pending records for later polls. */
  handoffsHaveMore?: boolean;
  /** IDs this poll durably acknowledged before reading its next handoff page. */
  acknowledgedHandoffIds?: string[];
  stateTruncated?: boolean;
  events: Array<Record<string, unknown>>;
}

export class WorkerControlError extends Error {
  constructor(
    readonly code:
      | "ACTOR_NOT_AUTHORIZED"
      | "ACTOR_BINDING_ORPHANED"
      | "TRANSFER_TARGET_UNBOUND",
    message: string,
  ) {
    super(message);
    this.name = "WorkerControlError";
  }
}

export interface WorkerControlOptions {
  coordination: WorkerCoordinationService;
  credentials?: WorkerLeaseCredentialCustodian;
  registry: SessionLookupPort
    & SessionProcessControlPort
    & SessionUpdatePort
    & Pick<WorkerTruthQueryPort, "workerTruth">;
  orchestrators: Pick<OrchestratorStore, "findBySessionId">;
  instructions?: Pick<InstructionQueue, "enqueue">;
  now?: () => number;
  /** Minimum time a graceful worker stop must stay pending before force escalation is allowed. */
  forceStopGraceMs?: number;
}

export class WorkerControlService {
  /**
   * Broker-side lease token custody, keyed by durable controller id and subject.
   *
   * Tokens are deliberately process-local. A broker restart drops them, every lease then ages out
   * through the substrate's own TTL, and the workers become adoptable — which is the recovery path
   * this feature exists to serve. What must never happen is a stale controller silently regaining
   * authority, so a missing token reports OWNERSHIP_LOST and points at explicit re-acquisition.
   */
  private readonly credentials: WorkerLeaseCredentialCustodian;
  private readonly now: () => number;
  private readonly forceStopGraceMs: number;
  private tail = Promise.resolve();

  constructor(private readonly options: WorkerControlOptions) {
    this.credentials = options.credentials ?? new BrokerWorkerLeaseCredentialCustodian();
    this.now = options.now ?? (() => Date.now());
    this.forceStopGraceMs = Math.max(0, options.forceStopGraceMs ?? 5_000);
    options.registry.onSessionUpdate((sessionId) => {
      void this.exclusive(() => this.reconcileSessionLifecycle(sessionId)).catch(() => undefined);
    });
  }

  async lease(input: z.input<typeof AgentLeaseParamsSchema>): Promise<LeaseControlResult> {
    const request = AgentLeaseParamsSchema.parse(input);
    const { binding, controller } = await this.requireController(request.actorSessionId);
    const mutationId = request.mutationId ?? `lease:${randomUUID()}`;
    return this.exclusive(async () => {
      if (request.action === "acquire" || request.action === "adopt") {
        return this.take(request, binding, controller, mutationId);
      }
      return this.authenticatedLease(request, binding, controller, mutationId);
    });
  }

  async control(input: z.input<typeof AgentWorkerControlParamsSchema>): Promise<WorkerControlResult> {
    const request = AgentWorkerControlParamsSchema.parse(input);
    const { binding, controller } = await this.requireController(request.actorSessionId);
    return this.exclusive(async () => {
      const subject = await this.reconcileSessionLifecycle(request.workerId);
      if (subject === undefined) {
        return {
          action: request.action,
          workerId: request.workerId,
          code: "SUBJECT_NOT_FOUND" as const,
          detail: "No lease subject is registered for this worker; acquire a lease first",
        };
      }
      const capability: CyberdeckCapability = request.action === "stop" ? "worker.start" : "thread.enqueue";
      if (!this.inGrant(subject, binding.grant, capability)) {
        return {
          action: request.action,
          workerId: request.workerId,
          code: "DENIED" as const,
          detail: `${capability} over this worker is outside this orchestrator's grant`,
        };
      }
      const authority = await this.authorize(subject, controller, request.reason, request.action);
      if (authority.rejection !== undefined) {
        return { action: request.action, workerId: request.workerId, ...authority.rejection };
      }
      if (request.action === "stop") return this.stopWorker(request, subject, controller);
      if (TERMINAL_WORKER_LIFECYCLES.has(subject.lifecycle)) {
        return {
          action: request.action,
          workerId: request.workerId,
          code: "WORKER_TERMINAL" as const,
          lifecycle: subject.lifecycle,
          detail: "Worker reached a terminal lifecycle; it accepts no further instruction",
        };
      }
      return request.action === "redirect"
        ? this.redirectWorker(request, subject)
        : this.requestCheckpoint(request, subject, controller);
    });
  }

  async events(input: z.input<typeof AgentWorkerEventsParamsSchema>): Promise<WorkerEventsResult> {
    const request = AgentWorkerEventsParamsSchema.parse(input);
    const { binding, controller } = await this.requireController(request.actorSessionId);
    const acknowledged = request.acknowledgeHandoffIds === undefined
      ? []
      : await this.options.coordination.acknowledgeHandoffs({
          controllerId: controller.controllerId,
          handoffIds: request.acknowledgeHandoffIds,
        });
    const scoped = this.options.coordination.listSubjects().filter(
      (subject) => subject.subjectKind === "worker" && this.inGrant(subject, binding.grant, "thread.read"),
    );
    const selected = scoped.filter(
      (subject) =>
        (request.workerId === undefined || subject.subjectId === request.workerId)
        && (request.waveId === undefined || subject.origin.waveId === request.waveId),
    );
    const projection = this.options.coordination.projectEvents({
      cursor: request.cursor,
      limit: request.limit,
      filter: {
        workerIds: selected.map((subject) => subject.subjectId),
        ...(request.waveId === undefined ? {} : { waveId: request.waveId }),
        ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
        ...(request.severities === undefined ? {} : { severities: request.severities }),
        ...(request.view === "active" ? {} : { intervention: interventionFilter(request.view) }),
      },
    });
    const state = selected
      .slice(0, MAX_STATE_ENTRIES)
      .map((subject) => this.stateSummary(subject));
    // Delivery is at-least-once. Reading never changes state; a later poll explicitly acknowledges
    // the previous page. If this response is lost, the same oldest handoff is therefore replayed.
    const pendingHandoffs = this.options.coordination.pendingHandoffs({
      controllerId: controller.controllerId,
      limit: MAX_HANDOFF_PAGE + 1,
    });
    const handoffs = pendingHandoffs.slice(0, MAX_HANDOFF_PAGE);
    return {
      cursor: request.cursor,
      nextCursor: projection.nextCursor,
      hasMore: projection.hasMore,
      returned: projection.events.length,
      view: request.view,
      state,
      ...(selected.length > state.length ? { stateTruncated: true } : {}),
      ...(acknowledged.length === 0
        ? {}
        : { acknowledgedHandoffIds: acknowledged.map((handoff) => handoff.handoffId) }),
      ...(pendingHandoffs.length > MAX_HANDOFF_PAGE ? { handoffsHaveMore: true } : {}),
      ...(handoffs.length === 0
        ? {}
        : {
            handoffs: handoffs.map((handoff) => ({
              handoffId: handoff.handoffId,
              directive: handoff.directive,
              issuedAt: handoff.issuedAt,
              manifest: handoff.manifest,
              briefing: handoffBriefing(handoff),
            })),
          }),
      events: projection.events.map(compactEvent),
    };
  }

  /**
   * Recovery survey: everything a replacement Orc may take, and everything it must not, with the
   * reason spelled out. Ambiguity is never resolved silently in favour of taking control.
   */
  async surveyRecovery(actorSessionId: string, waveId?: string): Promise<RecoveryPlan> {
    const { binding, controller } = await this.requireController(actorSessionId);
    return this.planFor(
      { scope: waveId === undefined ? "all-eligible" : "wave", action: "adopt", ...(waveId === undefined ? {} : { waveId }) },
      binding.grant,
      controller,
    );
  }

  private async take(
    request: z.infer<typeof AgentLeaseParamsSchema>,
    binding: OrchestratorBinding,
    controller: ControllerIdentity,
    mutationId: string,
  ): Promise<LeaseControlResult> {
    if (request.scope === "worker") {
      const single = await this.takeSingle(request, binding, controller, mutationId);
      if (single !== undefined) return single;
    }
    const plan = await this.planFor(request, binding.grant, controller);
    if (request.preview) {
      return {
        action: request.action,
        scope: request.scope,
        mutationId,
        controllerId: controller.controllerId,
        idempotentReplay: false,
        results: [],
        summary: { eligible: plan.eligible.length, blocked: plan.blocked.length },
        plan,
      };
    }
    const batch = plan.eligible.length === 0
      ? undefined
      : await this.options.coordination.adoptBatch({
          mutationId,
          actor: controller,
          newController: controller,
          members: plan.eligible.map((candidate) => ({
            subjectId: candidate.workerId,
            mode: candidate.via,
          })),
          reason: request.reason,
        });
    if (batch?.committed) this.captureTokens(controller, batch.outcomes);
    const results = batch?.outcomes.map(publicOutcome) ?? [];
    if (batch !== undefined && !batch.committed) {
      return {
        action: request.action,
        scope: request.scope,
        mutationId,
        controllerId: controller.controllerId,
        idempotentReplay: false,
        results,
        summary: summarize(results),
        plan,
        aborted: { code: "ADOPTION_ABORTED", cause: results },
      };
    }
    for (const blocker of plan.blocked) {
      results.push({
        workerId: blocker.workerId,
        code: blockerCode(blocker.code),
        detail: blocker.detail,
        ...(blocker.currentController === undefined ? {} : { currentController: blocker.currentController }),
        ...(blocker.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: blocker.leaseExpiresAt }),
      } as LeaseSubjectResult);
    }
    return {
      action: request.action,
      scope: request.scope,
      mutationId,
      controllerId: controller.controllerId,
      idempotentReplay: batch?.idempotentReplay ?? false,
      results,
      summary: summarize(results),
      ...(request.scope === "worker" ? {} : { plan }),
    };
  }

  /**
   * Single-worker acquire/adopt goes straight at the substrate so its verbatim codes — including
   * LEASE_CONFLICT with the live controller and expiry, and NOT_ELIGIBLE for the wrong verb — reach
   * the caller unfiltered instead of being pre-classified away by the recovery planner.
   */
  private async takeSingle(
    request: z.infer<typeof AgentLeaseParamsSchema>,
    binding: OrchestratorBinding,
    controller: ControllerIdentity,
    mutationId: string,
  ): Promise<LeaseControlResult | undefined> {
    const workerId = request.workerId!;
    let subject = await this.reconcileSessionLifecycle(workerId);
    if (subject === undefined) {
      const registered = await this.registerFromSession(workerId, controller, request.reason);
      if (registered === undefined) {
        return {
          action: request.action,
          scope: request.scope,
          mutationId,
          controllerId: controller.controllerId,
          idempotentReplay: false,
          results: [{ workerId, code: "NOT_ELIGIBLE", message: "No such worker session in this broker" }],
          summary: { NOT_ELIGIBLE: 1 },
        };
      }
      subject = registered;
    }
    if (!this.inGrant(subject, binding.grant, "worker.start")) {
      return {
        action: request.action,
        scope: request.scope,
        mutationId,
        controllerId: controller.controllerId,
        idempotentReplay: false,
        results: [{ workerId, code: "NOT_ELIGIBLE", message: "Worker is outside this orchestrator's grant" }],
        summary: { NOT_ELIGIBLE: 1 },
      };
    }
    if (request.preview) return undefined;
    const selector = { scope: "single" as const, subjectId: workerId };
    const result = request.action === "acquire"
      ? await this.options.coordination.acquire({
        mutationId,
        actor: controller,
        controller,
        selector,
        reason: request.reason,
      })
      : await this.options.coordination.adopt({
        mutationId,
        actor: controller,
        newController: controller,
        selector,
        reason: request.reason,
      });
    this.captureTokens(controller, result.outcomes);
    return {
      action: request.action,
      scope: request.scope,
      mutationId,
      controllerId: controller.controllerId,
      idempotentReplay: result.idempotentReplay,
      results: result.outcomes.map(publicOutcome),
      summary: summarize(result.outcomes.map(publicOutcome)),
    };
  }

  private async authenticatedLease(
    request: z.infer<typeof AgentLeaseParamsSchema>,
    binding: OrchestratorBinding,
    controller: ControllerIdentity,
    mutationId: string,
  ): Promise<LeaseControlResult> {
    const held = this.options.coordination.listSubjects().filter(
      (subject) =>
        subject.lease.controller?.controllerId === controller.controllerId
        && this.inGrant(subject, binding.grant, "worker.start")
        && (request.scope !== "wave" || subject.origin.waveId === request.waveId)
        && (request.scope !== "worker" || subject.subjectId === request.workerId),
    );
    if (request.scope === "worker" && held.length === 0) {
      const workerId = request.workerId!;
      const subject = this.options.coordination.getSubject(workerId);
      return {
        action: request.action,
        scope: request.scope,
        mutationId,
        controllerId: controller.controllerId,
        idempotentReplay: false,
        results: [ownershipLost(workerId, subject)],
        summary: { OWNERSHIP_LOST: 1 },
      };
    }
    const leaseTokens: Record<string, string> = {};
    const missing: LeaseSubjectResult[] = [];
    for (const subject of held) {
      const token = this.credentials.get(
        controller.controllerId,
        subject.subjectId,
      )?.leaseToken;
      if (token === undefined) missing.push(ownershipLost(subject.subjectId, subject));
      else leaseTokens[subject.subjectId] = token;
    }
    const targets = held.filter((subject) => leaseTokens[subject.subjectId] !== undefined);
    if (targets.length === 0) {
      return {
        action: request.action,
        scope: request.scope,
        mutationId,
        controllerId: controller.controllerId,
        idempotentReplay: false,
        results: missing,
        summary: summarize(missing),
      };
    }
    const newController = request.action === "transfer"
      ? await this.requireTransferTarget(request.newControllerSessionId!)
      : undefined;
    const results: LeaseSubjectResult[] = [...missing];
    let replay = true;
    for (const subject of targets) {
      const base = {
        mutationId: `${mutationId}:${subject.subjectId}`,
        actor: controller,
        controller,
        selector: { scope: "single" as const, subjectId: subject.subjectId },
        leaseToken: leaseTokens[subject.subjectId]!,
        reason: request.reason,
      };
      const result = request.action === "renew"
        ? await this.options.coordination.renew(base)
        : request.action === "release"
          ? await this.options.coordination.release(base)
          : await this.options.coordination.transfer({ ...base, newController: newController! });
      replay = replay && result.idempotentReplay;
      for (const outcome of result.outcomes) results.push(publicOutcome(outcome));
      if (request.action === "release" || request.action === "transfer") {
        this.credentials.delete(controller.controllerId, subject.subjectId);
      }
      if (newController !== undefined) this.captureTokens(newController, result.outcomes);
    }
    return {
      action: request.action,
      scope: request.scope,
      mutationId,
      controllerId: controller.controllerId,
      idempotentReplay: replay,
      results,
      summary: summarize(results),
    };
  }

  private async planFor(
    request: {
      scope: z.infer<typeof LeaseScopeSchema>;
      action: z.infer<typeof LeaseActionSchema>;
      waveId?: string | undefined;
      workerId?: string | undefined;
    },
    grant: CapabilityGrant,
    controller: ControllerIdentity,
  ): Promise<RecoveryPlan> {
    const nowMs = this.now();
    const eligible: RecoveryCandidate[] = [];
    const blocked: RecoveryBlocker[] = [];
    for (const storedSubject of this.options.coordination.listSubjects()) {
      const subject = await this.reconcileSessionLifecycle(storedSubject.subjectId) ?? storedSubject;
      if (subject.subjectKind !== "worker") continue;
      if (request.scope === "wave" && subject.origin.waveId !== request.waveId) continue;
      if (request.scope === "worker" && subject.subjectId !== request.workerId) continue;
      if (!this.inGrant(subject, grant, "worker.start")) continue;
      const record = this.sessionRecord(subject.subjectId);
      if (TERMINAL_WORKER_LIFECYCLES.has(subject.lifecycle)) {
        blocked.push({
          workerId: subject.subjectId,
          code: "WORKER_TERMINAL",
          detail: `Worker lifecycle is ${subject.lifecycle}; nothing is left to control`,
        });
        continue;
      }
      if (record === undefined) {
        blocked.push({
          workerId: subject.subjectId,
          code: "SUBJECT_UNKNOWN_TO_BROKER",
          detail: "Lease subject has no session in this broker; recovery would control nothing",
        });
        continue;
      }
      const live = this.leaseIsLive(subject, nowMs);
      if (live && subject.lease.controller?.controllerId === controller.controllerId) {
        blocked.push({
          workerId: subject.subjectId,
          code: "ALREADY_CONTROLLED",
          detail: "This controller already holds the lease",
          currentController: subject.lease.controller.controllerId,
          leaseExpiresAt: subject.lease.expiresAt,
        });
        continue;
      }
      if (live && subject.lease.state === "contested") {
        blocked.push({
          workerId: subject.subjectId,
          code: "CONTESTED",
          detail: "Lease is contested by another controller; resolve the contest before adopting",
          ...(subject.lease.controller === undefined
            ? {}
            : { currentController: subject.lease.controller.controllerId }),
          leaseExpiresAt: subject.lease.expiresAt,
        });
        continue;
      }
      if (live) {
        blocked.push({
          workerId: subject.subjectId,
          code: "LEASE_CONFLICT",
          detail: "Another controller holds a live lease",
          ...(subject.lease.controller === undefined
            ? {}
            : { currentController: subject.lease.controller.controllerId }),
          leaseExpiresAt: subject.lease.expiresAt,
        });
        continue;
      }
      const via = subject.lease.state === "released" ? "acquire" : "adopt";
      eligible.push({
        workerId: subject.subjectId,
        taskId: subject.origin.taskId,
        ...(subject.origin.waveId === undefined ? {} : { waveId: subject.origin.waveId }),
        lifecycle: subject.lifecycle,
        leaseState: subject.lease.state,
        ...(subject.lease.controller === undefined
          ? {}
          : { priorController: subject.lease.controller.controllerId }),
        leaseExpiresAt: subject.lease.expiresAt,
        via,
        decisionGate: subject.decisionGate.state === "decision-gate",
        unresolvedEvents: this.unresolvedCount(subject.subjectId),
        pendingCheckpoints: this.options.coordination.listCheckpoints(subject.subjectId, "pending").length,
        sessionKnownToBroker: true,
        executionState: record.executionState,
      });
    }
    return { eligible, blocked };
  }

  private async stopWorker(
    request: z.infer<typeof AgentWorkerControlParamsSchema>,
    subject: OwnershipSubject,
    controller: ControllerIdentity,
  ): Promise<WorkerControlResult> {
    const record = this.sessionRecord(request.workerId);
    if (record === undefined) {
      await this.markStopped(subject, controller, request.reason);
      return {
        action: "stop",
        workerId: request.workerId,
        code: "ALREADY_TERMINAL",
        mode: request.mode,
        lifecycle: "stopped",
        detail: "No broker session remains for this worker; the lease subject is marked stopped",
      };
    }
    if (record.exitCode !== null) {
      await this.markStopped(subject, controller, request.reason);
      return {
        action: "stop",
        workerId: request.workerId,
        code: "ALREADY_TERMINAL",
        mode: request.mode,
        lifecycle: "stopped",
        executionState: record.executionState,
        exitCode: record.exitCode,
      };
    }
    if (!this.options.registry.ownsProcess(request.workerId)) {
      return {
        action: "stop",
        workerId: request.workerId,
        code: "DENIED",
        mode: request.mode,
        executionState: record.executionState,
        detail: "This broker instance does not own the worker process, so it cannot stop it",
      };
    }
    if (request.mode === "force") {
      // The same operator-approval gate the Orc stop path uses: force is an escalation of an
      // already-requested graceful stop, never a first move, and never a raw PID kill.
      if (!this.options.registry.isStopRequested(request.workerId)) {
        return {
          action: "stop",
          workerId: request.workerId,
          code: "APPROVAL_REQUIRED",
          mode: "force",
          executionState: record.executionState,
          detail: "Graceful stop must be requested and observed before force escalation",
          escalation: "Call cyberdeck_worker_ctl stop with mode graceful first",
        };
      }
      const requestedAt = this.options.registry.stopRequestedAt(request.workerId);
      const elapsed = requestedAt === undefined ? 0 : this.now() - Date.parse(requestedAt);
      if (requestedAt === undefined || !Number.isFinite(elapsed) || elapsed < this.forceStopGraceMs) {
        return {
          action: "stop",
          workerId: request.workerId,
          code: "APPROVAL_REQUIRED",
          mode: "force",
          executionState: record.executionState,
          detail: `Graceful stop must remain pending for ${this.forceStopGraceMs}ms before force escalation`,
          escalation: "Retry force after the grace period",
        };
      }
      this.options.registry.forceStop(request.workerId);
    } else {
      await this.options.registry.stop(request.workerId);
    }
    const current = this.sessionRecord(request.workerId);
    const terminal = current?.exitCode !== null && current?.exitCode !== undefined;
    const lifecycle = terminal
      ? (await this.reconcileSessionLifecycle(request.workerId))?.lifecycle ?? "stopped"
      : subject.lifecycle;
    return {
      action: "stop",
      workerId: request.workerId,
      code: terminal ? "STOPPED" : "STOP_REQUESTED",
      mode: request.mode,
      lifecycle,
      ...(current === undefined ? {} : { executionState: current.executionState, exitCode: current.exitCode }),
      ...(terminal
        ? {}
        : {
          escalation: request.mode === "force"
            ? "SIGKILL delivered; the process exit is reported through the session record"
            : "If the worker does not exit, call cyberdeck_worker_ctl stop with mode force",
        }),
    };
  }

  private async redirectWorker(
    request: z.infer<typeof AgentWorkerControlParamsSchema>,
    subject: OwnershipSubject,
  ): Promise<WorkerControlResult> {
    const instructions = this.options.instructions;
    if (instructions === undefined) {
      return {
        action: "redirect",
        workerId: request.workerId,
        code: "DENIED",
        detail: "This broker has no instruction queue configured",
      };
    }
    try {
      const record = await instructions.enqueue({
        actorSessionId: request.actorSessionId,
        targetSessionId: request.workerId,
        message: request.instruction!,
        ...(request.messageId === undefined ? {} : { messageId: request.messageId }),
      });
      // A worker can die between the lease check above and the write. The instruction is terminal
      // then, and saying `QUEUED` would leave the caller waiting on a turn that cannot happen.
      const code = record.status === "rendered"
        ? "RENDERED"
        : record.status === "undelivered"
          ? "WORKER_TERMINAL"
          : "QUEUED";
      return {
        action: "redirect",
        workerId: request.workerId,
        code,
        lifecycle: subject.lifecycle,
        instructionId: record.id,
        delivery: record.status === "rendered"
          ? "rendered"
          : record.status === "undelivered"
            ? "undelivered"
            : "queued",
        ...(record.holdReason === undefined ? {} : { holdReason: record.holdReason }),
      };
    } catch (error) {
      return {
        action: "redirect",
        workerId: request.workerId,
        code: enqueueFailureCode(error),
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async requestCheckpoint(
    request: z.infer<typeof AgentWorkerControlParamsSchema>,
    subject: OwnershipSubject,
    controller: ControllerIdentity,
  ): Promise<WorkerControlResult> {
    const token = this.credentials.get(controller.controllerId, request.workerId)!.leaseToken;
    const mode = request.decisionGate ? "decision-gate" as const : "non-blocking" as const;
    const existing = this.options.coordination
      .getCheckpoint(request.workerId, request.correlationId!);
    const checkpoint = await this.options.coordination.requestCheckpoint({
      mutationId: `checkpoint:${request.workerId}:${request.correlationId!}`,
      controller,
      leaseToken: token,
      correlationId: request.correlationId!,
      workerId: request.workerId,
      ...(request.focus === undefined ? {} : { focus: request.focus }),
      ...(request.question === undefined ? {} : { question: request.question }),
      mode,
    });
    const delivery = existing === undefined
      ? await this.deliverCheckpointPrompt(request, checkpoint.mode)
      : "deferred" as const;
    return {
      action: "request_checkpoint",
      workerId: request.workerId,
      code: existing === undefined ? "CHECKPOINT_REQUESTED" : "CHECKPOINT_REPLAY",
      lifecycle: subject.lifecycle,
      correlationId: checkpoint.correlationId,
      checkpointMode: checkpoint.mode,
      delivery,
      detail: checkpoint.mode === "decision-gate"
        ? "Worker must pause at its next turn boundary and wait for a decision"
        : "Worker answers at its next turn boundary; the current task is not cancelled",
    };
  }

  /**
   * A checkpoint request rides the instruction queue precisely because that queue never interrupts:
   * a busy worker keeps its turn and the prompt is flushed when control is released. Nothing here
   * cancels, restarts, or writes into a running turn.
   */
  private async deliverCheckpointPrompt(
    request: z.infer<typeof AgentWorkerControlParamsSchema>,
    mode: "non-blocking" | "decision-gate",
  ): Promise<"rendered" | "queued" | "undelivered" | "unavailable"> {
    const instructions = this.options.instructions;
    if (instructions === undefined) return "unavailable";
    const lines = [
      `Cyberdeck checkpoint request ${request.correlationId!}${mode === "decision-gate" ? " (decision gate)" : ""}.`,
      ...(request.focus === undefined ? [] : [`Focus: ${request.focus}`]),
      ...(request.question === undefined ? [] : [`Question: ${request.question}`]),
      `Answer at your next turn boundary with a CHECKPOINT event carrying checkpointCorrelationId ${request.correlationId!}. Do not cancel or restart your current task.`,
      ...(mode === "decision-gate"
        ? ["Pause before the next irreversible step and wait for the orchestrator's decision."]
        : []),
    ];
    try {
      const record = await instructions.enqueue({
        actorSessionId: request.actorSessionId,
        targetSessionId: request.workerId,
        message: lines.join("\n"),
      });
      return record.status === "rendered"
        ? "rendered"
        : record.status === "undelivered"
          ? "undelivered"
          : "queued";
    } catch {
      return "unavailable";
    }
  }

  /**
   * Every worker_ctl action authenticates through one renew. That single call proves the token,
   * identity, and lease version are still current, refreshes the lease, and writes the durable audit
   * record carrying actor, time, controller, and reason — so no control action is unaudited.
   */
  private async authorize(
    subject: OwnershipSubject,
    controller: ControllerIdentity,
    reason: string,
    action: string,
  ): Promise<{ rejection?: Omit<WorkerControlResult, "action" | "workerId"> & { code: WorkerControlCode } }> {
    const token = this.credentials.get(
      controller.controllerId,
      subject.subjectId,
    )?.leaseToken;
    if (token === undefined) {
      return {
        rejection: {
          code: subject.lease.controller?.controllerId === controller.controllerId
            ? "OWNERSHIP_LOST"
            : "NOT_CONTROLLER",
          detail: subject.lease.controller === undefined
            ? "This broker holds no lease token for this controller; acquire or adopt the lease first"
            : `Lease is held by ${subject.lease.controller.controllerId}; acquire or adopt before controlling this worker`,
          ...(subject.lease.controller === undefined
            ? {}
            : { currentController: subject.lease.controller.controllerId }),
          leaseExpiresAt: subject.lease.expiresAt,
        },
      };
    }
    const result = await this.options.coordination.renew({
      mutationId: `ctl:${action}:${randomUUID()}`,
      actor: controller,
      controller,
      selector: { scope: "single", subjectId: subject.subjectId },
      leaseToken: token,
      reason: `${action}: ${reason}`,
    });
    const outcome = result.outcomes[0];
    if (outcome === undefined || outcome.code === "ALREADY_CONTROLLED") return {};
    this.credentials.delete(controller.controllerId, subject.subjectId);
    return {
      rejection: {
        code: outcome.code === "ORPHANED" ? "LEASE_EXPIRED" : "OWNERSHIP_LOST",
        detail: outcome.message ?? "Controller authority is no longer current",
        ...(outcome.currentController === undefined
          ? {}
          : { currentController: outcome.currentController.controllerId }),
        ...(outcome.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: outcome.leaseExpiresAt }),
      },
    };
  }

  private async markStopped(
    subject: OwnershipSubject,
    controller: ControllerIdentity,
    reason: string,
  ): Promise<void> {
    const token = this.credentials.get(
      controller.controllerId,
      subject.subjectId,
    )?.leaseToken;
    if (token === undefined) return;
    await this.options.coordination.updateLifecycle({
      mutationId: `ctl:stop:lifecycle:${randomUUID()}`,
      actor: controller,
      controller,
      selector: { scope: "single", subjectId: subject.subjectId },
      leaseToken: token,
      subjectId: subject.subjectId,
      lifecycle: "stopped",
      reason: `stop: ${reason}`,
    });
  }

  private async reconcileSessionLifecycle(workerId: string): Promise<OwnershipSubject | undefined> {
    const subject = this.options.coordination.getSubject(workerId);
    if (subject === undefined) return undefined;
    const record = this.sessionRecord(workerId);
    if (record === undefined) return subject;
    const observed = lifecycleOf(record);
    const staleTerminal = record.exitCode === null && TERMINAL_WORKER_LIFECYCLES.has(subject.lifecycle);
    const observedExit = record.exitCode !== null && subject.lifecycle !== observed;
    if (!staleTerminal && !observedExit) return subject;
    return this.options.coordination.reconcileLifecycle({
      mutationId: `broker:lifecycle:${workerId}:${randomUUID()}`,
      subjectId: workerId,
      lifecycle: observed,
      reason: record.exitCode === null
        ? "broker registry still owns a live process"
        : `broker registry observed process exit ${record.exitCode}`,
    });
  }

  private async registerFromSession(
    workerId: string,
    controller: ControllerIdentity,
    reason: string,
  ): Promise<OwnershipSubject | undefined> {
    const record = this.sessionRecord(workerId);
    if (record === undefined) return undefined;
    const creator = record.parentSessionId === undefined
      ? undefined
      : await this.controllerForSession(record.parentSessionId);
    const owned = creator?.controllerId === controller.controllerId;
    await this.options.coordination.registerSubject({
      mutationId: `worker-control:register:${workerId}`,
      actor: controller,
      subjectId: workerId,
      subjectKind: "worker",
      origin: {
        creatorControllerId: creator?.controllerId ?? "legacy-unresolved",
        ...(record.parentSessionId === undefined ? {} : { creatorSessionId: record.parentSessionId }),
        taskId: workerId,
        threadId: workerId,
        createdAt: record.createdAt,
      },
      lifecycle: lifecycleOf(record),
      resources: {
        sessionId: workerId,
        worktreePath: record.cwd,
        transcriptRef: `thread:${workerId}`,
        resultStateRef: `session:${workerId}`,
        eventStreamId: `worker:${workerId}`,
      },
      ...(owned ? { controller } : {}),
      reason: owned
        ? reason
        : "worker registered without proven creator identity; adoptable rather than granted",
    }).then((result) => this.captureTokens(controller, result.outcomes));
    return this.options.coordination.getSubject(workerId);
  }

  private stateSummary(subject: OwnershipSubject): WorkerStateSummary {
    return {
      workerId: subject.subjectId,
      lifecycle: subject.lifecycle,
      leaseState: subject.lease.state,
      ...(subject.lease.controller === undefined
        ? {}
        : { controllerId: subject.lease.controller.controllerId }),
      leaseExpiresAt: subject.lease.expiresAt,
      ...(subject.decisionGate.state === "decision-gate" && subject.decisionGate.correlationId !== undefined
        ? { decisionGate: subject.decisionGate.correlationId }
        : {}),
      unresolvedEvents: this.unresolvedCount(subject.subjectId),
      pendingCheckpoints: this.options.coordination.listCheckpoints(subject.subjectId, "pending").length,
      lastOrdinal: this.lastOrdinal(subject.subjectId),
      ...(this.workerTruth(subject.subjectId) ?? {}),
    };
  }

  /**
   * The broker's own reading of the worker, projected into this summary.
   *
   * `lifecycle` above is the ownership substrate's view and answers a different question: whether a
   * lease can be taken. It said `active` for workers that had already stopped, which is half of the
   * contradiction MIK-71 reported. `truth` is the same projection `workers_wait` settles from.
   */
  private workerTruth(workerId: string): { truth: WorkerTruth } | undefined {
    try {
      return { truth: this.options.registry.workerTruth(workerId) };
    } catch {
      // A subject the broker no longer holds a runtime for. The substrate's own view is all there is.
      return undefined;
    }
  }

  private unresolvedCount(workerId: string): number {
    return this.options.coordination.workerEventSummary(workerId).unresolvedCount;
  }

  private lastOrdinal(workerId: string): number {
    return this.options.coordination.workerEventSummary(workerId).lastOrdinal;
  }

  private leaseIsLive(subject: OwnershipSubject, nowMs: number): boolean {
    if (subject.lease.controller === undefined) return false;
    if (subject.lease.state !== "active" && subject.lease.state !== "contested") return false;
    return nowMs < Date.parse(subject.lease.expiresAt);
  }

  private captureTokens(controller: ControllerIdentity, outcomes: readonly OwnershipOutcome[]): void {
    for (const outcome of outcomes) {
      if (outcome.leaseToken === undefined || outcome.leaseVersion === undefined) continue;
      this.credentials.set(controller.controllerId, outcome.subjectId, {
        leaseToken: outcome.leaseToken,
        leaseVersion: outcome.leaseVersion,
      });
    }
  }

  private inGrant(
    subject: OwnershipSubject,
    grant: CapabilityGrant,
    capability: CyberdeckCapability,
  ): boolean {
    const cwd = this.sessionRecord(subject.subjectId)?.cwd ?? subject.resources.worktreePath;
    return grantAllows(grant, capability, {
      sessionId: subject.subjectId,
      ...(cwd === undefined ? {} : { cwd }),
    });
  }

  private sessionRecord(sessionId: string): SessionRecord | undefined {
    try {
      return this.options.registry.get(sessionId);
    } catch {
      return undefined;
    }
  }

  /**
   * A binding is the whole of the authority: holding one is holding a controller identity.
   *
   * Peer bindings included. They were once refused here while still being granted `thread.enqueue`,
   * so a peer could instruct a worker it could neither control nor observe (MIK-98).
   */
  private async requireController(actorSessionId: string): Promise<{
    binding: OrchestratorBinding;
    controller: ControllerIdentity;
  }> {
    const binding = await this.options.orchestrators.findBySessionId(actorSessionId);
    if (binding === undefined) {
      throw new WorkerControlError(
        "ACTOR_NOT_AUTHORIZED",
        `${actorSessionId} holds no Cyberdeck orchestrator binding, so it has no controller identity`,
      );
    }
    return { binding, controller: orchestratorController(binding) };
  }

  private async requireTransferTarget(sessionId: string): Promise<ControllerIdentity> {
    const controller = await this.controllerForSession(sessionId);
    if (controller === undefined) {
      throw new WorkerControlError(
        "TRANSFER_TARGET_UNBOUND",
        `Session ${sessionId} holds no stable orchestrator binding, so it cannot receive a lease`,
      );
    }
    return controller;
  }

  private async controllerForSession(sessionId: string): Promise<ControllerIdentity | undefined> {
    const binding = await this.options.orchestrators.findBySessionId(sessionId);
    return binding === undefined ? undefined : orchestratorController(binding);
  }

  /** Plans and mutations are serialized so a survey cannot straddle another call's adoption. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function publicOutcome(outcome: OwnershipOutcome): LeaseSubjectResult {
  return {
    workerId: outcome.subjectId,
    code: outcome.code,
    ...(outcome.leaseVersion === undefined ? {} : { leaseVersion: outcome.leaseVersion }),
    ...(outcome.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: outcome.leaseExpiresAt }),
    ...(outcome.currentController === undefined
      ? {}
      : {
        currentController: outcome.currentController.controllerId,
        currentControllerScope: outcome.currentController.scope,
      }),
    ...(outcome.message === undefined ? {} : { message: outcome.message }),
  };
}

function ownershipLost(workerId: string, subject: OwnershipSubject | undefined): LeaseSubjectResult {
  return {
    workerId,
    code: "OWNERSHIP_LOST",
    ...(subject === undefined ? {} : { leaseVersion: subject.lease.version, leaseExpiresAt: subject.lease.expiresAt }),
    ...(subject?.lease.controller === undefined
      ? {}
      : { currentController: subject.lease.controller.controllerId }),
    message: subject === undefined
      ? "No lease subject is registered for this worker"
      : "This broker holds no current lease token for this controller; acquire or adopt explicitly",
  };
}

function blockerCode(code: RecoveryBlocker["code"]): LeaseResultCode {
  if (code === "WORKER_TERMINAL") return "WORKER_TERMINAL";
  if (code === "ALREADY_CONTROLLED") return "ALREADY_CONTROLLED";
  if (code === "SUBJECT_UNKNOWN_TO_BROKER") return "NOT_ELIGIBLE";
  return "LEASE_CONFLICT";
}

function summarize(results: readonly LeaseSubjectResult[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const result of results) summary[result.code] = (summary[result.code] ?? 0) + 1;
  return summary;
}

function interventionFilter(
  view: z.infer<typeof WorkerEventViewSchema>,
): "unresolved" | "resolved" | "any" {
  if (view === "unresolved") return "unresolved";
  if (view === "resolved") return "resolved";
  return "any";
}

function enqueueFailureCode(error: unknown): WorkerControlCode {
  const code = typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
  if (code === "CAPABILITY_DENIED" || code === "ACTOR_NOT_AUTHORIZED") return "DENIED";
  if (code === "SESSION_NOT_FOUND") return "SUBJECT_NOT_FOUND";
  return "DENIED";
}

function lifecycleOf(record: SessionRecord): OwnershipSubject["lifecycle"] {
  if (record.exitCode !== null) {
    if (record.executionState === "cancelled") return "stopped";
    if (record.executionState === "errored" || record.executionState === "failed") return "failed";
    return record.exitCode === 0 ? "done" : "failed";
  }
  if (record.executionState === "starting") return "launching";
  if (record.attentionState === "working") return "working";
  if (record.attentionState === "needs-input") return "waiting";
  if (record.executionState === "active") return "working";
  // Cancelled, errored, and failed bookkeeping can still own a live process. Keep coordination
  // recoverable until registry exit observation supplies a non-null exitCode.
  return "working";
}

/** Material state and deltas only. Transcript-shaped output is never produced by this projection. */
function compactEvent(event: StoredWorkerEvent): Record<string, unknown> {
  const facts = event.structuredFacts === undefined
    ? undefined
    : Object.fromEntries(
      Object.entries(event.structuredFacts)
        .slice(0, MAX_FACTS)
        .map(([key, value]) => [key, typeof value === "string" ? truncate(value, FIELD_CHARS) : value]),
    );
  return {
    ordinal: event.ordinal,
    eventId: event.eventId,
    workerId: event.workerId,
    ...(event.waveId === undefined ? {} : { waveId: event.waveId }),
    kind: event.kind,
    severity: event.severity,
    interventionRequired: event.interventionRequired,
    continuation: event.continuation,
    state: event.state,
    summary: truncate(event.summary, SUMMARY_CHARS),
    ...(facts === undefined || Object.keys(facts).length === 0 ? {} : { facts }),
    ...(event.changedAssumptions.length === 0
      ? {}
      : { changedAssumptions: event.changedAssumptions.slice(0, MAX_LIST_FIELDS).map((entry) => truncate(entry, FIELD_CHARS)) }),
    ...(event.evidenceRefs.length === 0
      ? {}
      : { evidenceRefs: event.evidenceRefs.slice(0, MAX_LIST_FIELDS).map((entry) => truncate(entry, FIELD_CHARS)) }),
    ...(event.recommendedAction === undefined
      ? {}
      : { recommendedAction: truncate(event.recommendedAction, RECOMMENDATION_CHARS) }),
    ...(event.checkpointCorrelationId === undefined
      ? {}
      : { checkpointCorrelationId: event.checkpointCorrelationId }),
    at: event.timestamp,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
