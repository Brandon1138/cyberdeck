import { z } from "zod";
import { grantAllows, type CapabilityGrant, type CyberdeckCapability } from "../domain/capability.js";
import { ProviderIdSchema, SandboxSchema, type SessionRecord } from "../domain/session.js";
import type { ThreadReadResult } from "../domain/thread.js";
import type { SessionRegistry } from "../broker/session-registry.js";
import type { OrchestratorStore } from "../persistence/orchestrator-store.js";
import type { ThreadTranscriptStore } from "../persistence/thread-transcript-store.js";

export const AgentActorParamsSchema = z.object({ actorSessionId: z.uuid() });
export const AgentReadParamsSchema = AgentActorParamsSchema.extend({
  sessionId: z.uuid(),
  afterCursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(1_000).default(200),
});
export const AgentStartWorkerParamsSchema = AgentActorParamsSchema.extend({
  provider: ProviderIdSchema,
  model: z.string().optional(),
  cwd: z.string().min(1),
  sandbox: SandboxSchema.default("read-only"),
  prompt: z.string().trim().min(1),
  name: z.string().optional(),
});

export class AgentControlError extends Error {
  constructor(readonly code: "ACTOR_NOT_AUTHORIZED" | "CAPABILITY_DENIED", message: string) {
    super(message);
    this.name = "AgentControlError";
  }
}

export class AgentControlService {
  constructor(
    private readonly registry: SessionRegistry,
    private readonly orchestrators: OrchestratorStore,
    private readonly transcripts: ThreadTranscriptStore,
  ) {}

  async listThreads(actorSessionId: string): Promise<SessionRecord[]> {
    const binding = await this.requireBinding(actorSessionId);
    this.requireCapability(
      binding.grant,
      "thread.list",
      binding.scope.kind === "workspace" ? { cwd: binding.scope.cwd } : {},
    );
    return this.registry.list().filter((record) => record.id !== actorSessionId && inScope(binding.grant.scope, record));
  }

  async readThread(
    actorSessionId: string,
    sessionId: string,
    afterCursor = 0,
    limit = 200,
  ): Promise<ThreadReadResult> {
    const binding = await this.requireBinding(actorSessionId);
    const target = this.registry.get(sessionId);
    this.requireCapability(binding.grant, "thread.read", target);
    return this.transcripts.read(sessionId, afterCursor, limit);
  }

  async startWorker(input: z.input<typeof AgentStartWorkerParamsSchema>): Promise<SessionRecord> {
    const request = AgentStartWorkerParamsSchema.parse(input);
    const binding = await this.requireBinding(request.actorSessionId);
    this.requireCapability(binding.grant, "worker.start", { cwd: request.cwd });
    return this.registry.start({
      provider: request.provider,
      ...(request.model === undefined ? {} : { model: request.model }),
      cwd: request.cwd,
      detached: true,
      sandbox: request.sandbox,
      parentSessionId: request.actorSessionId,
      kind: "worker",
      role: "worker",
      name: request.name ?? taskName(request.prompt),
    }, request.prompt);
  }

  private async requireBinding(actorSessionId: string) {
    const binding = await this.orchestrators.findBySessionId(actorSessionId);
    if (binding === undefined) {
      throw new AgentControlError("ACTOR_NOT_AUTHORIZED", "Session is not a bound Cyberdeck orchestrator");
    }
    return binding;
  }

  private requireCapability(
    grant: CapabilityGrant,
    capability: CyberdeckCapability,
    target: { sessionId?: string; cwd?: string },
  ): void {
    if (!grantAllows(grant, capability, target)) {
      throw new AgentControlError("CAPABILITY_DENIED", `${capability} is outside this orchestrator's grant`);
    }
  }
}

function inScope(scope: { kind: string; cwd?: string }, record: SessionRecord): boolean {
  return scope.kind === "fleet" || (scope.kind === "workspace" && scope.cwd === record.cwd);
}

function taskName(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  return [...normalized].slice(0, 72).join("");
}
