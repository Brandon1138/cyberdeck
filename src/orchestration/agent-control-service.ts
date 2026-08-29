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
import type { BrokerEvent, BrokerEventType } from "../domain/events.js";
import { isFableModel } from "../domain/policy.js";
import {
  orchestratorController,
  orchestratorKey,
  type OrchestratorBinding,
  type OrchestratorScope,
} from "../domain/orchestrator.js";
import {
  ProviderIdSchema,
  ApprovalModeSchema,
  ReasoningEffortSchema,
  SandboxSchema,
  WorkerModeSchema,
  type SessionRecord,
} from "../domain/session.js";
import type { ThreadReadResult } from "../domain/thread.js";
import type { WorkerTruth } from "../domain/worker-truth.js";
import {
  WorkerBudgetDeclarationSchema,
  type WorkerBudgetDeclaration,
} from "../domain/worker-budget.js";
import { resolveProviderPermission } from "./permission-policy.js";
import type {
  OrchestratorBindingReader,
  ProviderPermissionPreferenceReader,
  ThreadTranscriptReader,
  WorkerPreferenceReader,
} from "./persistence-ports.js";
import { WORKER_PROVIDER_CAPABILITIES, validateWorkerSelection } from "./worker-capabilities.js";
import type { WorkerCapabilityCatalog } from "./worker-capability-catalog.js";
import {
  resolveProviderPermissionPlan,
  type PermissionResolutionFailureCode,
} from "../domain/permission-resolution.js";
import {
  WorkerWorkspaceSchema,
  validateWorkerWorkspace,
  workspaceWritableRoots,
  type WorkerWorkspaceFailureCode,
  type WorkspaceProbe,
} from "../domain/worker-workspace.js";
import {
  ScoutArtifactKindSchema,
  ScoutBriefSchema,
  WorkerLeasePolicySchema,
  scoutScopeViolation,
  type ScoutArtifactKind,
  type ScoutBrief,
  type WorkerLeasePolicy,
} from "../domain/worker-profile.js";
import { scoutDispatchPrompt } from "./worker-profiles.js";
import {
  projectWaitInterventions,
  type WaitInterventionSummary,
  type WorkerInterventionProjection,
} from "./worker-intervention-wait.js";
import {
  projectScoutWave,
  type ScoutArtifactHandles,
  type ScoutWaveDigest,
} from "./scout-wave-digest.js";
import type {
  ScoutArtifactQueryPort,
  SessionLookupPort,
  SessionProcessControlPort,
  SessionStartPort,
  WorkerTruthQueryPort,
} from "./session/session-ports.js";

export const AgentActorParamsSchema = z.object({ actorSessionId: z.uuid() });
export const AgentReadParamsSchema = AgentActorParamsSchema.extend({
  sessionId: z.uuid(),
  afterCursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(100).default(50),
});
export const AgentReadScoutArtifactParamsSchema = AgentActorParamsSchema.extend({
  sessionId: z.uuid(),
  artifact: ScoutArtifactKindSchema,
  afterByte: z.number().int().nonnegative().default(0),
  maxBytes: z.number().int().min(256).max(64 * 1024).default(16 * 1024),
});
const AgentStandardWorkerInputSchema = z.object({
  profile: z.undefined().optional(),
  brief: z.undefined().optional(),
  leasePolicy: z.undefined().optional(),
  provider: ProviderIdSchema,
  model: z.string().optional(),
  effort: ReasoningEffortSchema.optional(),
  cwd: z.string().min(1),
  sandbox: SandboxSchema.default("read-only"),
  approvalMode: ApprovalModeSchema.optional(),
  prompt: z.string().trim().min(1),
  name: z.string().optional(),
  /**
   * Where the work lives, when the dispatch knows. Declaring it lets the broker check the worktree,
   * the branch, and the base before a process exists, and lets the launch grant the writable roots
   * the declared provisioning mode needs. Omitted, the worker is validated exactly as before.
   */
  workspace: WorkerWorkspaceSchema.optional(),
  /**
   * Per-spawn override of the box `caveman-workers` default (MIK-79). Orchestrator spawns are
   * caveman by default when the operator has that box preference on; passing "normal" here opts
   * this one spawn out, e.g. a research worker the orchestrator wants to read eloquent. Composer
   * launches (Fleet's `session.start`/`session.startWithPrompt`) never consult this default at
   * all and are always "normal".
   */
  workerMode: WorkerModeSchema.optional(),
  /** Broker-owned allowance. Omission preserves unbudgeted worker behavior. */
  budget: WorkerBudgetDeclarationSchema.optional(),
});
const AgentScoutWorkerInputSchema = z.object({
  profile: z.literal("scout"),
  cwd: z.string().min(1),
  brief: ScoutBriefSchema,
  leasePolicy: WorkerLeasePolicySchema.optional(),
  name: z.string().optional(),
}).strict();
export const AgentStartWorkerParamsSchema = z.union([
  AgentActorParamsSchema.extend(AgentScoutWorkerInputSchema.shape).strict(),
  AgentActorParamsSchema.extend(AgentStandardWorkerInputSchema.shape),
]);
export const AgentStartWorkersParamsSchema = AgentActorParamsSchema.extend({
  workers: z.array(z.union([
    AgentScoutWorkerInputSchema,
    AgentStandardWorkerInputSchema,
  ])).min(1).max(MAX_FANOUT_BATCH),
});
export const AgentWaitWorkersParamsSchema = AgentActorParamsSchema.extend({
  targets: z.array(z.object({
    sessionId: z.uuid(),
    completionTarget: z.number().int().positive().default(1),
  })).min(1).max(MAX_FANOUT_BATCH),
  timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(DEFAULT_WAIT_SECONDS),
  maxResultChars: z.number().int().min(200).max(4_000).default(1_200),
  settleOnIntervention: z.boolean().optional(),
  /** Ticket from a previous segment of the same logical wait; omit to start a new one. */
  waitId: z.uuid().optional(),
});
export const AgentListThreadsParamsSchema = AgentActorParamsSchema.extend({
  view: z.enum(["status", "full"]).default("status"),
  limit: z.number().int().min(1).max(MAX_THREAD_PAGE).default(DEFAULT_THREAD_PAGE),
  cursor: z.number().int().nonnegative().default(0),
});
export const AgentInspectOrchestratorParamsSchema = AgentActorParamsSchema.extend({
  targetSessionId: z.uuid(),
});
export const AgentStopOrchestratorParamsSchema = AgentInspectOrchestratorParamsSchema.extend({
  expectedGeneration: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
});

export interface ThreadStatusRecord {
  id: string;
  name?: string;
  provider: string;
  executionState: SessionRecord["executionState"];
  attentionState?: SessionRecord["attentionState"];
  /**
   * The broker projection of what this worker is doing, identical to the one `workers_wait` settles
   * from. `executionState` and `attentionState` are inputs to it, and reading them separately is how
   * a listing came to say `active + done` about a worker a wait had already called completed.
   */
  truth?: WorkerTruth;
  /** Why the session stopped, when the provider said so itself rather than exiting. */
  termination?: SessionRecord["termination"];
}

export type ThreadFullRecord = SessionRecord & { truth?: WorkerTruth };

export interface ThreadListPage {
  view: "status" | "full";
  threads: Array<ThreadStatusRecord | ThreadFullRecord>;
  total: number;
  cursor: number;
  returned: number;
  nextCursor?: number;
}

export type OrchestratorControlOutcome =
  | "INSPECTED"
  | "STOPPED"
  | "STOP_REQUESTED"
  | "ALREADY_TERMINAL"
  | "TARGET_CHANGED"
  | "REQUIRES_HANDOFF"
  | "APPROVAL_REQUIRED"
  | "DENIED"
  | "NOT_ORCHESTRATOR";

export interface OrchestratorInspection {
  outcome: OrchestratorControlOutcome;
  targetSessionId: string;
  reason?: string;
  target?: {
    sessionId: string;
    generation: number;
    provider: string;
    executionState: SessionRecord["executionState"];
    attentionState?: SessionRecord["attentionState"];
    attachmentState: SessionRecord["attachmentState"];
    cwd: string;
    processOwnedByBroker: boolean;
    lastObservedAt: string;
    lastMeaningfulActivityAt?: string;
    stopRequestedAt?: string;
    /** MIK-55 will supply a real renewable heartbeat/lease. Null must never be treated as stale. */
    lastHeartbeatAt: null;
  };
  binding?: {
    bound: boolean;
    key?: string;
    /** Worker-control leases arrive with MIK-55; null is explicit rather than inferred. */
    controlLease: null;
  };
  impact?: {
    childCount: number;
    nonTerminalChildIds: string[];
  };
}

export interface OrchestratorStopResult extends OrchestratorInspection {
  mode: "graceful" | "force";
}

/** Why one wait call came back, independent of whether any worker is still running. */
export type WaitState =
  /** Every target reached a terminal state. Nothing is outstanding. */
  | "settled"
  /** The caller's whole `timeoutSeconds` budget elapsed. A normal timeout, not a failure. */
  | "timed-out"
  /** This transport segment ended first; the logical wait is still open and resumable. */
  | "incomplete"
  /** An awaited worker emitted an unresolved exception or decision request. */
  | "intervention-required";

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
  settleOnIntervention: boolean;
}

/** How long a finished ticket stays resolvable so a late resume gets a truthful answer. */
const WAIT_TICKET_GRACE_MS = 60_000;

export interface WorkerStartResult {
  sessionId: string;
  /**
   * Capabilities the request asked for that this provider cannot deliver. Present means the worker
   * started anyway with less than it asked for, which is the one outcome that used to be silent:
   * an automatic Codex worker stopping at an MCP approval prompt nobody was watching.
   */
  warnings?: string[];
  name: string;
  provider: string;
  model?: string;
  effort?: string;
  profile?: "scout";
  completionTarget: number;
  effectiveState?: SessionRecord["effectiveState"];
  reportPath?: string;
  artifacts?: ScoutArtifactHandles;
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
      | "ACTOR_NOT_ACTIVE"
      | "CAPABILITY_DENIED"
      | "STALE_THREAD_CURSOR"
      | "STALE_SCOUT_ARTIFACT_CURSOR"
      | "SCOUT_EGRESS_NOT_GRANTED"
      | "MODEL_ID_NOT_CANONICAL"
      | "MODEL_NOT_ADVERTISED"
      | "EFFORT_NOT_SUPPORTED"
      | "MODEL_EFFORT_MISMATCH"
      | "APPROVAL_MODE_NOT_SUPPORTED"
      | "WORKER_BUDGET_UNAVAILABLE"
      | PermissionResolutionFailureCode
      | WorkerWorkspaceFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentControlError";
  }
}

/** Durable budget registration performed before a newly launched worker can take its first turn. */
export interface WorkerBudgetRegistrationPort {
  register(input: {
    record: SessionRecord;
    name: string;
    declaration: WorkerBudgetDeclaration;
    controller: ReturnType<typeof orchestratorController>;
  }): Promise<void>;
  markLaunchFailed?(input: { workerId: string; reason: string }): Promise<void>;
}

export interface AgentControlOptions {
  /** Injected for tests; production reads the wall clock. */
  now?: () => number;
  /** Longest single transport segment. Must stay under the tightest MCP client call deadline. */
  segmentSeconds?: number;
  /** Durable broker journal used for all Orc stop decisions, including denials. */
  audit?: { append(event: BrokerEvent): Promise<void> };
  /** Minimum elapsed time between graceful request and force escalation. */
  forceStopGraceMs?: number;
  providerPermissions?: ProviderPermissionPreferenceReader;
  /** Wave 1 lease/event substrate used for opt-in intervention-aware waits. */
  workerCoordination?: WorkerInterventionProjection;
  /** Poll cadence for intervention events while a registry wait remains open. */
  interventionPollMs?: number;
  /** Durable operator-owned grant. Absence fails Scout source egress closed. */
  scoutEgress?: { allows(root: string): Promise<boolean> };
  /** Reads repositories to validate a declared worker workspace. Absent skips the git-backed checks. */
  workspaceProbe?: WorkspaceProbe;
  /**
   * What the providers currently advertise. Absent judges launches against the static fallback,
   * which will refuse a model a provider added after that catalog was written.
   */
  workerCapabilities?: WorkerCapabilityCatalog;
  /** Broker coordination substrate that owns scoped worker budgets. */
  workerBudgets?: WorkerBudgetRegistrationPort;
}

export class AgentControlService {
  private readonly threadCursors = new Map<string, number>();
  private readonly scoutArtifactCursors = new Map<string, number>();
  private readonly pendingWaits = new Map<string, PendingWait>();
  private readonly now: () => number;
  private readonly segmentSeconds: number;
  private readonly audit: AgentControlOptions["audit"];
  private readonly forceStopGraceMs: number;
  private readonly providerPermissions: ProviderPermissionPreferenceReader | undefined;
  private readonly workerCoordination: WorkerInterventionProjection | undefined;
  private readonly interventionPollMs: number;
  private readonly scoutEgress: AgentControlOptions["scoutEgress"];
  private readonly workspaceProbe: WorkspaceProbe | undefined;
  private readonly workerCapabilities: WorkerCapabilityCatalog | undefined;
  private readonly workerBudgets: WorkerBudgetRegistrationPort | undefined;

  constructor(
    private readonly registry: SessionLookupPort
      & SessionStartPort
      & SessionProcessControlPort
      & WorkerTruthQueryPort
      & ScoutArtifactQueryPort,
    private readonly orchestrators: OrchestratorBindingReader,
    private readonly transcripts: ThreadTranscriptReader,
    private readonly workerPreferences?: WorkerPreferenceReader,
    options: AgentControlOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.segmentSeconds = Math.max(1, Math.min(options.segmentSeconds ?? MAX_WAIT_SEGMENT_SECONDS, MAX_WAIT_SECONDS));
    this.audit = options.audit;
    this.forceStopGraceMs = Math.max(1_000, options.forceStopGraceMs ?? 5_000);
    this.providerPermissions = options.providerPermissions;
    this.workerCoordination = options.workerCoordination;
    this.interventionPollMs = Math.max(10, options.interventionPollMs ?? 100);
    this.scoutEgress = options.scoutEgress;
    this.workspaceProbe = options.workspaceProbe;
    this.workerCapabilities = options.workerCapabilities;
    this.workerBudgets = options.workerBudgets;
  }

  /**
   * The broker projection for a thread, or nothing when the broker holds no runtime for it.
   *
   * Every orchestrator-facing surface reads it from here, so none of them can invent its own answer.
   */
  private truthOf(sessionId: string): WorkerTruth | undefined {
    try {
      return this.registry.workerTruth(sessionId);
    } catch {
      return undefined;
    }
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
      threads: page.map((record) => {
        const truth = this.truthOf(record.id);
        return request.view === "status"
          ? statusRecord(record, truth)
          : { ...boundedRecord(record), ...(truth === undefined ? {} : { truth }) };
      }),
      total: visible.length,
      cursor: request.cursor,
      returned: page.length,
      ...(nextCursor < visible.length ? { nextCursor } : {}),
    };
  }

  async inspectOrchestrator(
    input: z.input<typeof AgentInspectOrchestratorParamsSchema>,
  ): Promise<OrchestratorInspection> {
    const request = AgentInspectOrchestratorParamsSchema.parse(input);
    const binding = await this.requireActiveBinding(request.actorSessionId);
    const target = this.sessionRecord(request.targetSessionId);
    if (target === undefined) {
      return {
        outcome: "DENIED",
        targetSessionId: request.targetSessionId,
        reason: "Target session does not exist in this broker",
      };
    }
    if (target.kind !== "orchestrator") {
      return {
        outcome: "NOT_ORCHESTRATOR",
        targetSessionId: request.targetSessionId,
        reason: "Target is not an orchestrator session",
      };
    }
    if (!grantAllows(binding.grant, "orchestrator.inspect", target)) {
      return {
        outcome: "DENIED",
        targetSessionId: request.targetSessionId,
        reason: "Target is outside this orchestrator's inspect scope",
      };
    }
    return this.orchestratorInspection(target);
  }

  async stopOrchestrator(
    input: z.input<typeof AgentStopOrchestratorParamsSchema>,
    mode: "graceful" | "force" = "graceful",
  ): Promise<OrchestratorStopResult> {
    const request = AgentStopOrchestratorParamsSchema.parse(input);
    let authorityPath:
      | "none"
      | "active-orchestrator-binding"
      | "scoped-capability-grant" = "none";
    const finish = async (
      result: Omit<OrchestratorStopResult, "mode">,
    ): Promise<OrchestratorStopResult> => {
      const completed = { ...result, mode };
      await this.appendOrchestratorAudit("orchestrator.stop.result", request.targetSessionId, {
        actorSessionId: request.actorSessionId,
        targetSessionId: request.targetSessionId,
        observedGeneration: request.expectedGeneration,
        reason: request.reason,
        mode,
        authorityPath,
        outcome: completed.outcome,
        detail: completed.reason ?? null,
      });
      return completed;
    };
    let binding: OrchestratorBinding;
    try {
      binding = await this.requireActiveBinding(request.actorSessionId);
      authorityPath = "active-orchestrator-binding";
    } catch (error) {
      return finish({
        outcome: "DENIED",
        targetSessionId: request.targetSessionId,
        reason: error instanceof Error ? error.message : "Caller is not an active orchestrator",
      });
    }
    const target = this.sessionRecord(request.targetSessionId);

    if (target === undefined) {
      return finish({
        outcome: "DENIED",
        targetSessionId: request.targetSessionId,
        reason: "Target session does not exist in this broker",
      });
    }
    if (target.kind !== "orchestrator") {
      return finish({
        outcome: "NOT_ORCHESTRATOR",
        targetSessionId: request.targetSessionId,
        reason: "Target is not an orchestrator session",
      });
    }
    if (request.actorSessionId === target.id) {
      return finish({
        outcome: "DENIED",
        targetSessionId: target.id,
        reason: "An orchestrator cannot stop itself through the peer-control tool",
      });
    }
    if (!grantAllows(binding.grant, "orchestrator.stop", target)) {
      return finish({
        outcome: "DENIED",
        targetSessionId: target.id,
        reason: "Target is outside this orchestrator's stop scope",
      });
    }
    authorityPath = "scoped-capability-grant";

    const inspection = await this.orchestratorInspection(target);
    const generation = target.generation ?? 1;
    if (request.expectedGeneration !== generation) {
      return finish({
        ...inspection,
        outcome: "TARGET_CHANGED",
        reason: `Target generation is ${generation}, not ${request.expectedGeneration}`,
      });
    }
    if ((inspection.impact?.nonTerminalChildIds.length ?? 0) > 0) {
      return finish({
        ...inspection,
        outcome: "REQUIRES_HANDOFF",
        reason: "Target still owns non-terminal workers; MIK-55 handoff is required before stopping it",
      });
    }
    if (target.exitCode !== null) {
      return finish({
        ...inspection,
        outcome: "ALREADY_TERMINAL",
        reason: "Target provider process is already terminal",
      });
    }
    if (target.executionState === "active" || target.executionState === "starting") {
      return finish({
        ...inspection,
        outcome: "APPROVAL_REQUIRED",
        reason: "Healthy live orchestrators require explicit operator authority",
      });
    }
    if (!this.registry.ownsProcess(target.id)) {
      return finish({
        ...inspection,
        outcome: "DENIED",
        reason: "Target process is not owned by this broker instance",
      });
    }
    if (mode === "force" && !this.registry.isStopRequested(target.id)) {
      return finish({
        ...inspection,
        outcome: "DENIED",
        reason: "Graceful stop must be requested before force escalation",
      });
    }
    if (mode === "force") {
      const requestedAt = this.registry.stopRequestedAt(target.id);
      const elapsed = requestedAt === undefined ? 0 : this.now() - Date.parse(requestedAt);
      if (requestedAt === undefined || !Number.isFinite(elapsed) || elapsed < this.forceStopGraceMs) {
        return finish({
          ...inspection,
          outcome: "DENIED",
          reason: `Graceful stop must remain pending for ${this.forceStopGraceMs}ms before force escalation`,
        });
      }
    }

    await this.appendOrchestratorAudit("orchestrator.stop.requested", target.id, {
      actorSessionId: request.actorSessionId,
      targetSessionId: target.id,
      observedGeneration: request.expectedGeneration,
      reason: request.reason,
      mode,
      authorityPath,
    });
    // The durable audit write above yields. Re-read every mutation-sensitive field so a stale
    // preflight cannot stop a provider process that resumed while the intent was being recorded.
    const current = this.registry.get(target.id);
    const currentInspection = await this.orchestratorInspection(current);
    if ((current.generation ?? 1) !== request.expectedGeneration) {
      return finish({
        ...currentInspection,
        outcome: "TARGET_CHANGED",
        reason: `Target changed to generation ${current.generation ?? 1} before stop execution`,
      });
    }
    if ((currentInspection.impact?.nonTerminalChildIds.length ?? 0) > 0) {
      return finish({
        ...currentInspection,
        outcome: "REQUIRES_HANDOFF",
        reason: "Target acquired non-terminal workers before stop execution",
      });
    }
    if (current.exitCode !== null) {
      return finish({
        ...currentInspection,
        outcome: "ALREADY_TERMINAL",
        reason: "Target became terminal before stop execution",
      });
    }
    if (current.executionState === "active" || current.executionState === "starting") {
      return finish({
        ...currentInspection,
        outcome: "APPROVAL_REQUIRED",
        reason: "Target became active before stop execution",
      });
    }
    if (!this.registry.ownsProcess(current.id)) {
      return finish({
        ...currentInspection,
        outcome: "DENIED",
        reason: "Target process ownership changed before stop execution",
      });
    }
    if (mode === "force" && !this.registry.isStopRequested(current.id)) {
      return finish({
        ...currentInspection,
        outcome: "TARGET_CHANGED",
        reason: "Graceful stop is no longer pending",
      });
    }

    if (mode === "force") this.registry.forceStop(current.id);
    else await this.registry.stop(current.id);
    const stopped = this.registry.get(target.id);
    return finish({
      ...await this.orchestratorInspection(stopped),
      outcome: stopped.exitCode === null ? "STOP_REQUESTED" : "STOPPED",
    });
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

  async readScoutArtifact(
    input: z.input<typeof AgentReadScoutArtifactParamsSchema>,
  ) {
    const request = AgentReadScoutArtifactParamsSchema.parse(input);
    const binding = await this.requireBinding(request.actorSessionId);
    const target = this.registry.get(request.sessionId);
    this.requireCapability(binding.grant, "thread.read", target);
    const cursorKey = [
      request.actorSessionId,
      request.sessionId,
      request.artifact,
    ].join("\u0000");
    const previous = this.scoutArtifactCursors.get(cursorKey);
    if (previous !== undefined && request.afterByte < previous) {
      throw new AgentControlError(
        "STALE_SCOUT_ARTIFACT_CURSOR",
        `Scout ${request.sessionId} ${request.artifact} artifact was already read through byte ${previous}; continue from that byte cursor`,
      );
    }
    const result = await this.registry.readScoutArtifact(
      request.sessionId,
      request.artifact,
      request.afterByte,
      request.maxBytes,
    );
    this.scoutArtifactCursors.set(cursorKey, Math.max(previous ?? 0, result.nextByte));
    return {
      ...result,
      handle: scoutArtifactHandle(request.sessionId, request.artifact),
      stable: target.exitCode !== null,
      ...(target.scout?.terminalState === undefined
        ? {}
        : { terminalState: target.scout.terminalState }),
    };
  }

  async startWorker(input: z.input<typeof AgentStartWorkerParamsSchema>): Promise<WorkerStartResult> {
    const request = AgentStartWorkerParamsSchema.parse(input);
    const binding = await this.requireBinding(request.actorSessionId);
    this.requireCapability(binding.grant, "worker.start", { cwd: request.cwd });
    if (request.profile === "scout") {
      return this.startScout(request);
    }
    if (request.budget !== undefined && this.workerBudgets === undefined) {
      throw new AgentControlError(
        "WORKER_BUDGET_UNAVAILABLE",
        "Broker-owned worker budgets are unavailable for this launch",
      );
    }
    // Provider is not gated here for anyone: the capability catalog serves every provider's model
    // list to every orchestrator, so a dispatch that follows what was advertised must not bounce off
    // a switch the catalog never mentioned (MIK-96). Only Fable is gated, and the catalog says so.
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
    const approvalMode = request.approvalMode
      ?? await this.configuredApprovalMode(request.provider, request.sandbox);
    // Judged against what the providers advertise right now, which is the same set Fleet's composer
    // and `cyberdeck_provider_capabilities` are served, so an offered model can never be a refused one.
    const advertised = await this.workerCapabilities?.resolve();
    const selection = validateWorkerSelection({
      provider: request.provider,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(approvalMode === undefined ? {} : { approvalMode }),
    }, advertised ?? WORKER_PROVIDER_CAPABILITIES);
    if (!selection.ok) throw new AgentControlError(selection.code, selection.message);
    // Validation resolves as well as checks: a cyberdeck-provisioned workspace comes back naming
    // the worktree the naming policy picked and the repository it is cut from, and that resolved
    // form is what the launch is planned and recorded against.
    let workspace = request.workspace;
    if (workspace !== undefined) {
      const checked = await validateWorkerWorkspace({
        workspace,
        cwd: request.cwd,
        sandbox: request.sandbox,
        probe: this.workspaceProbe,
      });
      if (!checked.ok) throw new AgentControlError(checked.code, checked.message);
      workspace = checked.value;
    }
    const plan = resolveProviderPermissionPlan(request.provider, {
      sandbox: request.sandbox,
      approvalMode,
      writableRoots: workspaceWritableRoots(workspace),
      // Every delegated worker is started with `kind: "worker"`, which is what makes the adapters
      // inject the Cyberdeck MCP server.
      mcpInjected: true,
    });
    if (!plan.ok) throw new AgentControlError(plan.code, plan.message);
    const name = request.name ?? taskName(request.prompt);
    // Orchestrator spawns default to the box `caveman-workers` preference; an explicit
    // `workerMode` on this one spawn (e.g. "normal" for a research worker) wins over it (MIK-79).
    const workerMode = request.workerMode
      ?? ((await this.workerPreferences?.get())?.caveman === true ? "caveman" : "normal");
    const startRequest: Parameters<SessionStartPort["start"]>[0] = {
      provider: request.provider,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(approvalMode === undefined ? {} : { approvalMode }),
      cwd: request.cwd,
      detached: true,
      sandbox: request.sandbox,
      ...(workspace === undefined ? {} : { workspace }),
      parentSessionId: request.actorSessionId,
      kind: "worker",
      role: "worker",
      workerMode,
      name,
    };
    let worker: SessionRecord;
    if (request.budget === undefined) {
      worker = await this.registry.start(startRequest, request.prompt);
    } else {
      const workerBudgets = this.workerBudgets!;
      const controller = orchestratorController(binding);
      let activatedWorkerId: string | undefined;
      try {
        worker = await this.registry.start(
          startRequest,
          request.prompt,
          async (record) => {
            await workerBudgets.register({
              record,
              name,
              declaration: request.budget!,
              controller,
            });
            activatedWorkerId = record.id;
          },
        );
      } catch (error) {
        if (activatedWorkerId !== undefined) {
          await workerBudgets.markLaunchFailed?.({
            workerId: activatedWorkerId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    }
    const warnings = plan.value.shortfalls.map((shortfall) => shortfall.message);
    return {
      sessionId: worker.id,
      name,
      provider: worker.provider,
      ...(worker.model === undefined ? {} : { model: worker.model }),
      ...(worker.effort === undefined ? {} : { effort: worker.effort }),
      ...(warnings.length === 0 ? {} : { warnings }),
      completionTarget: 1,
    };
  }

  private async startScout(request: {
    actorSessionId: string;
    profile: "scout";
    cwd: string;
    brief: ScoutBrief;
    leasePolicy?: WorkerLeasePolicy | undefined;
    name?: string | undefined;
  }): Promise<WorkerStartResult> {
    validateScoutScope(request.cwd, request.brief.scope);
    let egressAllowed = false;
    let grantDetail: string | undefined;
    try {
      egressAllowed = await this.scoutEgress?.allows(request.cwd) ?? false;
    } catch (error) {
      grantDetail = error instanceof Error ? error.message : String(error);
    }
    if (!egressAllowed) {
      throw new AgentControlError(
        "SCOUT_EGRESS_NOT_GRANTED",
        [
          `Cursor Composer Scout source egress is not operator-granted for exact repository root ${request.cwd}.`,
          ...(grantDetail === undefined ? [] : [`Grant check: ${grantDetail}.`]),
          `Operator remedy: cyberdeck scout-egress on --root ${shellSingleQuote(request.cwd)}`,
        ].join(" "),
      );
    }
    const name = request.name ?? taskName(request.brief.objective);
    const leasePolicy = request.leasePolicy ?? "expire-and-discard";
    const worker = await this.registry.start({
      provider: "cursor",
      model: "composer",
      approvalMode: "auto",
      cwd: request.cwd,
      detached: true,
      sandbox: "read-only",
      parentSessionId: request.actorSessionId,
      kind: "worker",
      role: "worker",
      workerMode: "normal",
      profile: "scout",
      brief: request.brief,
      leasePolicy,
      name,
    }, scoutDispatchPrompt(request.brief));
    return {
      sessionId: worker.id,
      name,
      provider: worker.provider,
      ...(worker.model === undefined ? {} : { model: worker.model }),
      profile: "scout",
      completionTarget: 1,
      ...(worker.effectiveState === undefined ? {} : { effectiveState: worker.effectiveState }),
      ...(worker.scout === undefined ? {} : { reportPath: worker.scout.reportPath }),
      artifacts: scoutArtifactHandles(worker.id),
    };
  }

  private async configuredApprovalMode(
    provider: z.infer<typeof ProviderIdSchema>,
    sandbox: z.infer<typeof SandboxSchema>,
  ): Promise<z.infer<typeof ApprovalModeSchema> | undefined> {
    const policy = (await this.providerPermissions?.list())?.[provider];
    if (policy === undefined) return undefined;
    const resolution = resolveProviderPermission(provider, policy, sandbox);
    if (!resolution.ok) {
      throw new AgentControlError("APPROVAL_MODE_NOT_SUPPORTED", resolution.message);
    }
    return resolution.value.application.kind === "post-launch-command"
      ? "auto"
      : resolution.value.application.value;
  }

  async startWorkers(input: z.input<typeof AgentStartWorkersParamsSchema>) {
    const request = AgentStartWorkersParamsSchema.parse(input);
    return Promise.all(request.workers.map(async (worker): Promise<Record<string, unknown>> => {
      try {
        return {
          ok: true as const,
          ...await this.startWorker({ actorSessionId: request.actorSessionId, ...worker }),
        };
      } catch (error) {
        const profile = worker.profile === "scout";
        return {
          ok: false as const,
          name: worker.name ?? taskName(profile ? worker.brief.objective : worker.prompt),
          provider: profile ? "cursor" : worker.provider,
          ...(profile
            ? { model: "composer", profile: "scout" }
            : worker.model === undefined
              ? {}
              : { model: worker.model }),
          error: {
            code: errorCode(error),
            message: error instanceof Error ? error.message : String(error),
            ...(errorSessionId(error) === undefined
              ? {}
              : { sessionId: errorSessionId(error) }),
          },
        };
      }
    }));
  }

  /**
   * Waits for one logical `timeoutSeconds` budget, but never blocks a single transport call longer
   * than `segmentSeconds`. When the segment ends first the caller gets a normal structured result
   * plus a ticket, so an accepted 600-second wait is honored across calls instead of being killed
   * by an MCP client deadline the caller cannot see or configure.
   */
  async waitForWorkers(input: z.input<typeof AgentWaitWorkersParamsSchema>): Promise<{
    timedOut: boolean;
    results: Awaited<ReturnType<WorkerTruthQueryPort["waitForWorkerResults"]>>["results"];
    wait: WaitEnvelope;
    intervention?: WaitInterventionSummary;
    scoutWave?: ScoutWaveDigest;
  }> {
    const request = AgentWaitWorkersParamsSchema.parse(input);
    const binding = await this.requireBinding(request.actorSessionId);
    for (const target of request.targets) {
      const worker = this.registry.get(target.sessionId);
      this.requireCapability(binding.grant, "thread.read", worker);
    }

    const pending = this.openWait(request);
    // The deadline was derived from `openWait`'s clock read, so the remaining budget is measured
    // against that same read. A second `this.now()` here could straddle a millisecond tick and turn
    // a fresh 30-second wait into a 29_999 ms segment — the budget the caller asked for, minus a
    // scheduling artifact.
    const remainingMs = Math.max(0, pending.wait.deadlineMs - pending.nowMs);
    let segmentMs = Math.min(remainingMs, this.segmentSeconds * 1_000);
    let outcome: Awaited<ReturnType<WorkerTruthQueryPort["waitForWorkerResults"]>>;
    let intervention: WaitInterventionSummary | undefined;
    if (
      pending.wait.settleOnIntervention
      && this.workerCoordination !== undefined
      && remainingMs > 0
    ) {
      const current = await this.registry.waitForWorkerResults(
        request.targets,
        0,
        request.maxResultChars,
      );
      if (!current.timedOut) {
        outcome = current;
        segmentMs = 0;
      } else {
        intervention = projectWaitInterventions(
          this.workerCoordination,
          request.targets.map((target) => target.sessionId),
        );
        if (intervention !== undefined) {
          outcome = current;
          segmentMs = 0;
        } else {
          let servedMs = 0;
          outcome = current;
          while (servedMs < segmentMs && outcome.timedOut && intervention === undefined) {
            const sliceMs = Math.min(this.interventionPollMs, segmentMs - servedMs);
            outcome = await this.registry.waitForWorkerResults(
              request.targets,
              sliceMs,
              request.maxResultChars,
            );
            servedMs += sliceMs;
            if (!outcome.timedOut) break;
            intervention = projectWaitInterventions(
              this.workerCoordination,
              request.targets.map((target) => target.sessionId),
            );
          }
          segmentMs = servedMs;
        }
      }
    } else {
      outcome = await this.registry.waitForWorkerResults(
        request.targets,
        segmentMs,
        request.maxResultChars,
      );
    }

    const endMs = this.now();
    const remainingAfterMs = Math.max(0, pending.wait.deadlineMs - endMs);
    const state: WaitState = intervention !== undefined
      ? "intervention-required"
      : outcome.timedOut === false
      ? "settled"
      : remainingAfterMs === 0
        ? "timed-out"
        : "incomplete";
    if (state === "incomplete") {
      this.pendingWaits.set(pending.wait.waitId, pending.wait);
    } else {
      this.pendingWaits.delete(pending.wait.waitId);
    }
    const scoutEntries = outcome.results.flatMap((result) => {
      if (result.profile !== "scout") return [];
      const record = this.registry.get(result.sessionId);
      const card = this.registry.scoutDecisionCard(result.sessionId);
      return [{
        sessionId: result.sessionId,
        ...(result.name === undefined ? {} : { name: result.name }),
        ...(record.brief?.hypothesisId === undefined
          ? {}
          : { hypothesisId: record.brief.hypothesisId }),
        ...(card === undefined ? {} : { card }),
        result,
      }];
    });
    const scoutWave = scoutEntries.length === outcome.results.length
      ? projectScoutWave(scoutEntries)
      : undefined;
    return {
      // A caller that reads only this flag must never mistake a segment boundary for completion,
      // while an explicit intervention settlement is neither completion nor timeout.
      timedOut: state === "timed-out" || state === "incomplete",
      results: scoutWave?.results ?? outcome.results,
      ...(intervention === undefined ? {} : { intervention }),
      ...(scoutWave === undefined ? {} : { scoutWave: scoutWave.digest }),
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

  /**
   * Resolves the ticket for this call, expiring stale ones so a resume cannot inherit a dead clock.
   *
   * Returns the clock read it made as `nowMs`. One read answers every time question this call has —
   * which tickets are stale, when a fresh wait started, when it is due, and how much budget is left
   * — so those answers cannot disagree with each other by a tick.
   */
  private openWait(request: z.infer<typeof AgentWaitWorkersParamsSchema>): {
    wait: PendingWait;
    resumed: boolean;
    nowMs: number;
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
        return { wait: existing, resumed: true, nowMs: now };
      }
    }
    const wait: PendingWait = {
      waitId: randomUUID(),
      actorSessionId: request.actorSessionId,
      startedAtMs: now,
      deadlineMs: now + request.timeoutSeconds * 1_000,
      timeoutSeconds: request.timeoutSeconds,
      settleOnIntervention: request.settleOnIntervention === true,
    };
    return { wait, resumed: false, nowMs: now };
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

  private async requireActiveBinding(actorSessionId: string) {
    const binding = await this.requireBinding(actorSessionId);
    const actor = this.sessionRecord(actorSessionId);
    if (
      actor?.kind !== "orchestrator"
      || actor.executionState !== "active"
      || actor.exitCode !== null
    ) {
      throw new AgentControlError(
        "ACTOR_NOT_ACTIVE",
        `${actorSessionId} is not an active Cyberdeck orchestrator`,
      );
    }
    return binding;
  }

  private async orchestratorInspection(target: SessionRecord): Promise<OrchestratorInspection> {
    const targetBinding = await this.orchestrators.findBySessionId(target.id);
    const stopRequestedAt = this.registry.stopRequestedAt(target.id);
    const children = target.childIds
      .map((sessionId) => this.sessionRecord(sessionId))
      .filter((record): record is SessionRecord => record !== undefined);
    return {
      outcome: "INSPECTED",
      targetSessionId: target.id,
      target: {
        sessionId: target.id,
        generation: target.generation ?? 1,
        provider: target.provider,
        executionState: target.executionState,
        ...(target.attentionState === undefined ? {} : { attentionState: target.attentionState }),
        attachmentState: target.attachmentState,
        cwd: target.cwd,
        processOwnedByBroker: this.registry.ownsProcess(target.id),
        lastObservedAt: target.updatedAt,
        ...(target.meaningfulUpdatedAt === undefined
          ? {}
          : { lastMeaningfulActivityAt: target.meaningfulUpdatedAt }),
        ...(stopRequestedAt === undefined ? {} : { stopRequestedAt }),
        lastHeartbeatAt: null,
      },
      binding: {
        bound: targetBinding !== undefined,
        ...(targetBinding === undefined ? {} : { key: targetBinding.key }),
        controlLease: null,
      },
      impact: {
        childCount: children.length,
        nonTerminalChildIds: children.filter(({ exitCode }) => exitCode === null).map(({ id }) => id),
      },
    };
  }

  private async appendOrchestratorAudit(
    type: Extract<BrokerEventType, "orchestrator.stop.requested" | "orchestrator.stop.result">,
    sessionId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.audit?.append({
      id: randomUUID(),
      type,
      sessionId,
      occurredAt: new Date(this.now()).toISOString(),
      data,
    });
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
function statusRecord(record: SessionRecord, truth: WorkerTruth | undefined): ThreadStatusRecord {
  return {
    id: record.id,
    ...(record.name === undefined ? {} : { name: record.name }),
    provider: record.provider,
    executionState: record.executionState,
    ...(record.attentionState === undefined ? {} : { attentionState: record.attentionState }),
    ...(truth === undefined ? {} : { truth }),
    ...(record.termination === undefined ? {} : { termination: record.termination }),
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

export function scoutArtifactHandle(
  sessionId: string,
  artifact: ScoutArtifactKind,
): string {
  return `scout://${sessionId}/${artifact}`;
}

function scoutArtifactHandles(sessionId: string): ScoutArtifactHandles {
  return {
    sessionId,
    card: scoutArtifactHandle(sessionId, "card"),
    evidence: scoutArtifactHandle(sessionId, "evidence"),
    trace: scoutArtifactHandle(sessionId, "trace"),
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "WORKER_START_FAILED";
}

function errorSessionId(error: unknown): string | undefined {
  return typeof error === "object"
    && error !== null
    && "sessionId" in error
    && typeof error.sessionId === "string"
    ? error.sessionId
    : undefined;
}

function validateScoutScope(cwd: string, scope: readonly string[]): void {
  const violation = scoutScopeViolation(cwd, scope);
  if (violation !== undefined) throw new AgentControlError("CAPABILITY_DENIED", violation);
}
