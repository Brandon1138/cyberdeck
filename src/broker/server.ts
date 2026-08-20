import { randomUUID } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import {
  AcknowledgeReportParamsSchema,
  CancelJobParamsSchema,
  GetJobParamsSchema,
  IngestReportParamsSchema,
  SubmitJobParamsSchema,
  type JobControlPlane,
} from "../control-plane/job-control-plane.js";
import type { ControlPlaneRuntime } from "../control-plane/runtime.js";
import { StartSessionRequestSchema } from "../domain/session.js";
import { ScoutEgressRequestSchema } from "../domain/worker-profile.js";
import { DelegationIntentSchema } from "../domain/delegation.js";
import {
  FleetFolderDispositionSchema,
  FleetLaunchProfileSchema,
  type FleetPreferenceStore,
} from "../persistence/fleet-preference-store.js";
import {
  FleetDetachIdentitySchema,
  type FleetDetachStore,
} from "../persistence/fleet-detach-store.js";
import type { FleetProjectService } from "./fleet-project-service.js";
import { ClientFrameSchema, type ClientFrame, type ProtocolErrorFrame, type RequestFrame } from "../protocol/frames.js";
import { encodeFrame, JsonlDecoder } from "../protocol/jsonl.js";
import { SessionSnapshotParamsSchema } from "../domain/session-snapshot.js";
import { NvimBindParamsSchema, type NvimBindingService } from "./nvim-binding-service.js";
import { RegistryError, type AttachmentMode, type SessionRegistry } from "./session-registry.js";
import type { ThreadTranscriptStore } from "../persistence/thread-transcript-store.js";
import type { WorkerPreferenceStore } from "../persistence/worker-preference-store.js";
import type { ScoutEgressGrantStore } from "../persistence/scout-egress-grant-store.js";
import type { OrchestratorManager } from "../orchestration/orchestrator-manager.js";
import type { WorkerCapabilityCatalog } from "../orchestration/worker-capability-catalog.js";
import { CANONICAL_PROVIDER_IDS } from "../domain/provider-registration.js";
import type { OrchestratorStore } from "../persistence/orchestrator-store.js";
import {
  CavemanWorkersRequestSchema,
  CreateOrchestratorRequestSchema,
  EnsureOrchestratorRequestSchema,
  FableWorkersRequestSchema,
  ResetOrchestratorRequestSchema,
} from "../domain/orchestrator.js";
import {
  AgentActorParamsSchema,
  AgentInspectOrchestratorParamsSchema,
  AgentListThreadsParamsSchema,
  AgentReadParamsSchema,
  AgentReadScoutArtifactParamsSchema,
  AgentStartWorkerParamsSchema,
  AgentStartWorkersParamsSchema,
  AgentStopOrchestratorParamsSchema,
  AgentWaitWorkersParamsSchema,
  type AgentControlService,
} from "../orchestration/agent-control-service.js";
import { EnqueueInstructionParamsSchema, type InstructionQueue } from "../orchestration/instruction-queue.js";
import {
  CreateWorkflowParamsSchema,
  SendWorkflowMessageParamsSchema,
  WorkflowActorParamsSchema,
  WorkflowChangesParamsSchema,
  WorkflowRunActorParamsSchema,
  type WorkflowService,
} from "../orchestration/workflow-service.js";
import {
  AgentLeaseParamsSchema,
  AgentWorkerControlParamsSchema,
  AgentWorkerEventsParamsSchema,
  type WorkerControlService,
} from "../orchestration/worker-control-service.js";
import {
  WorkerHandoffParamsSchema,
  type WorkerHandoffService,
} from "../orchestration/worker-handoff-service.js";
import type { WorkerCoordinationService } from "./worker-coordination.js";
import {
  WorkerCheckpointRequestParamsSchema,
  WorkerEventSubmitParamsSchema,
  type WorkerEventChannel,
} from "./worker-event-channel.js";
import {
  fleetOrchestratorOwnership,
  fleetWorkerCoordinationView,
} from "./worker-coordination-view.js";

const SessionIdParamsSchema = z.object({ sessionId: z.uuid() });
const SendParamsSchema = SessionIdParamsSchema.extend({ data: z.string() });
const SubmitParamsSchema = SessionIdParamsSchema.extend({ message: z.string().min(1) });
const RenameSessionParamsSchema = SessionIdParamsSchema.extend({ name: z.string().trim().min(1).max(120) });
const ReorderSessionParamsSchema = SessionIdParamsSchema.extend({ direction: z.enum(["up", "down"]) });
const StartSessionWithPromptParamsSchema = StartSessionRequestSchema.extend({
  initialPrompt: z.string().trim().min(1),
});
const AttachParamsSchema = SessionIdParamsSchema.extend({
  detachIdentity: FleetDetachIdentitySchema.optional(),
});
const FleetReattachParamsSchema = z.object({
  detachIdentity: FleetDetachIdentitySchema,
});
const ThreadReadParamsSchema = SessionIdParamsSchema.extend({
  afterCursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(1_000).default(200),
});
const ThreadChangesParamsSchema = z.object({
  afterCursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(2_000).default(500),
});
const WorkerCapabilitiesParamsSchema = z.object({
  provider: z.enum(CANONICAL_PROVIDER_IDS).optional(),
});

interface ConnectionContext {
  id: string;
  socket: Socket;
  attachments: Map<string, {
    mode: AttachmentMode;
    detachIdentity?: string | undefined;
  }>;
}

export interface BrokerServerOptions {
  socketPath: string;
  registry: SessionRegistry;
  transcripts?: ThreadTranscriptStore;
  orchestrators?: OrchestratorManager;
  agentControl?: AgentControlService;
  instructions?: InstructionQueue;
  workflows?: WorkflowService;
  controlPlane?: JobControlPlane;
  /** Supplies the reconciliation view; queue/budget queries work from the control plane alone. */
  controlPlaneRuntime?: Pick<ControlPlaneRuntime, "lastReconciliation">;
  fleetDetaches?: FleetDetachStore;
  fleetPreferences?: FleetPreferenceStore;
  /** Which repositories the operator calls projects. The Fleet list groups by these. */
  fleetProjects?: FleetProjectService;
  workerPreferences?: WorkerPreferenceStore;
  /**
   * What each provider currently says it can launch. One catalog serves Fleet's composer, the
   * `cyberdeck_provider_capabilities` tool, and the launch boundary, so those three cannot disagree
   * about which models exist.
   */
  workerCapabilities?: WorkerCapabilityCatalog;
  scoutEgress?: Pick<ScoutEgressGrantStore, "set" | "status">;
  orchestratorBindings?: OrchestratorStore;
  /** Internal domain substrate. Orchestrator access goes through workerControl, never directly. */
  workerCoordination?: WorkerCoordinationService;
  workerControl?: WorkerControlService;
  /** Operator-directed batch lease handoff. Fleet's surface, never an orchestrator's. */
  workerHandoff?: WorkerHandoffService;
  workerEvents?: WorkerEventChannel;
  /** Which nvim is showing which worker's worktree. In memory only, by design. */
  nvimBindings?: NvimBindingService;
  onShutdown?: () => void;
}

export class BrokerServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly snapshotCursors = new Map<string, number>();
  private listening = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: BrokerServerOptions) {
    this.server = createServer((socket) => this.accept(socket));
    options.registry.onSessionUpdate((sessionId) => {
      this.snapshotCursors.set(sessionId, this.snapshotCursor(sessionId) + 1);
    });
  }

  async listen(): Promise<void> {
    await this.prepareSocketPath();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        this.listening = true;
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.socketPath);
    });
    try {
      await chmod(this.options.socketPath, 0o600);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = (async () => {
      for (const socket of this.sockets) socket.end();
      if (this.listening) {
        await new Promise<void>((resolve) => {
          this.server.close(() => resolve());
          setTimeout(() => {
            for (const socket of this.sockets) socket.destroy();
          }, 100).unref();
        });
        this.listening = false;
      }
      await unlink(this.options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    })();
    return this.closePromise;
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const context: ConnectionContext = {
      id: randomUUID(),
      socket,
      attachments: new Map(),
    };
    const decoder = new JsonlDecoder(ClientFrameSchema);

    socket.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const frame of decoder.push(bytes)) {
        if (frame.type === "protocol-error") {
          this.send(socket, frame);
        } else {
          void this.handleFrame(context, frame);
        }
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      void this.options.registry.releaseClient(context.id);
    });
    socket.on("error", () => {
      // The close handler releases attachment leases.
    });
  }

  private async handleFrame(context: ConnectionContext, frame: ClientFrame): Promise<void> {
    if (frame.type === "request") {
      try {
        const result = await this.routeRequest(context, frame);
        this.send(context.socket, { type: "response", id: frame.id, ok: true, result });
        if (frame.method === "broker.shutdown") {
          setImmediate(() => this.options.onShutdown?.());
        }
      } catch (error) {
        this.send(context.socket, {
          type: "response",
          id: frame.id,
          ok: false,
          error: {
            code: this.errorCode(error),
            message: error instanceof Error ? error.message : "Request failed",
          },
        });
      }
      return;
    }

    try {
      const attachment = context.attachments.get(frame.sessionId);
      const mode = attachment?.mode;
      if (frame.type === "input") {
        if (mode !== "control") {
          this.sendReadOnlyError(context.socket);
          return;
        }
        await this.options.registry.write(frame.sessionId, context.id, Buffer.from(frame.data, "base64"));
        return;
      }
      if (frame.type === "resize") {
        if (mode !== "control") {
          this.sendReadOnlyError(context.socket);
          return;
        }
        this.options.registry.resize(frame.sessionId, context.id, frame.cols, frame.rows);
        return;
      }
      await this.options.registry.detach(frame.sessionId, context.id);
      context.attachments.delete(frame.sessionId);
    } catch (error) {
      this.sendProtocolFailure(context.socket, error);
    }
  }

  private async routeRequest(context: ConnectionContext, frame: RequestFrame): Promise<unknown> {
    switch (frame.method) {
      case "session.start": {
        const request = await this.withSessionWorkerMode(StartSessionRequestSchema.parse(frame.params));
        return this.options.registry.start(request);
      }
      case "session.startWithPrompt": {
        const { initialPrompt, ...request } = StartSessionWithPromptParamsSchema.parse(frame.params);
        return this.options.registry.start(await this.withSessionWorkerMode(request), initialPrompt);
      }
      case "session.list":
        return this.options.registry.list();
      case "thread.list":
        return this.options.registry.list();
      case "thread.read": {
        const { sessionId, afterCursor, limit } = ThreadReadParamsSchema.parse(frame.params);
        this.options.registry.get(sessionId);
        return this.requireTranscripts().read(sessionId, afterCursor, limit);
      }
      case "thread.changes": {
        const { afterCursor, limit } = ThreadChangesParamsSchema.parse(frame.params);
        return this.requireTranscripts().changes(afterCursor, limit);
      }
      case "orchestrator.ensure":
        return this.requireOrchestrators().ensure(EnsureOrchestratorRequestSchema.parse(frame.params));
      case "orchestrator.create":
        return this.requireOrchestrators().create(CreateOrchestratorRequestSchema.parse(frame.params));
      case "orchestrator.reset":
        return this.requireOrchestrators().reset(ResetOrchestratorRequestSchema.parse(frame.params));
      case "orchestrator.get": {
        const request = EnsureOrchestratorRequestSchema.pick({ cwd: true, scope: true }).parse(frame.params);
        return this.requireOrchestrators().get(request.cwd, request.scope);
      }
      case "orchestrator.fableWorkers":
        return this.requireOrchestrators().fableWorkers(FableWorkersRequestSchema.parse(frame.params));
      case "orchestrator.cavemanWorkers":
        return this.requireOrchestrators().cavemanWorkers(CavemanWorkersRequestSchema.parse(frame.params));
      // The client resolved the nvim address from its own tmux pane and has already drawn the
      // first list. Registering it here only buys the completion refresh, which needs an observer
      // that outlives a one-shot `cyberdeck open`.
      case "nvim.bind":
        return this.requireNvimBindings().bind(NvimBindParamsSchema.parse(frame.params));
      case "scout.egress": {
        const request = ScoutEgressRequestSchema.parse(frame.params);
        if (request.enabled !== undefined) {
          await this.requireScoutEgress().set(request.root, request.enabled);
        }
        return this.requireScoutEgress().status(request.root);
      }
      // Read-only self-description for a Cyberdeck MCP server that needs to say precisely why it
      // cannot act. It grants nothing and is deliberately answerable for an unbound actor.
      case "agent.actor.describe": {
        const { actorSessionId } = AgentActorParamsSchema.parse(frame.params);
        return this.requireAgentControl().describeActor(actorSessionId);
      }
      case "agent.orchestrator.inspect":
        return this.requireAgentControl().inspectOrchestrator(
          AgentInspectOrchestratorParamsSchema.parse(frame.params),
        );
      case "agent.orchestrator.stop":
        return this.requireAgentControl().stopOrchestrator(
          AgentStopOrchestratorParamsSchema.parse(frame.params),
          "graceful",
        );
      case "agent.orchestrator.forceStop":
        return this.requireAgentControl().stopOrchestrator(
          AgentStopOrchestratorParamsSchema.parse(frame.params),
          "force",
        );
      case "agent.thread.list":
        return this.requireAgentControl().listThreads(AgentListThreadsParamsSchema.parse(frame.params));
      case "agent.thread.read": {
        const { actorSessionId, sessionId, afterCursor, limit } = AgentReadParamsSchema.parse(frame.params);
        return this.requireAgentControl().readThread(actorSessionId, sessionId, afterCursor, limit);
      }
      case "agent.scout.read":
        return this.requireAgentControl().readScoutArtifact(
          AgentReadScoutArtifactParamsSchema.parse(frame.params),
        );
      case "agent.worker.start":
        return this.requireAgentControl().startWorker(AgentStartWorkerParamsSchema.parse(frame.params));
      case "agent.worker.startMany":
        return this.requireAgentControl().startWorkers(AgentStartWorkersParamsSchema.parse(frame.params));
      case "agent.worker.wait":
        return this.requireAgentControl().waitForWorkers(AgentWaitWorkersParamsSchema.parse(frame.params));
      case "agent.thread.enqueue":
        return this.requireInstructions().enqueue(EnqueueInstructionParamsSchema.parse(frame.params));
      case "agent.lease.control":
        return this.requireWorkerControl().lease(AgentLeaseParamsSchema.parse(frame.params));
      case "agent.worker.control":
        return this.requireWorkerControl().control(AgentWorkerControlParamsSchema.parse(frame.params));
      case "agent.worker.events":
        return this.requireWorkerControl().events(AgentWorkerEventsParamsSchema.parse(frame.params));
      case "agent.instruction.list": {
        const params = z.object({ targetSessionId: z.uuid().optional() }).parse(frame.params);
        return this.requireInstructions().list(params.targetSessionId);
      }
      case "agent.instruction.flush": {
        const { sessionId } = SessionIdParamsSchema.parse(frame.params);
        return this.requireInstructions().flush(sessionId);
      }
      case "worker.event.submit":
        return this.requireWorkerEvents().submit(WorkerEventSubmitParamsSchema.parse(frame.params));
      case "worker.checkpoint.request":
        return this.requireWorkerEvents().requestCheckpoint(
          WorkerCheckpointRequestParamsSchema.parse(frame.params),
        );
      case "agent.workflow.create":
        return this.requireWorkflows().create(CreateWorkflowParamsSchema.parse(frame.params));
      case "agent.workflow.list": {
        const { actorSessionId } = WorkflowActorParamsSchema.parse(frame.params);
        return this.requireWorkflows().list(actorSessionId);
      }
      case "agent.workflow.changes": {
        const { actorSessionId, runId, afterCursor } = WorkflowChangesParamsSchema.parse(frame.params);
        return this.requireWorkflows().changes(actorSessionId, runId, afterCursor);
      }
      case "agent.workflow.send":
        return this.requireWorkflows().send(SendWorkflowMessageParamsSchema.parse(frame.params));
      case "agent.workflow.cancel": {
        const { actorSessionId, runId } = WorkflowRunActorParamsSchema.parse(frame.params);
        return this.requireWorkflows().cancel(actorSessionId, runId, "cancelled by owner orchestrator");
      }
      case "workflow.list":
        return this.requireWorkflows().listAll();
      case "workflow.cancel": {
        const request = z.object({ runId: z.uuid(), reason: z.string().optional() }).parse(frame.params);
        return this.requireWorkflows().cancel(undefined, request.runId, request.reason);
      }
      // Read-only inspection of what the broker actually spawned. The broker is the source of
      // record: no client rebuilds a spec, so nothing here runs a provider preflight or writes.
      case "session.launchRecord": {
        const { sessionId } = SessionIdParamsSchema.parse(frame.params);
        const session = this.options.registry.get(sessionId);
        return {
          sessionId,
          provider: session.provider,
          launchRecord: this.options.registry.launchRecord(sessionId) ?? null,
        };
      }
      case "session.snapshot": {
        const { sessionId, cursor } = SessionSnapshotParamsSchema.parse(frame.params);
        if (cursor === undefined) {
          return { data: this.options.registry.snapshot(sessionId).toString("base64") };
        }
        this.options.registry.get(sessionId);
        const currentCursor = this.snapshotCursor(sessionId);
        if (cursor === currentCursor) return { cursor: currentCursor, notModified: true };
        return {
          data: this.options.registry.snapshot(sessionId).toString("base64"),
          cursor: currentCursor,
        };
      }
      case "session.stop": {
        const { sessionId } = SessionIdParamsSchema.parse(frame.params);
        return this.options.registry.stopTree(sessionId);
      }
      case "session.stopOne": {
        const { sessionId } = SessionIdParamsSchema.parse(frame.params);
        await this.options.registry.stop(sessionId);
        return { stopped: true };
      }
      case "session.resume": {
        const { sessionId } = SessionIdParamsSchema.parse(frame.params);
        return this.options.registry.resume(sessionId);
      }
      case "session.delete": {
        const { sessionId } = SessionIdParamsSchema.parse(frame.params);
        const record = this.options.registry.get(sessionId);
        await this.options.registry.delete(sessionId, async () => {
          if (record.kind === "orchestrator") {
            await this.options.orchestrators?.resetSessionBinding(sessionId);
          }
        });
        return { deleted: true };
      }
      case "session.rename": {
        const { sessionId, name } = RenameSessionParamsSchema.parse(frame.params);
        return this.options.registry.rename(sessionId, name);
      }
      case "session.togglePin": {
        const { sessionId } = SessionIdParamsSchema.parse(frame.params);
        return this.options.registry.togglePin(sessionId);
      }
      case "session.reorder": {
        const { sessionId, direction } = ReorderSessionParamsSchema.parse(frame.params);
        return this.options.registry.reorder(sessionId, direction);
      }
      case "fleet.preferences":
        return this.requireFleetPreferences().list();
      case "fleet.folderDispositions":
        return this.requireFleetPreferences().listFolderDispositions();
      case "fleet.nvimLayout":
        return this.requireFleetPreferences().nvimLayoutEnabled();
      // The single served answer to "what can be launched". Fleet's composer and the MCP
      // capabilities tool both read it here so neither can hold a list the other does not.
      case "worker.capabilities": {
        const { provider } = WorkerCapabilitiesParamsSchema.parse(frame.params);
        return this.requireWorkerCapabilities().resolve(provider);
      }
      // Fleet's own gesture, and deliberately not an MCP tool: moving another orchestrator's
      // workers out from under it is the operator's call, not a peer's.
      case "fleet.workerHandoff":
        return this.requireWorkerHandoff().handoff(WorkerHandoffParamsSchema.parse(frame.params));
      case "fleet.workerCoordination":
        return fleetWorkerCoordinationView(this.options.workerCoordination?.listSubjects() ?? []);
      case "fleet.orchestratorOwnership":
        return this.options.orchestratorBindings === undefined
          ? []
          : fleetOrchestratorOwnership(await this.options.orchestratorBindings.list());
      case "fleet.reattach": {
        const { detachIdentity } = FleetReattachParamsSchema.parse(frame.params);
        const detachStore = this.requireFleetDetaches();
        const sessionId = await detachStore.latestSessionId(detachIdentity);
        if (sessionId === undefined) return { status: "none" };
        const target = this.options.registry.resolveReattachTarget(sessionId);
        if (target.status === "stale") {
          await detachStore.clear(detachIdentity, sessionId);
        }
        return target;
      }
      case "fleet.preference.set": {
        const request = z.object({
          cwd: z.string().startsWith("/"),
          profile: FleetLaunchProfileSchema,
        }).parse(frame.params);
        await this.requireFleetPreferences().set(request.cwd, request.profile);
        return { saved: true };
      }
      case "fleet.folderDisposition.set": {
        // The key is the Fleet list's own folder key, so the sentinel Orcs roster persists here too.
        const request = z.object({
          key: z.string().startsWith("/"),
          disposition: FleetFolderDispositionSchema,
        }).parse(frame.params);
        await this.requireFleetPreferences().setFolderDisposition(request.key, request.disposition);
        return { saved: true };
      }
      case "fleet.nvimLayout.set": {
        const { enabled } = z.object({ enabled: z.boolean() }).parse(frame.params);
        await this.requireFleetPreferences().setNvimLayout(enabled);
        return { saved: true };
      }
      // The registry is resolved through git here rather than in the client: only the broker is
      // guaranteed to be running beside the repositories, and a path is not a project until git
      // agrees it is a repository root.
      case "fleet.projects":
        return this.requireFleetProjects().list();
      case "fleet.project.add": {
        const request = z.object({
          path: z.string().startsWith("/"),
          acceptParent: z.boolean().optional(),
        }).parse(frame.params);
        return this.requireFleetProjects().add(request);
      }
      case "fleet.project.remove": {
        const request = z.object({ path: z.string().startsWith("/") }).parse(frame.params);
        return this.requireFleetProjects().remove(request);
      }
      case "session.submit": {
        const { sessionId, message } = SubmitParamsSchema.parse(frame.params);
        if (context.attachments.get(sessionId)?.mode === "watch") {
          throw new RegistryError("NOT_SESSION_CONTROLLER", "Watch clients are read-only");
        }
        const clientId = context.attachments.get(sessionId)?.mode === "control" ? context.id : undefined;
        await this.options.registry.submit(sessionId, clientId, message);
        return { submitted: true };
      }
      case "session.send": {
        const { sessionId, data } = SendParamsSchema.parse(frame.params);
        if (context.attachments.get(sessionId)?.mode === "watch") {
          throw new RegistryError("NOT_SESSION_CONTROLLER", "Watch clients are read-only");
        }
        const clientId = context.attachments.get(sessionId)?.mode === "control" ? context.id : undefined;
        await this.options.registry.write(sessionId, clientId, Buffer.from(data, "base64"));
        return { sent: true };
      }
      case "session.attach": {
        const { sessionId, detachIdentity } = AttachParamsSchema.parse(frame.params);
        return this.attach(context, sessionId, "control", detachIdentity);
      }
      case "session.watch": {
        const { sessionId } = AttachParamsSchema.parse(frame.params);
        return this.attach(context, sessionId, "watch");
      }
      case "session.detach": {
        const { sessionId } = SessionIdParamsSchema.parse(frame.params);
        const attachment = context.attachments.get(sessionId);
        await this.options.registry.detach(sessionId, context.id);
        context.attachments.delete(sessionId);
        if (attachment?.mode === "control" && attachment.detachIdentity !== undefined) {
          await this.requireFleetDetaches().record(attachment.detachIdentity, sessionId);
        }
        return { detached: true };
      }
      case "job.submit": {
        const request = SubmitJobParamsSchema.parse(frame.params);
        return this.requireControlPlane().submit({
          ...request,
          request: await this.withJobWorkerMode(request.request),
        });
      }
      case "job.delegate":
      {
        const intent = DelegationIntentSchema.parse(frame.params);
        const request = intent.parentJobId === undefined
          ? await this.withJobWorkerMode(intent.request)
          : intent.request;
        return this.requireControlPlane().delegate({
          ...intent,
          request,
        });
      }
      case "job.get": {
        const { jobId } = GetJobParamsSchema.parse(frame.params);
        return this.requireControlPlane().getJob(jobId);
      }
      case "job.list":
        return this.requireControlPlane().listJobs();
      case "job.cancel": {
        const { jobId, reason } = CancelJobParamsSchema.parse(frame.params);
        return this.requireControlPlane().cancel(jobId, reason);
      }
      case "job.report": {
        const { report } = IngestReportParamsSchema.parse(frame.params);
        return this.requireControlPlane().ingestReport(report);
      }
      case "job.acknowledgeReport": {
        const { jobId } = AcknowledgeReportParamsSchema.parse(frame.params);
        return this.requireControlPlane().acknowledgeReport(jobId);
      }
      // Neutral, non-presentational control-plane queries. They return structured state only;
      // rendering, copy, and dashboards belong to the client/presentation layer.
      case "control.queue":
        return this.requireControlPlane().queueSnapshot();
      case "control.budget":
        return this.requireControlPlane().budgetReport();
      case "control.reconciliation":
        return (
          this.options.controlPlaneRuntime?.lastReconciliation() ?? {
            reconciledAt: null,
            findings: [],
            quarantinedJobIds: [],
          }
        );
      case "job.reportBacks":
        return this.requireControlPlane().listReportBacks();
      case "broker.status":
        return { healthy: true, pid: process.pid, workers: this.options.registry.workerCapacity() };
      case "broker.shutdown":
        return { shuttingDown: true };
      default:
        throw Object.assign(new Error(`Unknown method ${frame.method}`), { code: "METHOD_NOT_FOUND" });
    }
  }

  private snapshotCursor(sessionId: string): number {
    return this.snapshotCursors.get(sessionId) ?? 1;
  }

  private requireControlPlane(): JobControlPlane {
    if (this.options.controlPlane === undefined) {
      throw Object.assign(new Error("Control plane is not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.options.controlPlane;
  }

  /**
   * `session.start`/`session.startWithPrompt` is the composer path: the operator launches and
   * drives it by hand. It is always eloquent, regardless of the box `caveman-workers` preference
   * — that preference scopes orchestrator spawns (`AgentControlService.startWorker`) only
   * (MIK-79). An explicit `workerMode` on the request still wins, unchanged from before.
   */
  private withSessionWorkerMode<T extends z.infer<typeof StartSessionRequestSchema>>(request: T): T {
    if ((request.kind ?? "worker") !== "worker" || request.workerMode !== undefined) return request;
    return { ...request, workerMode: "normal" };
  }

  private async withJobWorkerMode<T extends z.infer<typeof SubmitJobParamsSchema>["request"]>(
    request: T,
  ): Promise<T> {
    if (request.workerMode !== undefined) return request;
    const preferences = await this.options.workerPreferences?.get();
    return {
      ...request,
      workerMode: preferences?.caveman === true ? "caveman" : "normal",
    };
  }

  private requireTranscripts(): ThreadTranscriptStore {
    if (this.options.transcripts === undefined) {
      throw Object.assign(new Error("Thread transcript store is not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.options.transcripts;
  }

  private requireOrchestrators(): OrchestratorManager {
    if (this.options.orchestrators === undefined) {
      throw Object.assign(new Error("Orchestrator manager is not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.options.orchestrators;
  }

  private requireAgentControl(): AgentControlService {
    if (this.options.agentControl === undefined) {
      throw Object.assign(new Error("Agent control service is not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.options.agentControl;
  }

  private requireNvimBindings(): NvimBindingService {
    if (this.options.nvimBindings === undefined) {
      throw Object.assign(new Error("nvim binding registry is not available"), {
        code: "METHOD_NOT_FOUND",
      });
    }
    return this.options.nvimBindings;
  }

  private requireScoutEgress(): Pick<ScoutEgressGrantStore, "set" | "status"> {
    if (this.options.scoutEgress === undefined) {
      throw Object.assign(new Error("Scout egress grant store is not available"), {
        code: "METHOD_NOT_FOUND",
      });
    }
    return this.options.scoutEgress;
  }

  private requireInstructions(): InstructionQueue {
    if (this.options.instructions === undefined) {
      throw Object.assign(new Error("Instruction queue is not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.options.instructions;
  }

  private requireWorkerControl(): WorkerControlService {
    if (this.options.workerControl === undefined) {
      throw Object.assign(new Error("Worker control service is not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.options.workerControl;
  }

  private requireWorkerHandoff(): WorkerHandoffService {
    if (this.options.workerHandoff === undefined) {
      throw Object.assign(new Error("Worker handoff service is not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.options.workerHandoff;
  }

  private requireWorkflows(): WorkflowService {
    if (this.options.workflows === undefined) {
      throw Object.assign(new Error("Workflow service is not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.options.workflows;
  }

  private requireWorkerEvents(): WorkerEventChannel {
    if (this.options.workerEvents === undefined) {
      throw Object.assign(new Error("Worker event channel is not available"), {
        code: "METHOD_NOT_FOUND",
      });
    }
    return this.options.workerEvents;
  }

  private requireWorkerCapabilities(): WorkerCapabilityCatalog {
    if (this.options.workerCapabilities === undefined) {
      throw Object.assign(new Error("Worker capability catalog is not available"), {
        code: "METHOD_NOT_FOUND",
      });
    }
    return this.options.workerCapabilities;
  }

  private requireFleetPreferences(): FleetPreferenceStore {
    if (this.options.fleetPreferences === undefined) {
      throw Object.assign(new Error("Fleet preferences are not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.options.fleetPreferences;
  }

  private requireFleetProjects(): FleetProjectService {
    if (this.options.fleetProjects === undefined) {
      throw Object.assign(new Error("Fleet project registry is not available"), {
        code: "METHOD_NOT_FOUND",
      });
    }
    return this.options.fleetProjects;
  }

  private requireFleetDetaches(): FleetDetachStore {
    if (this.options.fleetDetaches === undefined) {
      throw Object.assign(new Error("Fleet detach history is not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.options.fleetDetaches;
  }

  private async attach(
    context: ConnectionContext,
    sessionId: string,
    mode: AttachmentMode,
    detachIdentity?: string,
  ): Promise<unknown> {
    context.attachments.set(sessionId, { mode, detachIdentity });
    try {
      const replay = await this.options.registry.attach(
        sessionId,
        context.id,
        mode,
        (chunk) => {
          this.send(context.socket, {
            type: "output",
            sessionId,
            data: chunk.toString("base64"),
          });
        },
        (exitCode) => {
          context.attachments.delete(sessionId);
          this.send(context.socket, { type: "session-ended", sessionId, exitCode });
        },
        (failure) => {
          context.attachments.delete(sessionId);
          this.send(context.socket, {
            type: "session-failed",
            sessionId,
            code: failure.code,
            message: failure.message,
          });
        },
      );
      return { session: this.options.registry.get(sessionId), data: replay.toString("base64") };
    } catch (error) {
      context.attachments.delete(sessionId);
      throw error;
    }
  }

  private send(socket: Socket, frame: unknown): void {
    if (!socket.destroyed) socket.write(encodeFrame(frame));
  }

  private sendReadOnlyError(socket: Socket): void {
    this.send(socket, {
      type: "protocol-error",
      code: "INVALID_FRAME",
      message: "Watch clients are read-only",
    } satisfies ProtocolErrorFrame);
  }

  private sendProtocolFailure(socket: Socket, error: unknown): void {
    this.send(socket, {
      type: "protocol-error",
      code: this.errorCode(error),
      message: error instanceof Error ? error.message : "Protocol operation failed",
    } satisfies ProtocolErrorFrame);
  }

  private errorCode(error: unknown): string {
    if (error instanceof RegistryError) return error.code;
    if (error instanceof z.ZodError) return "INVALID_REQUEST";
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    return "INTERNAL_ERROR";
  }

  private async prepareSocketPath(): Promise<void> {
    const stat = await lstat(this.options.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat === undefined) return;
    if (!stat.isSocket()) {
      throw new Error(`Refusing to remove non-socket path ${this.options.socketPath}`);
    }
    if (await this.socketAcceptsConnections()) {
      throw Object.assign(new Error("A Cyberdeck broker is already running"), { code: "BROKER_ALREADY_RUNNING" });
    }
    await unlink(this.options.socketPath);
  }

  private socketAcceptsConnections(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const probe = connect(this.options.socketPath);
      const timer = setTimeout(() => {
        probe.destroy();
        reject(new Error(`Timed out probing ${this.options.socketPath}`));
      }, 500);
      probe.once("connect", () => {
        clearTimeout(timer);
        probe.destroy();
        resolve(true);
      });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        probe.destroy();
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
        else reject(error);
      });
    });
  }
}
