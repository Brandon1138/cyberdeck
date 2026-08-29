import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkerCoordinationService } from "../broker/worker-coordination.js";
import type { WorkerLeaseCredentialCustodian } from "../broker/worker-lease-credential-custodian.js";
import { BrokerWorkerLeaseCredentialCustodian } from "../broker/worker-lease-credential-custodian.js";
import { grantAllows, type CapabilityGrant } from "../domain/capability.js";
import { orchestratorController } from "../domain/orchestrator.js";
import type { SessionRecord } from "../domain/session.js";
import type {
  ControllerIdentity,
  OwnershipOutcome,
  WorkerLifecycle,
} from "../domain/worker-coordination.js";
import { HANDOFF_LIMITS, handoffBriefing } from "../domain/worker-handoff.js";
import type { InstructionQueue } from "./instruction-queue.js";
import type { OrchestratorBindingLookup } from "./persistence-ports.js";
import type { SessionLookupPort } from "./session/session-ports.js";

export const WorkerHandoffParamsSchema = z.object({
  recipientSessionId: z.uuid(),
  workerIds: z.array(z.uuid()).min(1).max(HANDOFF_LIMITS.manifestEntries),
  directive: z.string().trim().min(1).max(HANDOFF_LIMITS.directiveChars),
  reason: z.string().trim().min(1).max(500).default("operator directed handoff"),
  mutationId: z.string().min(1).max(200).optional(),
});

export type WorkerHandoffParams = z.input<typeof WorkerHandoffParamsSchema>;

export type WorkerHandoffBlockerCode =
  | "WORKER_UNKNOWN"
  | "NOT_A_WORKER"
  | "DUPLICATE"
  | "WORKER_TERMINAL"
  | "NOT_ELIGIBLE";

export interface WorkerHandoffBlocker {
  workerId: string;
  code: WorkerHandoffBlockerCode;
  detail: string;
}

export interface WorkerHandoffTransfer {
  workerId: string;
  code: OwnershipOutcome["code"];
  /** Absent when nothing held the worker before — the operator was running it themselves. */
  priorControllerId?: string;
}

/**
 * How the directive reached the recipient's composer.
 *
 * `pending` is not a failure: the durable handoff record is written either way, and an
 * orchestrator that never saw the nudge still reads the whole thing from `worker_events`, where it
 * replays until that recipient explicitly acknowledges the handoff ID.
 * Reporting the difference is what keeps the fleet's notice honest about which one happened.
 */
export type WorkerHandoffDelivery = "delivered" | "pending" | "failed" | "not-attempted";

export interface WorkerHandoffResult {
  committed: boolean;
  recipientSessionId: string;
  recipientControllerId?: string;
  handoffId?: string;
  directive: string;
  transferred: WorkerHandoffTransfer[];
  blocked: WorkerHandoffBlocker[];
  delivery: WorkerHandoffDelivery;
  deliveryDetail?: string;
}

export class WorkerHandoffError extends Error {
  constructor(
    readonly code:
      | "RECIPIENT_UNBOUND"
      | "RECIPIENT_NOT_LIVE"
      | "RECIPIENT_IS_TARGET"
      | "RECIPIENT_SCOPE_VIOLATION",
    message: string,
    readonly offendingWorkerIds?: readonly string[],
    readonly recipientScope?: CapabilityGrant["scope"],
  ) {
    super(message);
    this.name = "WorkerHandoffError";
  }
}

export interface WorkerHandoffOptions {
  coordination: WorkerCoordinationService;
  registry: SessionLookupPort;
  orchestrators: OrchestratorBindingLookup;
  instructions?: Pick<InstructionQueue, "enqueue">;
  credentials?: WorkerLeaseCredentialCustodian;
}

/**
 * The operator's own identity in the audit log.
 *
 * A directed handoff is not one controller taking from another — it is the operator moving their
 * own fleet, and the record should say so rather than borrow the recipient's identity and make the
 * transfer read as self-service.
 */
const OPERATOR_ACTOR: ControllerIdentity = {
  controllerId: "cyberdeck-operator",
  familyId: "cyberdeck-operator",
  scope: { kind: "fleet", scopeId: "local-broker" },
};

/**
 * Directed handoff: the operator moves marked workers onto one live orchestrator and tells it what
 * to do with them.
 *
 * Everything authority-shaped here is borrowed rather than invented. The recipient's controller
 * identity comes from `orchestratorController`, the single derivation MIK-98 settled, so a peer
 * binding receives a handoff on exactly the same terms as a primary — which is the whole reason
 * this could not be built before it. The transfer itself is one call into the ownership substrate,
 * which either moves every lease or moves none.
 */
export class WorkerHandoffService {
  private readonly credentials: WorkerLeaseCredentialCustodian;
  private tail = Promise.resolve();

  constructor(private readonly options: WorkerHandoffOptions) {
    this.credentials = options.credentials ?? new BrokerWorkerLeaseCredentialCustodian();
  }

  async handoff(input: WorkerHandoffParams): Promise<WorkerHandoffResult> {
    const request = WorkerHandoffParamsSchema.parse(input);
    const binding = await this.options.orchestrators.findBySessionId(request.recipientSessionId);
    if (binding === undefined) {
      throw new WorkerHandoffError(
        "RECIPIENT_UNBOUND",
        `Session ${request.recipientSessionId} holds no orchestrator binding, so it has no controller identity to receive a lease`,
      );
    }
    const recipientRecord = this.sessionRecord(request.recipientSessionId);
    if (recipientRecord === undefined || !isLiveOrchestrator(recipientRecord)) {
      throw new WorkerHandoffError(
        "RECIPIENT_NOT_LIVE",
        `Orchestrator ${request.recipientSessionId} is not running; a handoff to it would strand every worker it names`,
      );
    }
    if (request.workerIds.includes(request.recipientSessionId)) {
      throw new WorkerHandoffError(
        "RECIPIENT_IS_TARGET",
        "An orchestrator cannot be handed off to itself",
      );
    }
    const recipient = orchestratorController(binding);
    return this.exclusive(() => this.transfer(
      request,
      recipient,
      recipientRecord,
      binding.grant,
    ));
  }

  private async transfer(
    request: z.output<typeof WorkerHandoffParamsSchema>,
    recipient: ControllerIdentity,
    recipientRecord: SessionRecord,
    recipientGrant: CapabilityGrant,
  ): Promise<WorkerHandoffResult> {
    const refused: WorkerHandoffBlocker[] = [];
    const outsideRecipientScope: string[] = [];
    const seen = new Set<string>();
    const members: Parameters<WorkerCoordinationService["handoffBatch"]>[0]["members"][number][] = [];
    for (const workerId of request.workerIds) {
      if (seen.has(workerId)) {
        refused.push({ workerId, code: "DUPLICATE", detail: "Worker named twice in one handoff" });
        continue;
      }
      seen.add(workerId);
      const record = this.sessionRecord(workerId);
      const subject = this.options.coordination.getSubject(workerId);
      if (record !== undefined && (record.kind ?? "worker") === "orchestrator") {
        refused.push({
          workerId,
          code: "NOT_A_WORKER",
          detail: "An orchestrator is a controller, not a worker to be handed off",
        });
        continue;
      }
      if (subject === undefined && record === undefined) {
        refused.push({
          workerId,
          code: "WORKER_UNKNOWN",
          detail: "The broker holds neither a session nor a lease record for this worker",
        });
        continue;
      }
      // Registry exits are reconciled lazily, the same way WorkerControlService does it: nothing
      // walks the substrate marking subjects terminal when a process dies, so a coordination
      // subject can still read `working` for a worker the registry has already watched exit.
      // Handing that one over would move a lease and brief the recipient on a dead process, so the
      // durable lifecycle is repaired here and the worker is refused before the batch is built.
      if (record !== undefined && record.exitCode !== null) {
        const observed = manualWorkerLifecycle(record);
        if (subject !== undefined && subject.lifecycle !== observed) {
          await this.options.coordination.reconcileLifecycle({
            mutationId: `handoff:lifecycle:${workerId}:${randomUUID()}`,
            subjectId: workerId,
            lifecycle: observed,
            reason: `broker registry observed process exit ${record.exitCode}`,
          });
        }
        refused.push({
          workerId,
          code: "WORKER_TERMINAL",
          detail: `The broker registry observed this worker exit with code ${record.exitCode}`,
        });
        continue;
      }
      const cwd = record?.cwd ?? subject?.resources.worktreePath;
      if (!grantAllows(recipientGrant, "worker.start", {
        sessionId: workerId,
        ...(cwd === undefined ? {} : { cwd }),
      })) {
        outsideRecipientScope.push(workerId);
      }
      members.push({
        subjectId: workerId,
        ...(record?.name === undefined ? {} : { name: record.name }),
        // A worker the substrate has never seen is registered by the same transaction that
        // transfers it, so an aborted batch leaves no half-created subject behind.
        ...(subject === undefined && record !== undefined
          ? { register: registrationFor(record) }
          : {}),
      });
    }

    // Scope authority is the same `grantAllows` predicate used by WorkerControlService. Settle
    // every member before entering the ownership substrate: one bad cwd must not fence any prior
    // controller or leave the recipient holding a worker it cannot control and observe.
    if (outsideRecipientScope.length > 0) {
      const scope = grantScopeLabel(recipientGrant.scope);
      throw new WorkerHandoffError(
        "RECIPIENT_SCOPE_VIOLATION",
        `Workers ${outsideRecipientScope.join(", ")} are outside recipient grant scope ${scope}`,
        outsideRecipientScope,
        recipientGrant.scope,
      );
    }

    // Refusals are settled before the substrate is touched at all: a batch that cannot succeed
    // whole must not move a single lease on its way to finding that out.
    if (refused.length > 0) {
      return {
        committed: false,
        recipientSessionId: recipientRecord.id,
        recipientControllerId: recipient.controllerId,
        directive: request.directive,
        transferred: [],
        blocked: refused,
        delivery: "not-attempted",
      };
    }

    const result = await this.options.coordination.handoffBatch({
      mutationId: request.mutationId ?? `handoff:${randomUUID()}`,
      actor: OPERATOR_ACTOR,
      recipient,
      recipientSessionId: recipientRecord.id,
      directive: request.directive,
      members,
      reason: request.reason,
      // The check above reads the registry while the batch is being assembled; a worker can exit
      // between that read and the append that moves its lease. Asking again inside the transaction
      // is the last moment the substrate can still refuse the whole batch, so it is asked there.
      observeLifecycle: (subjectId) => {
        const current = this.sessionRecord(subjectId);
        return current === undefined ? undefined : manualWorkerLifecycle(current);
      },
    });

    if (!result.committed || result.handoff === undefined) {
      return {
        committed: false,
        recipientSessionId: recipientRecord.id,
        recipientControllerId: recipient.controllerId,
        directive: request.directive,
        transferred: [],
        blocked: result.outcomes.map((outcome) => ({
          workerId: outcome.subjectId,
          code: outcome.code === "WORKER_TERMINAL" ? "WORKER_TERMINAL" : "NOT_ELIGIBLE",
          detail: outcome.message ?? `Lease substrate refused the handoff with ${outcome.code}`,
        })),
        delivery: "not-attempted",
      };
    }

    // The recipient must be able to act on what it was just given. Without its fenced tokens in
    // broker custody, its very next `worker_ctl` call reports OWNERSHIP_LOST on a lease it does own.
    for (const outcome of result.outcomes) {
      if (outcome.leaseToken === undefined || outcome.leaseVersion === undefined) continue;
      this.credentials.set(recipient.controllerId, outcome.subjectId, {
        leaseToken: outcome.leaseToken,
        leaseVersion: outcome.leaseVersion,
      });
    }

    const priorById = new Map(
      result.handoff.manifest.map((entry) => [entry.workerId, entry.priorControllerId]),
    );
    const delivery = await this.deliver(recipientRecord.id, result.handoff.handoffId, handoffBriefing(result.handoff));
    return {
      committed: true,
      recipientSessionId: recipientRecord.id,
      recipientControllerId: recipient.controllerId,
      handoffId: result.handoff.handoffId,
      directive: request.directive,
      transferred: result.outcomes.map((outcome) => {
        const prior = priorById.get(outcome.subjectId);
        return {
          workerId: outcome.subjectId,
          code: outcome.code,
          ...(prior === undefined ? {} : { priorControllerId: prior }),
        };
      }),
      blocked: [],
      ...delivery,
    };
  }

  /**
   * Push the briefing into the recipient's composer, and report what actually happened to it.
   *
   * A failure here is deliberately not an error: the leases have already moved and the handoff
   * record is already durable, so throwing would report a transfer that did happen as one that did
   * not. The recipient reads the same briefing from `worker_events` until it acknowledges the ID.
   */
  private async deliver(
    recipientSessionId: string,
    handoffId: string,
    message: string,
  ): Promise<{ delivery: WorkerHandoffDelivery; deliveryDetail?: string }> {
    const instructions = this.options.instructions;
    if (instructions === undefined) {
      return { delivery: "pending", deliveryDetail: "This broker has no instruction queue" };
    }
    try {
      const record = await instructions.enqueue({
        actorSessionId: recipientSessionId,
        targetSessionId: recipientSessionId,
        messageId: handoffId,
        message,
      });
      return record.status === "rendered" || record.status === "acknowledged" || record.status === "completed"
        ? { delivery: "delivered" }
        : {
            delivery: "pending",
            deliveryDetail: `Instruction ${record.status}; the handoff is durable and will replay through worker_events until acknowledged`,
          };
    } catch (error) {
      return {
        delivery: "failed",
        deliveryDetail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private sessionRecord(sessionId: string): SessionRecord | undefined {
    try {
      return this.options.registry.get(sessionId);
    } catch {
      return undefined;
    }
  }

  /** One handoff at a time, so two operator gestures cannot interleave over the same worker. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function grantScopeLabel(scope: CapabilityGrant["scope"]): string {
  if (scope.kind === "fleet") return "fleet";
  if (scope.kind === "self") return "self";
  return `workspace:${scope.cwd}`;
}

/** A live orchestrator: one that can still be handed something and read it. */
function isLiveOrchestrator(record: SessionRecord): boolean {
  if ((record.kind ?? "worker") !== "orchestrator") return false;
  if (record.exitCode !== null) return false;
  return record.executionState === "active" || record.executionState === "starting";
}

function registrationFor(record: SessionRecord): {
  origin: { creatorControllerId: string; creatorSessionId?: string; taskId: string; threadId: string; createdAt: string };
  lifecycle: WorkerLifecycle;
  resources: { sessionId: string; worktreePath?: string; transcriptRef: string; resultStateRef: string; eventStreamId: string };
} {
  return {
    origin: {
      // The operator started it, and no controller can honestly claim it. `legacy-unresolved` is
      // already what the rest of the broker writes for exactly this, and Fleet reads it as "yours".
      creatorControllerId: "legacy-unresolved",
      ...(record.parentSessionId === undefined ? {} : { creatorSessionId: record.parentSessionId }),
      taskId: record.id,
      threadId: record.id,
      createdAt: record.createdAt,
    },
    lifecycle: manualWorkerLifecycle(record),
    resources: {
      sessionId: record.id,
      ...(record.cwd === undefined ? {} : { worktreePath: record.cwd }),
      transcriptRef: `thread:${record.id}`,
      resultStateRef: `session:${record.id}`,
      eventStreamId: `worker:${record.id}`,
    },
  };
}

/**
 * What the session registry says a worker's lifecycle is: the state a manual worker is registered
 * at, and the state a stale coordination subject is reconciled to once the registry sees an exit.
 *
 * It matters here in a way it does not elsewhere: a terminal lifecycle aborts the whole batch, so
 * reading a live worker as stopped would refuse a handoff the operator can plainly see is valid.
 */
function manualWorkerLifecycle(record: SessionRecord): WorkerLifecycle {
  if (record.exitCode !== null) {
    if (record.executionState === "cancelled") return "stopped";
    if (record.executionState === "errored" || record.executionState === "failed") return "failed";
    return record.exitCode === 0 ? "done" : "failed";
  }
  if (record.executionState === "starting") return "launching";
  return record.attentionState === "needs-input" ? "waiting" : "working";
}
