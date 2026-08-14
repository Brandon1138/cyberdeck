import { createInterface } from "node:readline";
import {
  DEFAULT_THREAD_PAGE,
  DEFAULT_WAIT_SECONDS,
  MAX_FANOUT_BATCH,
  MAX_THREAD_PAGE,
  MAX_WAIT_SECONDS,
  MAX_WAIT_SEGMENT_SECONDS,
} from "../limits.js";
import type { Readable, Writable } from "node:stream";
import { CANONICAL_PROVIDER_IDS } from "../domain/provider-registration.js";
import { WORKER_PROVIDER_CAPABILITIES } from "../orchestration/worker-capabilities.js";
import { CYBERDECK_VERSION } from "../version.js";

export interface McpBrokerTransport {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

/**
 * Claude Code exports the live conversation UUID into every MCP subprocess it spawns (measured
 * against 2.1.220). It is the only conversation identity the harness exposes: `initialize` carries
 * `clientInfo` alone, `tools/call` carries no session `_meta`, and MCP has no "conversation
 * changed" notification, so a server cannot re-read this value later in its own lifetime.
 */
const CONVERSATION_ENV_VAR = "CLAUDE_CODE_SESSION_ID";

const DRIFT_NOTE =
  "This MCP server was spawned for a different conversation than the one now calling it, which is what /clear produces. Cyberdeck binds the session, not the conversation, so the capability grant is unaffected — but a stale conversation is worth knowing about when results look wrong.";

export interface McpActorIdentity {
  /** The Cyberdeck session this server acts for, fixed at spawn by `--actor-session`. */
  actorSessionId: string;
  /** The provider conversation the server was spawned into, when the harness exposes one. */
  launchConversationId?: string;
  /** Reported verbatim in every failure so an operator can check the broker directly. */
  brokerSocketPath?: string;
}

export interface McpServerContext {
  identity: McpActorIdentity;
  /** Absent when the broker socket could not be reached; every tool then fails by name. */
  transport?: McpBrokerTransport;
  brokerUnavailable?: string;
}

function workerEventProperties(): Record<string, unknown> {
  return {
    eventId: { type: "string", minLength: 1, maxLength: 256 },
    summary: { type: "string", minLength: 1 },
    severity: { type: "string", enum: ["info", "warning", "error", "critical"] },
    interventionRequired: { type: "boolean" },
    structuredFacts: { type: "object", additionalProperties: true },
    evidenceRefs: { type: "array", items: { type: "string" } },
    changedAssumptions: { type: "array", items: { type: "string" } },
    recommendedAction: { type: "string" },
    continuation: {
      type: "string",
      enum: ["continuing", "blocked", "paused", "awaiting-response"],
    },
  };
}

/** Raised for a failure the server itself diagnosed, before or instead of a broker round trip. */
export class McpToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

const REMEDIES: Record<string, string> = {
  CYBERDECK_BROKER_UNREACHABLE:
    "The Cyberdeck broker is not accepting connections. Start it with `cyberdeck up`, then reconnect this server with /mcp.",
  CYBERDECK_BROKER_OUTDATED:
    "The running broker is older than this MCP server and does not implement the method it called. Rebuild, then `cyberdeck restart` — the broker runs compiled output, so a restart without a rebuild silently keeps the old build.",
  ACTOR_NOT_AUTHORIZED:
    "This session holds no Cyberdeck orchestrator binding. Call cyberdeck_diagnose for the exact state, or relaunch the orchestrator through Cyberdeck.",
  ACTOR_BINDING_ORPHANED:
    "This server's scope has been rebound to a different session. Cyberdeck will not transfer the grant, because inheriting a successor's capabilities would widen this session's authority. Relaunch this orchestrator through Cyberdeck.",
  CAPABILITY_DENIED:
    "The bound grant does not cover this call. Call cyberdeck_diagnose to see the scope and capabilities actually held.",
  STALE_THREAD_CURSOR:
    "Continue from the cursor the previous read returned instead of rereading from zero.",
  STALE_SCOUT_ARTIFACT_CURSOR:
    "Continue from the nextByte cursor returned by the previous Scout artifact read.",
  SCOUT_EGRESS_NOT_GRANTED:
    "An operator must grant this exact Git repository root with `cyberdeck scout-egress on --root <repo>`; an Orc cannot grant itself source egress.",
  NO_STABLE_CONTROLLER_IDENTITY:
    "Worker leases are held by a durable orchestrator identity, never by a conversation. This session's binding is a peer binding, so it cannot hold or inherit a lease. Act through the orchestrator bound to this workspace or fleet.",
  TRANSFER_TARGET_UNBOUND:
    "The transfer target holds no stable orchestrator binding, so it cannot receive the lease. Bind it through Cyberdeck first, then retry the transfer.",
};

export function resolveLaunchConversationId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[CONVERSATION_ENV_VAR];
  return value === undefined || value.trim() === "" ? undefined : value;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "cyberdeck_diagnose",
    description: "Report this Cyberdeck MCP server's live identity, broker reachability, and capability binding. Call this first whenever a cyberdeck_* tool appears missing or returns nothing: it distinguishes an unreachable broker, an unbound or orphaned actor session, and a stale conversation. It never fails and needs no grant.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cyberdeck_signal_exception",
    description: "Submit an idempotent EXCEPTION event. Returns compact ack only; worker continues unless continuation says otherwise.",
    inputSchema: {
      type: "object",
      properties: workerEventProperties(),
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_report_progress",
    description: "Submit coalescible worker progress. Reuse eventId only for exact retries.",
    inputSchema: {
      type: "object",
      properties: workerEventProperties(),
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_signal_risk",
    description: "Submit a bounded RISK event and receive compact ack only.",
    inputSchema: {
      type: "object",
      properties: workerEventProperties(),
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_request_decision",
    description: "Submit blocking DECISION_REQUEST with structured awaiting-response state.",
    inputSchema: {
      type: "object",
      properties: {
        ...workerEventProperties(),
        interventionRequired: { type: "boolean", const: true, default: true },
        continuation: { type: "string", const: "awaiting-response", default: "awaiting-response" },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_respond_checkpoint",
    description: "Answer one delivered checkpoint through worker event channel using its correlationId.",
    inputSchema: {
      type: "object",
      properties: {
        ...workerEventProperties(),
        correlationId: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["summary", "correlationId"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_provider_capabilities",
    description: "Return Cyberdeck's authoritative worker model IDs, effort values, and launch notes. Use this instead of inspecting repository source or guessing aliases.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...CANONICAL_PROVIDER_IDS] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_orchestrator_inspect",
    description: "Inspect another Cyberdeck Orc by durable session identity before any stop request. Returns provider/lifecycle state, process generation, binding, broker ownership, and child-worker impact. A null heartbeat is unknown, never evidence that a live target is stale.",
    inputSchema: {
      type: "object",
      properties: {
        targetSessionId: { type: "string" },
      },
      required: ["targetSessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_orchestrator_stop",
    description: "Request a broker-mediated graceful stop of an inspected stale or failed Orc. Requires the exact generation returned by inspect and never stops child workers. Healthy live Orcs return APPROVAL_REQUIRED; non-terminal children return REQUIRES_HANDOFF.",
    inputSchema: {
      type: "object",
      properties: {
        targetSessionId: { type: "string" },
        expectedGeneration: { type: "integer", minimum: 1 },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["targetSessionId", "expectedGeneration", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_orchestrator_force_stop",
    description: "Explicitly escalate a previously requested graceful Orc stop. Requires the same durable identity and observed generation; it is denied unless graceful stop is already pending. Child workers remain untouched.",
    inputSchema: {
      type: "object",
      properties: {
        targetSessionId: { type: "string" },
        expectedGeneration: { type: "integer", minimum: 1 },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["targetSessionId", "expectedGeneration", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_threads_list",
    description: `List worker threads visible to this Cyberdeck orchestrator, newest page first. Defaults to the status view (id, name, provider, executionState, attentionState), which is the cheap duplicate-safe liveness check; pass view "full" only when you need the whole record. Returns {threads, total, cursor, returned, nextCursor?}; page with cursor/limit (default ${DEFAULT_THREAD_PAGE}, max ${MAX_THREAD_PAGE}). Stays answerable while a wait is in flight. Every thread carries truth: the same worker state machine cyberdeck_workers_wait and cyberdeck_worker_events project from, so these three surfaces cannot disagree about whether a worker is working, blocked on a modal, holding unsent composer text, stalled, or terminal. truth.state is the answer to "what is this worker doing"; executionState and attentionState are process and UI facts underneath it. A thread stopped by a provider usage cap or an over-long prompt reads truth.state "provider-limit" and carries termination.kind.`,
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["status", "full"], default: "status" },
        limit: { type: "integer", minimum: 1, maximum: MAX_THREAD_PAGE, default: DEFAULT_THREAD_PAGE },
        cursor: { type: "integer", minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_thread_read",
    description: "Incrementally read semantic worker turns, not PTY write chunks. afterCursor is mandatory; continue from returned nextCursor. Prefer cyberdeck_workers_wait for normal result collection.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        afterCursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 1 },
      },
      required: ["sessionId", "afterCursor"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_scout_read",
    description:
      "Read a bounded durable Scout artifact by byte cursor. Prefer card, then evidence; use trace only for provider/transport debugging. Continue from nextByte and never reread zero. complete means current EOF; stable says the Scout can no longer append.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        artifact: { type: "string", enum: ["card", "evidence", "trace"] },
        afterByte: { type: "integer", minimum: 0 },
        maxBytes: {
          type: "integer",
          minimum: 256,
          maximum: 64 * 1024,
          default: 16 * 1024,
        },
      },
      required: ["sessionId", "artifact", "afterByte"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_worker_start",
    description: "Start one explicit worker and return sessionId/completionTarget. Set profile scout with cwd plus structured brief for enforced Tier 1 Cursor Composer read-only inspection; provider/model/sandbox/approval are then resolved by Cyberdeck. Otherwise use exact IDs: Codex gpt-5.6-luna|terra|sol; Claude haiku|sonnet|opus|fable; Cursor composer; Antigravity gemini-3.6-flash-low|medium|high with matching effort. Prefer cyberdeck_workers_start for fan-out, then cyberdeck_workers_wait.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", enum: ["scout"] },
        provider: { type: "string", enum: [...CANONICAL_PROVIDER_IDS] },
        model: { type: "string" },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max", "ultra"] },
        cwd: { type: "string" },
        sandbox: { type: "string", enum: ["read-only", "workspace-write"] },
        approvalMode: { type: "string", enum: ["prompt", "auto"] },
        prompt: { type: "string" },
        workspace: workerWorkspaceInputSchema(),
        brief: scoutBriefInputSchema(),
        leasePolicy: {
          type: "string",
          enum: ["expire-and-discard", "orphan-for-adoption"],
        },
        name: { type: "string" },
      },
      required: ["cwd"],
      oneOf: [
        {
          required: ["provider", "prompt"],
          not: { anyOf: [{ required: ["profile"] }, { required: ["brief"] }, { required: ["leasePolicy"] }] },
        },
        {
          required: ["profile", "brief"],
          properties: { profile: { const: "scout" } },
          not: {
            anyOf: ["provider", "model", "effort", "sandbox", "approvalMode", "prompt", "workspace"]
              .map((field) => ({ required: [field] })),
          },
        },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_workers_start",
    description: `Start up to ${MAX_FANOUT_BATCH} explicitly selected workers in one compact call. Each result is independently ok/error and successful results include sessionId plus completionTarget for cyberdeck_workers_wait.`,
    inputSchema: {
      type: "object",
      properties: {
        workers: {
          type: "array",
          minItems: 1,
          maxItems: MAX_FANOUT_BATCH,
          items: {
            type: "object",
            properties: {
              profile: { type: "string", enum: ["scout"] },
              provider: { type: "string", enum: [...CANONICAL_PROVIDER_IDS] },
              model: { type: "string" },
              effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max", "ultra"] },
              cwd: { type: "string" },
              sandbox: { type: "string", enum: ["read-only", "workspace-write"] },
              approvalMode: { type: "string", enum: ["prompt", "auto"] },
              prompt: { type: "string" },
              workspace: workerWorkspaceInputSchema(),
              brief: scoutBriefInputSchema(),
              leasePolicy: {
                type: "string",
                enum: ["expire-and-discard", "orphan-for-adoption"],
              },
              name: { type: "string" },
            },
            required: ["cwd"],
            oneOf: [
              {
                required: ["provider", "prompt"],
                not: { anyOf: [{ required: ["profile"] }, { required: ["brief"] }, { required: ["leasePolicy"] }] },
              },
              {
                required: ["profile", "brief"],
                properties: { profile: { const: "scout" } },
                not: {
                  anyOf: ["provider", "model", "effort", "sandbox", "approvalMode", "prompt", "workspace"]
                    .map((field) => ({ required: [field] })),
                },
              },
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["workers"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_workers_wait",
    description: `Idle inside Cyberdeck until all named workers complete, need input, fail, or the timeout expires; returns deterministic head-preserving semantic results and never raw PTY transcripts. Set settleOnIntervention to return early with wait.state "intervention-required" and bounded summaries when an awaited worker emits EXCEPTION or DECISION_REQUEST. One call blocks at most ${MAX_WAIT_SEGMENT_SECONDS}s so it always returns before an MCP client abandons it; a longer timeoutSeconds is honored across segments. Read wait.state: "settled" (every target terminal), "intervention-required" (opt-in bounded event settlement), "timed-out" (your whole timeoutSeconds elapsed), or "incomplete" (segment boundary — call again with wait.resume.waitId and the same targets). Completed results are idempotent: re-waiting the same sessionId and completionTarget replays the recorded result with retrieval "replay", which proves the work already ran and no duplicate worker is needed. A target settles only from the canonical turn for that ordinal: a turn that finished before the instruction was written can never settle it, and a composer holding unsent text is not a completed turn. Each result carries truth (the one worker state machine every surface projects from — working, blocked-modal, blocked-composer, idle, stalled, provider-limit, errored, stopped, exited, failed), completedTurns, and canonicalTurns (how many of those turns had a provider transcript behind them rather than a terminal scrape). status "provider-limit" is terminal and means the provider stopped itself on a usage cap or an over-long prompt; the process may still be alive, so it still has to be stopped.`,
    inputSchema: {
      type: "object",
      properties: {
        waitId: { type: "string" },
        targets: {
          type: "array",
          minItems: 1,
          maxItems: MAX_FANOUT_BATCH,
          items: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              completionTarget: { type: "integer", minimum: 1, default: 1 },
            },
            required: ["sessionId", "completionTarget"],
            additionalProperties: false,
          },
        },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_WAIT_SECONDS,
          default: DEFAULT_WAIT_SECONDS,
        },
        maxResultChars: { type: "integer", minimum: 200, maximum: 4000, default: 1200 },
        settleOnIntervention: { type: "boolean", default: false },
      },
      required: ["targets"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_thread_message",
    description: "Queue one complete instruction for a worker. Human control always has priority. Returns the instruction record; read its status. \"accepted\" means the broker holds it and has not tried yet; \"queued\" means delivery was attempted and refused at an unsafe boundary (holdReason: provider-modal, composer-occupied, human-controller, worker-terminal) and it will be retried automatically at the next safe one; \"rendered\" means the bytes are in the provider's input surface and expectedTurn names the turn that will answer it — it is NOT proof the provider took them; \"submitted\"/\"acknowledged\" mean the provider was observed consuming the payload; \"completed\" means the canonical turn for expectedTurn finished; \"undelivered\" means the worker reached a terminal state with the payload still unconsumed. There is no \"delivered\": never treat a return from this tool as proof the worker ran anything. To confirm the work, wait on expectedTurn with cyberdeck_workers_wait.",
    inputSchema: {
      type: "object",
      properties: {
        targetSessionId: { type: "string" },
        message: { type: "string" },
        messageId: { type: "string" },
      },
      required: ["targetSessionId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_lease",
    description: "Control worker leases. Outcome codes per worker: ACQUIRED, ALREADY_CONTROLLED, LEASE_CONFLICT (carries currentController and leaseExpiresAt), ORPHANED, NOT_ELIGIBLE, WORKER_TERMINAL, OWNERSHIP_LOST, RELEASED, TRANSFERRED. Retries with the same mutationId are idempotent. Recovery: {action:adopt, scope:all-eligible, preview:true} lists what is adoptable and what is blocked and changes nothing; preview:false adopts the eligible set all-or-nothing.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["acquire", "renew", "release", "transfer", "adopt"] },
        scope: { type: "string", enum: ["worker", "wave", "all-eligible"] },
        workerId: { type: "string", description: "Required for scope worker." },
        waveId: { type: "string", description: "Required for scope wave." },
        newControllerSessionId: { type: "string", description: "Required for transfer." },
        reason: { type: "string", minLength: 1, maxLength: 500, description: "Audited verbatim." },
        mutationId: { type: "string", description: "Reuse to retry a call idempotently." },
        preview: { type: "boolean", default: false, description: "Plan only; acquire and adopt." },
      },
      required: ["action", "scope", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_worker_ctl",
    description: "Act on a worker you hold the lease for. stop: graceful then force (force requires a prior graceful stop plus a grace period), sets a terminal state, never kills a PID. redirect: queue one complete new instruction. request_checkpoint: ask for a correlated answer at the worker's next turn boundary without cancelling its task; decisionGate:true also makes it pause before the next irreversible step. Authority failures return codes NOT_CONTROLLER, OWNERSHIP_LOST, LEASE_EXPIRED, WORKER_TERMINAL, SUBJECT_NOT_FOUND, DENIED.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["stop", "redirect", "request_checkpoint"] },
        workerId: { type: "string" },
        reason: { type: "string", minLength: 1, maxLength: 500 },
        mode: { type: "string", enum: ["graceful", "force"], default: "graceful" },
        instruction: { type: "string", description: "Required for redirect." },
        messageId: { type: "string" },
        correlationId: { type: "string", description: "Required for request_checkpoint." },
        focus: { type: "string" },
        question: { type: "string" },
        decisionGate: { type: "boolean", default: false },
      },
      required: ["action", "workerId", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_worker_events",
    description: "Read bounded worker events after a cursor, plus current per-worker state. Kinds: EXCEPTION, PROGRESS, CHECKPOINT, RISK, DECISION_REQUEST. view active (default) shows live events, unresolved shows only events still needing intervention. Continue from nextCursor; never re-read from zero. Returns state and deltas, not transcripts.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        workerId: { type: "string" },
        waveId: { type: "string" },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["EXCEPTION", "PROGRESS", "CHECKPOINT", "RISK", "DECISION_REQUEST"] },
        },
        severities: {
          type: "array",
          items: { type: "string", enum: ["info", "warning", "error", "critical"] },
        },
        view: { type: "string", enum: ["active", "unresolved", "resolved", "all"], default: "active" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_workflow_create",
    description: "Create an explicit bounded workflow. Only a bound orchestrator can do this.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        participantSessionIds: { type: "array", items: { type: "string" } },
        limits: {
          type: "object",
          properties: {
            maxMessages: { type: "integer", minimum: 1, maximum: 1000 },
            maxTurns: { type: "integer", minimum: 1, maximum: 200 },
            maxHops: { type: "integer", minimum: 0, maximum: 50 },
          },
          additionalProperties: false,
        },
      },
      required: ["name", "participantSessionIds"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_workflow_status",
    description: "List bounded workflows in which this agent is a participant.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cyberdeck_workflow_changes",
    description: "Read workflow mailbox messages after a cursor without waking another agent.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" }, afterCursor: { type: "integer", minimum: 0 } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_workflow_send",
    description: "Send a workflow message. wake defaults to false and must be explicit to prompt the target.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        targetSessionId: { type: "string" },
        text: { type: "string" },
        wake: { type: "boolean", default: false },
        messageId: { type: "string" },
        causationId: { type: "string" },
      },
      required: ["runId", "targetSessionId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_workflow_cancel",
    description: "Cancel a workflow owned by this orchestrator.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
] as const;

/** Typed worker workspace, mirroring `WorkerWorkspaceSchema`. */
function workerWorkspaceInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Where this worker's work lives. Declaring it lets Cyberdeck validate the worktree, branch, "
      + "and base before the worker starts, and grant the writable roots its provisioning mode needs.",
    properties: {
      worktreePath: { type: "string", description: "Absolute path of the worktree the worker runs in." },
      branch: { type: "string", description: "Branch the worker's commits land on." },
      baseRef: { type: "string", description: "Ref the branch was cut from and reviews diff against." },
      provisioning: {
        type: "string",
        enum: ["pre-provisioned", "worker-provisioned"],
        description:
          "pre-provisioned: the worktree already exists and is validated. worker-provisioned: the "
          + "worker runs `git worktree add`, which requires workspace-write and the repository's git "
          + "common directory in writableRoots.",
      },
      writableRoots: {
        type: "array",
        items: { type: "string" },
        maxItems: 8,
        description: "Absolute directories writable in addition to the worktree.",
      },
    },
    required: ["worktreePath", "branch", "baseRef", "provisioning"],
    additionalProperties: false,
  };
}

function scoutBriefInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      objective: { type: "string", minLength: 1, maxLength: 4_096 },
      hypothesisId: { type: "string", minLength: 1, maxLength: 120 },
      scope: {
        type: "array",
        minItems: 1,
        maxItems: 256,
        items: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      stopCondition: { type: "string", minLength: 1, maxLength: 4_096 },
      budget: {
        type: "object",
        properties: {
          maxWallClockMs: { type: "integer", minimum: 1, maximum: 86_400_000 },
          maxTokens: {
            type: "integer",
            minimum: 1,
            maximum: 10_000_000,
            deprecated: true,
            description: "Deprecated compatibility field; accepted but ignored for termination.",
          },
        },
        required: ["maxWallClockMs"],
        additionalProperties: false,
      },
    },
    required: ["objective", "scope", "questions", "stopCondition"],
    additionalProperties: false,
  };
}

export async function runMcpServer(
  context: McpServerContext,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  // Requests are dispatched concurrently and answered by id. Serializing them made a long
  // cyberdeck_workers_wait block every later call on the same stdio pipe, so the documented status
  // fallback stalled for exactly as long as the wait it was supposed to explain.
  const inFlight = new Set<Promise<void>>();
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      output.write(`${JSON.stringify(errorResponse(null, -32700, "Parse error"))}\n`);
      continue;
    }
    const pending = handleMcpRequest(context, request).then((response) => {
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    });
    inFlight.add(pending);
    void pending.finally(() => inFlight.delete(pending));
  }
  await Promise.allSettled([...inFlight]);
}

export async function handleMcpRequest(
  context: McpServerContext,
  request: JsonRpcRequest,
): Promise<Record<string, unknown> | undefined> {
  if (request.id === undefined) return undefined;
  try {
    if (request.method === "initialize") {
      return success(request.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "cyberdeck", version: CYBERDECK_VERSION },
      });
    }
    if (request.method === "ping") return success(request.id, {});
    if (request.method === "tools/list") return success(request.id, { tools: TOOLS });
    if (request.method === "tools/call") {
      const name = request.params?.name;
      const args = isRecord(request.params?.arguments) ? request.params.arguments : {};
      const result = await callTool(context, name, args);
      const content: Array<Record<string, unknown>> = [
        { type: "text", text: JSON.stringify(result) },
      ];
      // A drifted conversation does not invalidate the grant, so the call still runs; it is
      // reported alongside the result rather than swallowed, because a silent ambiguous negative
      // is the failure this whole path exists to remove.
      const drift = conversationDrift(context.identity);
      if (drift !== undefined && name !== "cyberdeck_diagnose") {
        content.push({ type: "text", text: JSON.stringify({ cyberdeckWarning: drift }) });
      }
      return success(request.id, { content });
    }
    return errorResponse(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    return success(request.id, toolFailure(context, error));
  }
}

/**
 * Every failure leaves through here with a machine-readable code, the identity the server is
 * acting under, and a remedy. An agent must be able to tell "broker down" from "orphaned scope"
 * from "wrong tool index" out of the response alone.
 *
 * The payload carries two independent contracts and neither subsumes the other. `error` answers
 * "who am I and what do I do about it" with the mapped Cyberdeck code and remedy. The
 * control-plane block below answers "what do I now know about my workers", and the answer is
 * nothing — so it reports the raw upstream code and holds `workerStateKnown` false.
 */
function toolFailure(context: McpServerContext, error: unknown): Record<string, unknown> {
  const code = failureCode(error);
  const drift = conversationDrift(context.identity);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        error: {
          code,
          message: error instanceof Error ? error.message : String(error),
          remedy: REMEDIES[code]
            ?? "Call cyberdeck_diagnose for this server's live identity, broker state, and binding.",
          actorSessionId: context.identity.actorSessionId,
          ...(context.identity.brokerSocketPath === undefined
            ? {}
            : { brokerSocketPath: context.identity.brokerSocketPath }),
          ...(drift === undefined ? {} : { conversationDrift: drift }),
        },
        ...controlPlaneFailure(error),
      }),
    }],
    isError: true,
  };
}

function failureCode(error: unknown): string {
  if (
    typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code;
    return code === "BROKER_DISCONNECTED" ? "CYBERDECK_BROKER_UNREACHABLE" : code;
  }
  return "CYBERDECK_TOOL_FAILED";
}

function conversationDrift(
  identity: McpActorIdentity,
): { code: string; actorSessionId: string; liveConversationId: string; note: string } | undefined {
  const live = identity.launchConversationId;
  // Cyberdeck launches Claude with `--session-id <session.id>`, so at spawn these are equal by
  // construction. Inequality means this server is serving a conversation Cyberdeck never bound.
  if (live === undefined || live === identity.actorSessionId) return undefined;
  return {
    code: "CYBERDECK_CONVERSATION_DRIFTED",
    actorSessionId: identity.actorSessionId,
    liveConversationId: live,
    note: DRIFT_NOTE,
  };
}

async function diagnose(context: McpServerContext): Promise<Record<string, unknown>> {
  const { identity } = context;
  const drift = conversationDrift(identity);
  let actor: unknown;
  let brokerError = context.brokerUnavailable;
  // A broker that answers but does not know this method is a version skew, not an outage. They
  // need different remedies, so the diagnosis has to keep them apart.
  let brokerStatus = context.brokerUnavailable === undefined ? "reachable" : "unreachable";
  if (context.transport !== undefined) {
    try {
      actor = await context.transport.request("agent.actor.describe", {
        actorSessionId: identity.actorSessionId,
      });
    } catch (error) {
      brokerError = error instanceof Error ? error.message : String(error);
      brokerStatus = failureCode(error) === "METHOD_NOT_FOUND" ? "outdated" : "unreachable";
    }
  }
  const actorStatus = isRecord(actor) && typeof actor.status === "string" ? actor.status : undefined;
  const status = brokerStatus === "unreachable" && brokerError !== undefined
    ? "broker-unreachable"
    : brokerStatus === "outdated"
      ? "broker-outdated"
      : actorStatus === undefined
        ? "unknown"
        : actorStatus === "bound"
          ? (drift === undefined ? "healthy" : "conversation-drifted")
          : actorStatus;
  return {
    server: { name: "cyberdeck", version: CYBERDECK_VERSION, pid: process.pid },
    status,
    actorSessionId: identity.actorSessionId,
    conversation: {
      launchConversationId: identity.launchConversationId ?? null,
      matchesActorSession: drift === undefined,
      ...(drift === undefined ? {} : { note: DRIFT_NOTE }),
    },
    broker: {
      socketPath: identity.brokerSocketPath ?? null,
      reachable: brokerStatus !== "unreachable",
      ...(brokerStatus === "outdated" ? { outdated: true } : {}),
      ...(brokerError === undefined ? {} : { error: brokerError }),
    },
    actor: actor ?? null,
    remedy: brokerStatus === "outdated"
      ? REMEDIES.CYBERDECK_BROKER_OUTDATED
      : brokerError !== undefined
        ? REMEDIES.CYBERDECK_BROKER_UNREACHABLE
        : isRecord(actor) && typeof actor.remedy === "string"
          ? actor.remedy
          : "Cyberdeck tools are resolvable. If a cyberdeck_* tool still looks missing, the harness tool index is at fault, not this server.",
  };
}

/**
 * A failed call says nothing about the workers themselves, so it is reported as its own class.
 * `worker still active` and `normal wait timeout` are ordinary results carrying wait.state; only a
 * control-plane failure arrives here, and it must never be mistaken for either.
 *
 * The code here is the raw upstream one, deliberately unmapped: `error.code` alongside it already
 * carries the Cyberdeck-facing translation, and flattening the two loses the distinction between
 * what the broker said and what the agent should do about it.
 */
function controlPlaneFailure(error: unknown): Record<string, unknown> {
  const code = typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : "CONTROL_PLANE_FAILURE";
  return {
    failure: {
      kind: "control-plane",
      code,
      message: error instanceof Error ? error.message : String(error),
    },
    workerStateKnown: false,
    guidance: "Worker state is unknown. Call cyberdeck_threads_list, or re-wait the same sessionId and completionTarget, before starting any replacement worker.",
  };
}

async function callTool(
  context: McpServerContext,
  name: unknown,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Answered before any gate: the one tool whose job is to explain why the others cannot run.
  if (name === "cyberdeck_diagnose") return diagnose(context);
  const transport = context.transport;
  if (transport === undefined) {
    throw new McpToolError(
      "CYBERDECK_BROKER_UNREACHABLE",
      context.brokerUnavailable
        ?? `Cyberdeck broker is unreachable${context.identity.brokerSocketPath === undefined ? "" : ` at ${context.identity.brokerSocketPath}`}`,
    );
  }
  const actorSessionId = context.identity.actorSessionId;
  if (name === "cyberdeck_signal_exception") {
    return transport.request("worker.event.submit", {
      workerId: actorSessionId,
      kind: "EXCEPTION",
      severity: "error",
      interventionRequired: false,
      continuation: "continuing",
      ...args,
    });
  }
  if (name === "cyberdeck_report_progress") {
    return transport.request("worker.event.submit", {
      workerId: actorSessionId,
      kind: "PROGRESS",
      severity: "info",
      interventionRequired: false,
      continuation: "continuing",
      ...args,
    });
  }
  if (name === "cyberdeck_signal_risk") {
    return transport.request("worker.event.submit", {
      workerId: actorSessionId,
      kind: "RISK",
      severity: "warning",
      interventionRequired: false,
      continuation: "continuing",
      ...args,
    });
  }
  if (name === "cyberdeck_request_decision") {
    return transport.request("worker.event.submit", {
      workerId: actorSessionId,
      kind: "DECISION_REQUEST",
      severity: "warning",
      ...args,
      interventionRequired: true,
      continuation: "awaiting-response",
    });
  }
  if (name === "cyberdeck_respond_checkpoint") {
    const { correlationId, ...event } = args;
    return transport.request("worker.event.submit", {
      workerId: actorSessionId,
      kind: "CHECKPOINT",
      severity: "info",
      interventionRequired: false,
      continuation: "continuing",
      ...event,
      checkpointCorrelationId: correlationId,
    });
  }
  if (name === "cyberdeck_provider_capabilities") {
    const provider = typeof args.provider === "string" ? args.provider : undefined;
    return provider === undefined
      ? WORKER_PROVIDER_CAPABILITIES
      : WORKER_PROVIDER_CAPABILITIES.filter((entry) => entry.provider === provider);
  }
  if (name === "cyberdeck_orchestrator_inspect") {
    return transport.request("agent.orchestrator.inspect", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_orchestrator_stop") {
    return transport.request("agent.orchestrator.stop", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_orchestrator_force_stop") {
    return transport.request("agent.orchestrator.forceStop", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_threads_list") {
    return transport.request("agent.thread.list", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_thread_read") {
    return transport.request("agent.thread.read", {
      actorSessionId,
      ...args,
      limit: args.limit ?? 1,
    });
  }
  if (name === "cyberdeck_scout_read") {
    return transport.request("agent.scout.read", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_worker_start") {
    return transport.request("agent.worker.start", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_workers_start") {
    return transport.request("agent.worker.startMany", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_workers_wait") {
    return transport.request("agent.worker.wait", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_thread_message") {
    return transport.request("agent.thread.enqueue", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_lease") {
    return transport.request("agent.lease.control", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_worker_ctl") {
    return transport.request("agent.worker.control", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_worker_events") {
    return transport.request("agent.worker.events", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_workflow_create") {
    return transport.request("agent.workflow.create", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_workflow_status") {
    return transport.request("agent.workflow.list", { actorSessionId });
  }
  if (name === "cyberdeck_workflow_changes") {
    return transport.request("agent.workflow.changes", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_workflow_send") {
    return transport.request("agent.workflow.send", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_workflow_cancel") {
    return transport.request("agent.workflow.cancel", { actorSessionId, ...args });
  }
  throw new Error(`Unknown Cyberdeck tool ${String(name)}`);
}

function success(id: string | number, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
