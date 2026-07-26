import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_THREAD_PAGE,
  DEFAULT_WAIT_SECONDS,
  MAX_FANOUT_BATCH,
  MAX_THREAD_PAGE,
  MAX_WAIT_SECONDS,
  MAX_WAIT_SEGMENT_SECONDS,
  THREAD_PREVIEW_CHARS,
} from "../limits.js";
import { grantAllows, type CapabilityGrant, type CyberdeckCapability } from "../domain/capability.js";
import { isFableModel } from "../domain/policy.js";
import { orchestratorKey, type OrchestratorScope } from "../domain/orchestrator.js";
import {
  ProviderIdSchema,
  ApprovalModeSchema,
  ReasoningEffortSchema,
  SandboxSchema,
  type SessionRecord,
} from "../domain/session.js";
import type { ThreadReadResult } from "../domain/thread.js";
import type { SessionRegistry } from "../broker/session-registry.js";
import type { OrchestratorStore } from "../persistence/orchestrator-store.js";
import type { ThreadTranscriptStore } from "../persistence/thread-transcript-store.js";
import type { WorkerPreferenceStore } from "../persistence/worker-preference-store.js";
import { validateWorkerSelection } from "./worker-capabilities.js";

export const AgentActorParamsSchema = z.object({ actorSessionId: z.uuid() });
export const AgentReadParamsSchema = AgentActorParamsSchema.extend({
  sessionId: z.uuid(),
  afterCursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(100).default(50),
});
export const AgentStartWorkerParamsSchema = AgentActorParamsSchema.extend({
  provider: ProviderIdSchema,
  model: z.string().optional(),
  effort: ReasoningEffortSchema.optional(),
  cwd: z.string().min(1),
  sandbox: SandboxSchema.default("read-only"),
  approvalMode: ApprovalModeSchema.optional(),
  prompt: z.string().trim().min(1),
  name: z.string().optional(),
});
export const AgentStartWorkersParamsSchema = AgentActorParamsSchema.extend({
  workers: z.array(AgentStartWorkerParamsSchema.omit({ actorSessionId: true })).min(1).max(MAX_FANOUT_BATCH),
});
export const AgentWaitWorkersParamsSchema = AgentActorParamsSchema.extend({
  targets: z.array(z.object({
    sessionId: z.uuid(),
    completionTarget: z.number().int().positive().default(1),
  })).min(1).max(MAX_FANOUT_BATCH),
  timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(DEFAULT_WAIT_SECONDS),
  maxResultChars: z.number().int().min(200).max(4_000).default(1_200),
  /** Ticket from a previous segment of the same logical wait; omit to start a new one. */
  waitId: z.uuid().optional(),
});
export const AgentListThreadsParamsSchema = AgentActorParamsSchema.extend({
  view: z.enum(["status", "full"]).default("status"),
  limit: z.number().int().min(1).max(MAX_THREAD_PAGE).default(DEFAULT_THREAD_PAGE),
  cursor: z.number().int().nonnegative().default(0),
});

export interface ThreadStatusRecord {
  id: string;
  name?: string;
  provider: string;
  executionState: SessionRecord["executionState"];
  attentionState?: SessionRecord["attentionState"];
}

export interface ThreadListPage {
  view: "status" | "full";
  threads: Array<ThreadStatusRecord | SessionRecord>;
  total: number;
  cursor: number;
  returned: number;
  nextCursor?: number;
}

/** Why one wait call came back, independent of whether any worker is still running. */
export type WaitState =
  /** Every target reached a terminal state. Nothing is outstanding. */
  | "settled"
  /** The caller's whole `timeoutSeconds` budget elapsed. A normal timeout, not a failure. */
  | "timed-out"
  /** This transport segment ended first; the logical wait is still open and resumable. */
  | "incomplete";

export interface WaitEnvelope {
  waitId: string;
  state: WaitState;
  resumed: boolean;
  timeoutSeconds: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  segmentSeconds: number;
  resume?: {
    tool: "cyberdeck_workers_wait";
    waitId: string;
    reason: string;
  };
}

interface PendingWait {
  waitId: string;
  actorSessionId: string;
  startedAtMs: number;
  deadlineMs: number;
  timeoutSeconds: number;
}

/** How long a finished ticket stays resolvable so a late resume gets a truthful answer. */
const WAIT_TICKET_GRACE_MS = 60_000;

export interface WorkerStartResult {
  sessionId: string;
  name: string;
  provider: string;
  model?: string;
  effort?: string;
  completionTarget: number;
}

/**
 * Everything an orphaned or mis-scoped MCP server needs to name its own failure.
 *
 * `familyKey` is the orchestrator scope key (`fleet`, `workspace:<cwd>`) the actor session belongs
 * to. It is reported so an operator can see *who currently holds the scope*; it is deliberately not
 * a fallback authority. Re-granting a stale session the family's live grant would hand a dead
 * conversation whatever capabilities its successor was given, which widens authority rather than
 * restoring it.
 */
export interface ActorDescription {
  actorSessionId: string;
  status: "bound" | "orphaned" | "unbound" | "unknown-session";
  bound: boolean;
  familyKey?: string;
  familyHolderSessionId?: string;
  scope?: OrchestratorScope;
  capabilities?: CyberdeckCapability[];
  executionState?: string;
  remedy: string;
}

export class AgentControlError extends Error {
  constructor(
    readonly code:
      | "ACTOR_NOT_AUTHORIZED"
      | "ACTOR_BINDING_ORPHANED"
      | "CAPABILITY_DENIED"
      | "STALE_THREAD_CURSOR"
      | "MODEL_ID_NOT_CANONICAL"
      | "MODEL_NOT_ADVERTISED"
      | "EFFORT_NOT_SUPPORTED"
      | "MODEL_EFFORT_MISMATCH"
      | "APPROVAL_MODE_NOT_SUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "AgentControlError";
  }
}

export interface AgentControlOptions {
  /** Injected for tests; production reads the wall clock. */
  now?: () => number;
  /** Longest single transport segment. Must stay under the tightest MCP client call deadline. */
  segmentSeconds?: number;
}

export class AgentControlService {
  private readonly threadCursors = new Map<string, number>();
  private readonly pendingWaits = new Map<string, PendingWait>();
  private readonly now: () => number;
  private readonly segmentSeconds: number;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly orchestrators: OrchestratorStore,
    private readonly transcripts: ThreadTranscriptStore,
    private readonly workerPreferences?: WorkerPreferenceStore,
    options: AgentControlOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.segmentSeconds = Math.max(1, Math.min(options.segmentSeconds ?? MAX_WAIT_SEGMENT_SECONDS, MAX_WAIT_SECONDS));
  }

  async listThreads(input: string | z.input<typeof AgentListThreadsParamsSchema>): Promise<ThreadListPage> {
    const request = AgentListThreadsParamsSchema.parse(
      typeof input === "string" ? { actorSessionId: input } : input,
    );
    const binding = await this.requireBinding(request.actorSessionId);
    this.requireCapability(
      binding.grant,
      "thread.list",
      binding.scope.kind === "workspace" ? { cwd: binding.scope.cwd } : {},
    );
    const visible = this.registry.list().filter((record) =>
      record.id !== request.actorSessionId && inScope(binding.grant.scope, record)
    );
    const page = visible.slice(request.cursor, request.cursor + request.limit);
    const nextCursor = request.cursor + page.length;
    return {
      view: request.view,
      threads: page.map((record) => request.view === "status" ? statusRecord(record) : boundedRecord(record)),
      total: visible.length,
      cursor: request.cursor,
      returned: page.length,
      ...(nextCursor < visible.length ? { nextCursor } : {}),
    };
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
    const cursorKey = `${actorSessionId}\u0000${sessionId}`;
    const previous = this.threadCursors.get(cursorKey);
    if (previous !== undefined && afterCursor < previous) {
      throw new AgentControlError(
        "STALE_THREAD_CURSOR",
        `Thread ${sessionId} was already read through cursor ${previous}; continue from that cursor instead of rereading history`,
      );
    }
    const result = await this.transcripts.read(sessionId, afterCursor, limit);
    this.threadCursors.set(cursorKey, Math.max(previous ?? 0, result.nextCursor));
    return result;
  }

  async startWorker(input: z.input<typeof AgentStartWorkerParamsSchema>): Promise<WorkerStartResult> {
    const request = AgentStartWorkerParamsSchema.parse(input);
    const binding = await this.requireBinding(request.actorSessionId);
    this.requireCapability(binding.grant, "worker.start", { cwd: request.cwd });
    if (isFableModel(request.model) && !grantAllows(
      binding.grant,
      "worker.start.fable",
      { cwd: request.cwd },
    )) {
      throw new AgentControlError(
        "CAPABILITY_DENIED",
        "Fable workers are disabled for this orchestrator; the operator can run /fable-workers on",
      );
    }
    const selection = validateWorkerSelection({
      provider: request.provider,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.approvalMode === undefined ? {} : { approvalMode: request.approvalMode }),
    });
    if (!selection.ok) throw new AgentControlError(selection.code, selection.message);
    const name = request.name ?? taskName(request.prompt);
    const workerMode = (await this.workerPreferences?.get())?.caveman === true ? "caveman" : "normal";
    const worker = await this.registry.start({
      provider: request.provider,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.approvalMode === undefined ? {} : { approvalMode: request.approvalMode }),
      cwd: request.cwd,
      detached: true,
      sandbox: request.sandbox,
      parentSessionId: request.actorSessionId,
      kind: "worker",
      role: "worker",
      workerMode,
      name,
    }, request.prompt);
    return {
      sessionId: worker.id,
      name,
      provider: worker.provider,
      ...(worker.model === undefined ? {} : { model: worker.model }),
      ...(worker.effort === undefined ? {} : { effort: worker.effort }),
      completionTarget: 1,
    };
  }

  async startWorkers(input: z.input<typeof AgentStartWorkersParamsSchema>) {
    const request = AgentStartWorkersParamsSchema.parse(input);
    const results: Array<Record<string, unknown>> = [];
    for (const worker of request.workers) {
      try {
        results.push({
          ok: true as const,
          ...await this.startWorker({ actorSessionId: request.actorSessionId, ...worker }),
        });
      } catch (error) {
        results.push({
          ok: false as const,
          name: worker.name ?? taskName(worker.prompt),
          provider: worker.provider,
          ...(worker.model === undefined ? {} : { model: worker.model }),
          error: {
            code: errorCode(error),
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    return results;
  }

  /**
   * Waits for one logical `timeoutSeconds` budget, but never blocks a single transport call longer
   * than `segmentSeconds`. When the segment ends first the caller gets a normal structured result
   * plus a ticket, so an accepted 600-second wait is honored across calls instead of being killed
   * by an MCP client deadline the caller cannot see or configure.
   */
  async waitForWorkers(input: z.input<typeof AgentWaitWorkersParamsSchema>): Promise<{
    timedOut: boolean;
    results: Awaited<ReturnType<SessionRegistry["waitForWorkerResults"]>>["results"];
    wait: WaitEnvelope;
  }> {
    const request = AgentWaitWorkersParamsSchema.parse(input);
    const binding = await this.requireBinding(request.actorSessionId);
    for (const target of request.targets) {
      const worker = this.registry.get(target.sessionId);
      this.requireCapability(binding.grant, "thread.read", worker);
    }

    const pending = this.openWait(request);
    const startMs = this.now();
    const remainingMs = Math.max(0, pending.wait.deadlineMs - startMs);
    const segmentMs = Math.min(remainingMs, this.segmentSeconds * 1_000);
    const outcome = await this.registry.waitForWorkerResults(
      request.targets,
      segmentMs,
      request.maxResultChars,
    );

    const endMs = this.now();
    const remainingAfterMs = Math.max(0, pending.wait.deadlineMs - endMs);
    const state: WaitState = outcome.timedOut === false
      ? "settled"
      : remainingAfterMs === 0
        ? "timed-out"
        : "incomplete";
    if (state === "incomplete") {
      this.pendingWaits.set(pending.wait.waitId, pending.wait);
    } else {
      this.pendingWaits.delete(pending.wait.waitId);
    }
    return {
      // A caller that reads only this flag must never mistake a segment boundary for completion,
      // so anything short of "every target settled" reports as a timeout.
      timedOut: state !== "settled",
      results: outcome.results,
      wait: {
        waitId: pending.wait.waitId,
        state,
        resumed: pending.resumed,
        timeoutSeconds: pending.wait.timeoutSeconds,
        elapsedSeconds: Math.round((endMs - pending.wait.startedAtMs) / 1_000),
        remainingSeconds: Math.round(remainingAfterMs / 1_000),
        segmentSeconds: Math.round(segmentMs / 1_000),
        ...(state === "incomplete"
          ? {
            resume: {
              tool: "cyberdeck_workers_wait" as const,
              waitId: pending.wait.waitId,
              reason: "transport segment ended; the logical wait is still open. Call again with this waitId and the same targets.",
            },
          }
          : {}),
      },
    };
  }

  /** Resolves the ticket for this call, expiring stale ones so a resume cannot inherit a dead clock. */
  private openWait(request: z.infer<typeof AgentWaitWorkersParamsSchema>): {
    wait: PendingWait;
    resumed: boolean;
  } {
    const now = this.now();
    for (const [waitId, wait] of this.pendingWaits) {
      if (wait.deadlineMs + WAIT_TICKET_GRACE_MS < now) this.pendingWaits.delete(waitId);
    }
    if (request.waitId !== undefined) {
      const existing = this.pendingWaits.get(request.waitId);
      if (existing !== undefined) {
        if (existing.actorSessionId !== request.actorSessionId) {
          throw new AgentControlError(
            "ACTOR_NOT_AUTHORIZED",
            `Wait ${request.waitId} belongs to another orchestrator`,
          );
        }
        return { wait: existing, resumed: true };
      }
    }
    const wait: PendingWait = {
      waitId: randomUUID(),
      actorSessionId: request.actorSessionId,
      startedAtMs: now,
      deadlineMs: now + request.timeoutSeconds * 1_000,
      timeoutSeconds: request.timeoutSeconds,
    };
    return { wait, resumed: false };
  }

  /**
   * Late-bound answer to "who am I and may I still act", resolved per request against the live
   * binding registry rather than anything the caller captured at spawn. The MCP server cannot
   * observe its own conversation identity — Claude Code 2.1.220 sends no session identifier in any
   * MCP request — so the authoritative half of that question has to be answered here.
   */
  async describeActor(actorSessionId: string): Promise<ActorDescription> {
    const binding = await this.orchestrators.findBySessionId(actorSessionId);
    const record = this.sessionRecord(actorSessionId);
    if (binding !== undefined) {
      return {
        actorSessionId,
        status: "bound",
        bound: true,
        familyKey: binding.key,
        familyHolderSessionId: binding.sessionId,
        scope: binding.scope,
        capabilities: binding.grant.capabilities,
        ...(record === undefined ? {} : { executionState: record.executionState }),
        remedy: "No action required; this actor holds a live Cyberdeck orchestrator binding.",
      };
    }
    if (record === undefined) {
      return {
        actorSessionId,
        status: "unknown-session",
        bound: false,
        remedy:
          `No Cyberdeck session ${actorSessionId} exists in this broker. The MCP server was spawned for a session this broker does not own — relaunch the orchestrator through Cyberdeck.`,
      };
    }
    const familyKey = actorFamilyKey(record);
    if (familyKey !== undefined) {
      const family = await this.orchestrators.get(familyKey);
      if (family !== undefined && family.sessionId !== actorSessionId) {
        return {
          actorSessionId,
          status: "orphaned",
          bound: false,
          familyKey,
          familyHolderSessionId: family.sessionId,
          executionState: record.executionState,
          remedy:
            `Scope ${familyKey} is now bound to session ${family.sessionId}, not ${actorSessionId}. This server's grant was not transferred, because inheriting a successor's capabilities would widen this session's authority. Relaunch this orchestrator through Cyberdeck.`,
        };
      }
    }
    return {
      actorSessionId,
      status: "unbound",
      bound: false,
      ...(familyKey === undefined ? {} : { familyKey }),
      executionState: record.executionState,
      remedy:
        `Session ${actorSessionId} exists but holds no orchestrator binding. Bind it with \`cyberdeck cockpit\`, or run Cyberdeck tools from a session Cyberdeck launched as an orchestrator.`,
    };
  }

  private async requireBinding(actorSessionId: string) {
    const binding = await this.orchestrators.findBySessionId(actorSessionId);
    if (binding !== undefined) return binding;
    // A bare "not authorized" cannot be told apart from "server not registered" or "wrong tool
    // index" by the agent reading it, which is what turned two separate incidents into whole
    // sessions of blind debugging. Name the actual state and the way out.
    const description = await this.describeActor(actorSessionId);
    throw new AgentControlError(
      description.status === "orphaned" ? "ACTOR_BINDING_ORPHANED" : "ACTOR_NOT_AUTHORIZED",
      `${actorSessionId} is not a bound Cyberdeck orchestrator (${description.status}). ${description.remedy}`,
    );
  }

  private sessionRecord(sessionId: string): SessionRecord | undefined {
    try {
      return this.registry.get(sessionId);
    } catch {
      return undefined;
    }
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

/**
 * The scope key an orchestrator session belongs to, derived live from its own record rather than
 * from anything baked into the MCP server's argv. A family key carried in argv is a second copy of
 * authority state that goes stale exactly the way the session UUID does.
 */
function actorFamilyKey(record: SessionRecord): string | undefined {
  if (record.orchestratorScope === "fleet") return orchestratorKey({ kind: "fleet" });
  if (record.orchestratorScope === "workspace") {
    return orchestratorKey({ kind: "workspace", cwd: record.cwd });
  }
  return undefined;
}

/** Everything a liveness or duplicate-safety check needs, and nothing that grows with transcript size. */
function statusRecord(record: SessionRecord): ThreadStatusRecord {
  return {
    id: record.id,
    ...(record.name === undefined ? {} : { name: record.name }),
    provider: record.provider,
    executionState: record.executionState,
    ...(record.attentionState === undefined ? {} : { attentionState: record.attentionState }),
  };
}

/**
 * The full view still has to fit a caller's token budget. `latestPreview` is the field that made a
 * 19-thread listing 55k characters, and `launchRecord` is spawn forensics no lister asked for.
 */
function boundedRecord(record: SessionRecord): SessionRecord {
  const { launchRecord: _launchRecord, ...rest } = record;
  return {
    ...rest,
    ...(record.latestPreview === undefined
      ? {}
      : { latestPreview: truncatePreview(record.latestPreview) }),
  };
}

function truncatePreview(preview: string): string {
  return preview.length <= THREAD_PREVIEW_CHARS
    ? preview
    : `${preview.slice(0, THREAD_PREVIEW_CHARS - 1)}…`;
}

function inScope(scope: { kind: string; cwd?: string }, record: SessionRecord): boolean {
  return scope.kind === "fleet" || (scope.kind === "workspace" && scope.cwd === record.cwd);
}

function taskName(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  return [...normalized].slice(0, 72).join("");
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "WORKER_START_FAILED";
}
