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
import {
  ProviderIdSchema,
  ReasoningEffortSchema,
  type ProviderId,
  type SessionRecord,
} from "../domain/session.js";
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
 * `replayed` is a durable replay's answer: the brief went with the original create and this call
 * did not touch it.
 */
export type PeerBriefDelivery =
  | { delivery: "queued"; instructionId: string }
  | { delivery: "failed"; detail: string }
  | { delivery: "replayed"; detail: string }
  | { delivery: "not-requested" };

/** What the phone can expect, per provider. Cursor orchestrators have no phone-reachable surface. */
export function peerRemoteControlNote(provider: ProviderId): string {
  switch (provider) {
    case "claude":
      return "Launched with Claude Remote Control; it appears in the operator's phone session list once its first turn starts. The broker does not observe the link itself.";
    case "codex":
      return "Launched with Codex remote control through its managed app-server; open it from the Codex app. The broker does not observe the link itself.";
    default:
      return `${provider} orchestrators have no phone-reachable surface; open this peer from Fleet on the machine.`;
  }
}

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

type ParsedCreate = z.output<typeof AgentCreateOrchestratorParamsSchema>;

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
  /**
   * One create at a time per creator. The live-peer cap is read from the binding log and the new
   * binding is written during launch, so two creates racing from one actor would both count the
   * same peers and both pass; a retry carrying the same `mutationId` while the first is still in
   * flight would start a second peer for the same intent. Queueing behind the actor's previous
   * create closes both: the second sees the first's binding, or its recorded result.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly maxLivePeers: number;

  constructor(private readonly deps: OrchestratorPeerServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.maxLivePeers = deps.maxLivePeers ?? MAX_LIVE_PEERS_PER_CREATOR;
  }

  async create(input: AgentCreateOrchestratorParams): Promise<OrchestratorCreateResult> {
    const request = AgentCreateOrchestratorParamsSchema.parse(input);
    const previous = this.inFlight.get(request.actorSessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const replayed = await this.replay(request);
      if (replayed !== undefined) return replayed;
      return this.decide(request);
    });
    this.inFlight.set(request.actorSessionId, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(request.actorSessionId) === run) this.inFlight.delete(request.actorSessionId);
    }
  }

  /**
   * A retry's answer, from memory first and the binding log second. The log is what survives a
   * broker restart or an audit write that failed after the peer was already running: the mutation
   * id is persisted on the binding at launch, so the same intent can never launch twice.
   */
  private async replay(request: ParsedCreate): Promise<OrchestratorCreateResult | undefined> {
    if (request.mutationId === undefined) return undefined;
    const recorded = this.replays.get(replayKey(request));
    if (recorded !== undefined) return { ...recorded, retrieval: "replay" };
    const bindings = await this.deps.bindings.list();
    const existing = bindings.find((binding) =>
      binding.createdBy?.sessionId === request.actorSessionId
      && binding.createdBy.mutationId === request.mutationId);
    if (existing === undefined) return undefined;
    const session = this.sessionRecord(existing.sessionId);
    const result: OrchestratorCreateResult = {
      outcome: "CREATED",
      sessionId: existing.sessionId,
      bindingKey: existing.key,
      ...(session?.name === undefined ? {} : { name: session.name }),
      provider: existing.provider,
      model: existing.model ?? request.model,
      ...(existing.effort === undefined ? {} : { effort: existing.effort }),
      scope: existing.scope,
      createdBy: request.actorSessionId,
      grant: [...existing.grant.capabilities],
      brief: {
        delivery: "replayed",
        detail: "Any brief went with the original create; read the peer thread to confirm it arrived",
      },
      remoteControl: peerRemoteControlNote(existing.provider),
      warnings: [],
      retrieval: "replay",
    };
    this.replays.set(replayKey(request), result);
    return result;
  }

  private async decide(request: ParsedCreate): Promise<OrchestratorCreateResult> {
    const actor = request.actorSessionId;
    const refusal = await this.admission(request);
    if (refusal !== undefined) return this.record(request, refusal);

    const binding = (await this.deps.bindings.findBySessionId(actor))!;
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
      ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
      capabilities,
      briefRequested: request.brief !== undefined,
    });

    let created: OrchestratorManagerResult;
    try {
      created = await this.deps.manager.createPeer({
        ...selection,
        ...(request.name === undefined ? {} : { name: request.name }),
        createdBy: {
          sessionId: actor,
          ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
        },
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
      return this.record(request, { outcome, reason, ...(code === undefined ? {} : { code }) });
    }

    // From here the peer exists. Everything below is reporting, and none of it may turn a
    // running peer into a retry that launches another: the replay is recorded before the brief
    // and the audit, and their failures are carried in the result rather than thrown.
    const warnings = [...(created.warnings ?? [])];
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
      brief: { delivery: "not-requested" },
      remoteControl: peerRemoteControlNote(created.binding.provider),
      warnings,
    };
    this.record(request, result);
    result.brief = await this.deliverBrief(actor, created.session.id, request.brief);
    try {
      await this.appendAudit("orchestrator.create.result", created.session.id, {
        actorSessionId: actor,
        targetSessionId: created.session.id,
        bindingKey: created.binding.key,
        reason: request.reason,
        outcome: "CREATED",
        brief: result.brief.delivery,
      });
    } catch (error) {
      warnings.push(`The create result could not be journaled: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }

  /** Every refusal that needs no launch, in the order a caller would want to hear about them. */
  private async admission(request: ParsedCreate): Promise<OrchestratorCreateResult | undefined> {
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
    return undefined;
  }

  private record<T extends OrchestratorCreateResult>(request: ParsedCreate, result: T): T {
    if (request.mutationId !== undefined) this.replays.set(replayKey(request), result);
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
      // The queue answers after its first delivery attempt, so a peer that already went terminal
      // comes back `undelivered` here rather than silently queued.
      if (record.status === "undelivered" || record.status === "cancelled") {
        return {
          delivery: "failed",
          detail: `The brief was ${record.status}: the peer reached a terminal state before consuming it`,
        };
      }
      return { delivery: "queued", instructionId: record.id };
    } catch (error) {
      return {
        delivery: "failed",
        detail: `${error instanceof Error ? error.message : String(error)}; the peer is running, send the brief with cyberdeck_thread_message`,
      };
    }
  }

  /**
   * Peers this creator asked for whose provider process has not ended. A binding whose session the
   * registry no longer knows was deleted by the operator, which is terminal; it is not a peer that
   * is still starting, because creates from one actor are serialized and the binding is written
   * inside the launch the registry already holds a record for.
   */
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

function replayKey(request: ParsedCreate): string {
  return `${request.actorSessionId}:${request.mutationId}`;
}
