import { z } from "zod";
import { grantAllows } from "../domain/capability.js";
import {
  NOTIFICATION_LIMITS,
  NotificationKindSchema,
  NotificationPolicySchema,
  settledDedupeKey,
  type Notice,
  type NotificationPolicy,
  type OrchestratorNotification,
} from "../domain/orchestrator-notification.js";
import { orchestratorController, type OrchestratorBinding } from "../domain/orchestrator.js";
import { WorkerEventSeveritySchema } from "../domain/worker-coordination.js";
import type { NotificationInboxPort } from "./orchestrator-notification-ports.js";
import type {
  OrchestratorBindingReader,
  SessionLookupPort,
  WorkerResultSnapshot,
  WorkerTruthQueryPort,
} from "./session/session-ports.js";

export const AgentNotificationsReadParamsSchema = z.object({
  actorSessionId: z.uuid(),
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(NOTIFICATION_LIMITS.drainPageMax).default(NOTIFICATION_LIMITS.drainPageMax),
  acknowledgeThrough: z.number().int().nonnegative().optional(),
  kinds: z.array(NotificationKindSchema).optional(),
  severities: z.array(WorkerEventSeveritySchema).optional(),
  maxResultChars: z.number().int().min(200).max(4_000).default(1_200),
});

/**
 * A partial policy, spelled out rather than derived with `.partial()`: zod keeps a field's default
 * under `.partial()`, so a derived schema would fill every omitted field and a request to change
 * one knob would silently reset the other three.
 */
export const NotificationPolicyPatchSchema = z.object({
  wake: z.enum(["all", "steering-only", "off"]).optional(),
  quietMinutes: z.number().int().min(1).max(120).optional(),
  maxWakesPerHour: z.number().int().min(0).max(120).optional(),
  coalesceMs: z.number().int().min(0).max(60_000).optional(),
});

export const AgentNotificationsConfigureParamsSchema = z.object({
  actorSessionId: z.uuid(),
  policy: NotificationPolicyPatchSchema.default({}),
});

export const AgentNotificationsNoticeParamsSchema = z.object({
  actorSessionId: z.uuid(),
});

/** A settled record's embedded result: what a wait would have returned for that one target. */
export type NotificationWorkerResult = Omit<WorkerResultSnapshot, "retrieval"> & {
  retrieval: "notification" | "replay";
};

export type DrainedNotification = OrchestratorNotification & { result?: NotificationWorkerResult };

export interface NotificationsReadResult {
  notifications: DrainedNotification[];
  nextCursor: number;
  pending: number;
  dropped: number;
  policy: NotificationPolicy;
}

/** The delivery service's busy-path entry point, as the control plane sees it. */
export interface NotificationNoticePort {
  notice(controllerId: string): Promise<{ notice: Notice; text: string } | undefined>;
}

export class OrchestratorNotificationControlError extends Error {
  constructor(readonly code: "ACTOR_NOT_AUTHORIZED", message: string) {
    super(message);
    this.name = "OrchestratorNotificationControlError";
  }
}

export interface OrchestratorNotificationControlOptions {
  inbox: NotificationInboxPort;
  bindings: OrchestratorBindingReader;
  registry: SessionLookupPort & Pick<WorkerTruthQueryPort, "waitForWorkerResults">;
  /** Absent in tests that only exercise the drain; `notice` then answers nothing. */
  delivery?: NotificationNoticePort;
}

/**
 * The orchestrator-facing half of the feed: drain, policy, and the busy-path notice.
 *
 * Authority is the same binding lookup every other `agent.*` method uses, and the page is filtered
 * by the same `thread.read` check `waitForWorkers` applies, so a peer never reads a record about a
 * worker its grant does not cover. Reading, acknowledging and configuring touch nothing but the
 * inbox: no lease, no worker lifecycle, no instruction.
 */
export class OrchestratorNotificationControlPlane {
  constructor(private readonly options: OrchestratorNotificationControlOptions) {}

  async read(input: z.input<typeof AgentNotificationsReadParamsSchema>): Promise<NotificationsReadResult> {
    const request = AgentNotificationsReadParamsSchema.parse(input);
    const binding = await this.requireBinding(request.actorSessionId);
    const controllerId = orchestratorController(binding).controllerId;
    const { inbox } = this.options;
    if (request.acknowledgeThrough !== undefined) {
      await inbox.acknowledgeThrough(controllerId, request.acknowledgeThrough);
    }
    const page = inbox.listPending(controllerId, request.cursor, request.limit, {
      ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
      ...(request.severities === undefined ? {} : { severities: request.severities }),
    });
    const notifications: DrainedNotification[] = [];
    for (const record of page) {
      if (!this.readable(binding, record.sessionId)) continue;
      const result = record.kind === "settled" && record.completionTarget !== undefined
        ? await this.embedResult(record.sessionId, record.completionTarget, request.maxResultChars)
        : undefined;
      notifications.push(result === undefined ? record : { ...record, result });
    }
    return {
      notifications,
      // The cursor advances over the whole page, filtered records included: a record a peer may
      // not read is still acknowledged by its position, or the page would never move past it.
      nextCursor: page.at(-1)?.cursor ?? request.cursor,
      pending: inbox.pendingCount(controllerId),
      dropped: inbox.dropped(controllerId).sinceAcknowledged,
      policy: inbox.policy(controllerId),
    };
  }

  async configure(
    input: z.input<typeof AgentNotificationsConfigureParamsSchema>,
  ): Promise<{ policy: NotificationPolicy }> {
    const request = AgentNotificationsConfigureParamsSchema.parse(input);
    const binding = await this.requireBinding(request.actorSessionId);
    const controllerId = orchestratorController(binding).controllerId;
    const current = this.options.inbox.policy(controllerId);
    const patch = Object.fromEntries(
      Object.entries(request.policy).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(patch).length === 0) return { policy: current };
    const merged = NotificationPolicySchema.parse({ ...current, ...patch });
    return { policy: await this.options.inbox.setPolicy(controllerId, merged) };
  }

  /**
   * The piggyback answer. An unbound actor gets nothing rather than an error: this is asked after
   * every tool call, and the tool result it would decorate has already said what the binding is.
   */
  async notice(
    input: z.input<typeof AgentNotificationsNoticeParamsSchema>,
  ): Promise<{ notice?: Notice & { text: string } }> {
    const request = AgentNotificationsNoticeParamsSchema.parse(input);
    const binding = await this.options.bindings.findBySessionId(request.actorSessionId);
    if (binding === undefined || this.options.delivery === undefined) return {};
    const delivered = await this.options.delivery.notice(orchestratorController(binding).controllerId);
    return delivered === undefined ? {} : { notice: { ...delivered.notice, text: delivered.text } };
  }

  /** The key a wait acknowledges when it delivers a completed target. */
  static settledKey(sessionId: string, completionTarget?: number): string {
    return settledDedupeKey(sessionId, completionTarget);
  }

  private async requireBinding(actorSessionId: string): Promise<OrchestratorBinding> {
    const binding = await this.options.bindings.findBySessionId(actorSessionId);
    if (binding === undefined) {
      throw new OrchestratorNotificationControlError(
        "ACTOR_NOT_AUTHORIZED",
        `${actorSessionId} is not a bound Cyberdeck orchestrator`,
      );
    }
    return binding;
  }

  private readable(binding: OrchestratorBinding, sessionId: string): boolean {
    let target;
    try {
      target = this.options.registry.get(sessionId);
    } catch {
      // The worker is gone from the registry. The record was addressed to this controller when
      // the worker was its own, and nothing about a vanished session widens a grant.
      return true;
    }
    return grantAllows(binding.grant, "thread.read", target);
  }

  private async embedResult(
    sessionId: string,
    completionTarget: number,
    maxResultChars: number,
  ): Promise<NotificationWorkerResult | undefined> {
    try {
      const { results } = await this.options.registry.waitForWorkerResults(
        [{ sessionId, completionTarget }],
        0,
        maxResultChars,
      );
      const snapshot = results[0];
      if (snapshot === undefined || snapshot.status !== "completed") return undefined;
      const { retrieval, ...rest } = snapshot;
      // The completion ledger counted this delivery, so the next wait on the target replays.
      return { ...rest, retrieval: retrieval === "replay" ? "replay" : "notification" };
    } catch {
      return undefined;
    }
  }
}
