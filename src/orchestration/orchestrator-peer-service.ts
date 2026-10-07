import { randomUUID } from "node:crypto";
import { z } from "zod";
import { grantAllows, type CyberdeckCapability } from "../domain/capability.js";
import type { BrokerEvent, BrokerEventType } from "../domain/events.js";
import type { InstructionRecord } from "../domain/instruction.js";
import {
  MAX_LIVE_PEERS_PER_CREATOR,
  peerGrantCapabilities,
  type CreatePeerOrchestratorRequest,
  type OrchestratorBinding,
  type OrchestratorScope,
} from "../domain/orchestrator.js";
import { ProviderIdSchema, ReasoningEffortSchema, type SessionRecord } from "../domain/session.js";
import type { EnqueueInstructionParamsSchema } from "./instruction-queue.js";
import type { OrchestratorManagerResult } from "./orchestrator-manager.js";
import type { OrchestratorBindingLookup } from "./persistence-ports.js";
import type { SessionLookupPort } from "./session/session-ports.js";

/** Long enough for a real brief, short enough that a transcript cannot be pasted in as one. */
export const PEER_BRIEF_MAX_CHARS = 8_000;

export const AgentCreateOrchestratorParamsSchema = z.object({
  actorSessionId: z.uuid(),
  provider: ProviderIdSchema,
  model: z.string().trim().min(1),
  effort: ReasoningEffortSchema.optional(),
  cwd: z.string().min(1),
  scope: z.enum(["workspace", "fleet"]).default("fleet"),
  name: z.string().trim().min(1).max(120).optional(),
  brief: z.string().trim().min(1).max(PEER_BRIEF_MAX_CHARS).optional(),
  reason: z.string().trim().min(1).max(500),
  mutationId: z.string().min(1).max(200).optional(),
});

export type AgentCreateOrchestratorParams = z.input<typeof AgentCreateOrchestratorParamsSchema>;

/**
 * How the brief reached the peer. `queued` is the honest ceiling: the broker holds it and will
 * deliver it at the peer's first safe boundary, which `cyberdeck_thread_read` can confirm later.
 */
export type PeerBriefDelivery =
  | { delivery: "queued"; instructionId: string }
  | { delivery: "failed"; detail: string }
  | { delivery: "not-requested" };

export const PEER_REMOTE_CONTROL_NOTE =
  "Launched with the provider's Remote Control surface; it appears in the operator's phone session list once its first turn starts. The broker does not observe the link itself.";

export type OrchestratorCreateResult =
  | {
    outcome: "CREATED";
    sessionId: string;
    bindingKey: string;
    name?: string;
    provider: string;
    model: string;
    effort?: string;
    scope: OrchestratorScope;
    createdBy: string;
    grant: CyberdeckCapability[];
    brief: PeerBriefDelivery;
    remoteControl: string;
    warnings: string[];
    retrieval?: "replay";
  }
  | {
    outcome: "DENIED" | "SELECTION_UNSUPPORTED" | "LAUNCH_FAILED";
    reason: string;
    code?: string;
    retrieval?: "replay";
  }
  | {
    outcome: "PEER_LIMIT";
    reason: string;
    livePeerIds: string[];
    limit: number;
    retrieval?: "replay";
  };

export interface OrchestratorPeerServiceDeps {
  registry: SessionLookupPort;
  bindings: OrchestratorBindingLookup & { list(): Promise<OrchestratorBinding[]> };
  manager: {
    createPeer(input: CreatePeerOrchestratorRequest): Promise<OrchestratorManagerResult>;
  };
  instructions?: {
    enqueue(input: z.input<typeof EnqueueInstructionParamsSchema>): Promise<InstructionRecord>;
  };
  audit?: { append(event: BrokerEvent): Promise<void> };
  now?: () => number;
  maxLivePeers?: number;
}

/**
 * The one path from an orchestrator's MCP tools to a new orchestrator (MIK-256).
 *
 * Policy lives here, never in the prompt: who may ask, what scope the peer may take, how many may
 * be alive at once, and what the peer is granted. The manager only launches and records what this
 * decided. Refusals are outcomes rather than thrown errors so a caller steering from a phone can
 * read them and act, the same way the stop path answers.
 */
export class OrchestratorPeerService {
  private readonly replays = new Map<string, OrchestratorCreateResult>();
  private readonly now: () => number;
  private readonly maxLivePeers: number;

  constructor(private readonly deps: OrchestratorPeerServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.maxLivePeers = deps.maxLivePeers ?? MAX_LIVE_PEERS_PER_CREATOR;
  }

  async create(input: AgentCreateOrchestratorParams): Promise<OrchestratorCreateResult> {
    const request = AgentCreateOrchestratorParamsSchema.parse(input);
    const replayKey = request.mutationId === undefined
      ? undefined
      : `${request.actorSessionId}:${request.mutationId}`;
    if (replayKey !== undefined) {
      const recorded = this.replays.get(replayKey);
      if (recorded !== undefined) return { ...recorded, retrieval: "replay" };
    }
    const result = await this.decide(request);
    if (replayKey !== undefined) this.replays.set(replayKey, result);
    return result;
  }

  private async decide(
    request: z.output<typeof AgentCreateOrchestratorParamsSchema>,
  ): Promise<OrchestratorCreateResult> {
    const actor = request.actorSessionId;
    const binding = await this.deps.bindings.findBySessionId(actor);
    if (binding === undefined) {
      return { outcome: "DENIED", code: "ACTOR_NOT_AUTHORIZED", reason: `${actor} is not a bound Cyberdeck orchestrator` };
    }
    const record = this.sessionRecord(actor);
    if (record?.kind !== "orchestrator" || record.executionState !== "active" || record.exitCode !== null) {
      return { outcome: "DENIED", code: "ACTOR_NOT_ACTIVE", reason: `${actor} is not an active Cyberdeck orchestrator` };
    }
    // `grantAllows` already narrows a workspace creator to its own cwd; the one case it cannot see
    // is a workspace creator asking for a fleet peer, whose cwd matches but whose reach does not.
    if (!grantAllows(binding.grant, "orchestrator.create", { cwd: request.cwd })) {
      return {
        outcome: "DENIED",
        code: "CAPABILITY_DENIED",
        reason: "orchestrator.create is outside this orchestrator's grant; the operator can run `cyberdeck orchestrator peer-create on`",
      };
    }
    if (binding.scope.kind === "workspace" && request.scope === "fleet") {
      return {
        outcome: "DENIED",
        code: "SCOPE_WIDENS",
        reason: `A workspace orchestrator may only create peers in its own workspace ${binding.scope.cwd}, not fleet-wide`,
      };
    }
    const livePeerIds = await this.livePeerIds(actor);
    if (livePeerIds.length >= this.maxLivePeers) {
      return {
        outcome: "PEER_LIMIT",
        reason: `${actor} already holds ${livePeerIds.length} live peer orchestrator(s); stop or wait on one before creating another`,
        livePeerIds,
        limit: this.maxLivePeers,
      };
    }

    const capabilities = peerGrantCapabilities(binding.grant.capabilities);
    const selection = {
      provider: request.provider,
      model: request.model,
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      cwd: request.cwd,
      scope: request.scope,
    };
    await this.appendAudit("orchestrator.create.requested", actor, {
      actorSessionId: actor,
      reason: request.reason,
      selection,
      ...(request.name === undefined ? {} : { name: request.name }),
      capabilities,
      briefRequested: request.brief !== undefined,
    });

    let created: OrchestratorManagerResult;
    try {
      created = await this.deps.manager.createPeer({
        ...selection,
        ...(request.name === undefined ? {} : { name: request.name }),
        createdBy: { sessionId: actor },
        capabilities,
      });
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
      const outcome = code === "ORCHESTRATOR_SELECTION_UNSUPPORTED" || code === "ORCHESTRATOR_PROVIDER_UNSUPPORTED"
        ? "SELECTION_UNSUPPORTED"
        : "LAUNCH_FAILED";
      const reason = error instanceof Error ? error.message : String(error);
      await this.appendAudit("orchestrator.create.result", actor, {
        actorSessionId: actor,
        reason: request.reason,
        outcome,
        detail: reason,
      });
      return { outcome, reason, ...(code === undefined ? {} : { code }) };
    }

    const brief = await this.deliverBrief(actor, created.session.id, request.brief);
    const result: OrchestratorCreateResult = {
      outcome: "CREATED",
      sessionId: created.session.id,
      bindingKey: created.binding.key,
      ...(created.session.name === undefined ? {} : { name: created.session.name }),
      provider: created.binding.provider,
      model: request.model,
      ...(created.binding.effort === undefined ? {} : { effort: created.binding.effort }),
      scope: created.binding.scope,
      createdBy: actor,
      grant: [...created.binding.grant.capabilities],
      brief,
      remoteControl: PEER_REMOTE_CONTROL_NOTE,
      warnings: created.warnings ?? [],
    };
    await this.appendAudit("orchestrator.create.result", created.session.id, {
      actorSessionId: actor,
      targetSessionId: created.session.id,
      bindingKey: created.binding.key,
      reason: request.reason,
      outcome: "CREATED",
      brief: brief.delivery,
    });
    return result;
  }

  private async deliverBrief(
    actor: string,
    targetSessionId: string,
    brief: string | undefined,
  ): Promise<PeerBriefDelivery> {
    if (brief === undefined) return { delivery: "not-requested" };
    if (this.deps.instructions === undefined) {
      return { delivery: "failed", detail: "Instruction queue is unavailable; send the brief with cyberdeck_thread_message" };
    }
    try {
      const record = await this.deps.instructions.enqueue({
        actorSessionId: actor,
        targetSessionId,
        message: brief,
      });
      return { delivery: "queued", instructionId: record.id };
    } catch (error) {
      return {
        delivery: "failed",
        detail: `${error instanceof Error ? error.message : String(error)}; the peer is running, send the brief with cyberdeck_thread_message`,
      };
    }
  }

  /** Peers this creator asked for whose provider process has not ended. */
  private async livePeerIds(creator: string): Promise<string[]> {
    const bindings = await this.deps.bindings.list();
    return bindings
      .filter((binding) => binding.createdBy?.sessionId === creator)
      .map((binding) => binding.sessionId)
      .filter((sessionId) => this.sessionRecord(sessionId)?.exitCode === null);
  }

  private sessionRecord(sessionId: string): SessionRecord | undefined {
    try {
      return this.deps.registry.get(sessionId);
    } catch {
      return undefined;
    }
  }

  private async appendAudit(
    type: Extract<BrokerEventType, "orchestrator.create.requested" | "orchestrator.create.result">,
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit?.append({
      id: randomUUID(),
      type,
      sessionId,
      occurredAt: new Date(this.now()).toISOString(),
      data,
    });
  }
}
