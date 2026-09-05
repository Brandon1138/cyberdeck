import { z } from "zod";
import { FleetFolderDispositionSchema, FleetLaunchProfileSchema } from "../../domain/fleet-preferences.js";
import {
  CavemanWorkersRequestSchema,
  CreateOrchestratorRequestSchema,
  EnsureOrchestratorRequestSchema,
  FableWorkersRequestSchema,
  ResetOrchestratorRequestSchema,
} from "../../domain/orchestrator.js";
import { WorkerHandoffParamsSchema } from "../../orchestration/worker-handoff-service.js";
import { fleetOrchestratorOwnership, fleetWorkerCoordinationView } from "../worker-coordination-view.js";
import {
  type BrokerMethodHandler,
  requireFleetDetaches,
  requireFleetPreferences,
  requireFleetProjects,
  requireOrchestrators,
  requireWorkerCapabilities,
  requireWorkerHandoff,
} from "./method-context.js";
import {
  FleetReattachParamsSchema,
  WorkerCapabilitiesParamsSchema,
} from "./params.js";

/** Fleet's own surface: operator preferences, the project registry, and orchestrator rosters. */
export const fleetMethods: Record<string, BrokerMethodHandler> = {
  "orchestrator.ensure": async (server, _context, frame) => {
    return requireOrchestrators(server.options).ensure(EnsureOrchestratorRequestSchema.parse(frame.params));
  },
  "orchestrator.create": async (server, _context, frame) => {
    return requireOrchestrators(server.options).create(CreateOrchestratorRequestSchema.parse(frame.params));
  },
  "orchestrator.capabilities": async (server) => {
    return requireOrchestrators(server.options).capabilities();
  },
  "orchestrator.reset": async (server, _context, frame) => {
    return requireOrchestrators(server.options).reset(ResetOrchestratorRequestSchema.parse(frame.params));
  },
  "orchestrator.get": async (server, _context, frame) => {
    const request = EnsureOrchestratorRequestSchema.pick({ cwd: true, scope: true }).parse(frame.params);
    return requireOrchestrators(server.options).get(request.cwd, request.scope);
  },
  "orchestrator.fableWorkers": async (server, _context, frame) => {
    return requireOrchestrators(server.options).fableWorkers(FableWorkersRequestSchema.parse(frame.params));
  },
  "orchestrator.cavemanWorkers": async (server, _context, frame) => {
    return requireOrchestrators(server.options).cavemanWorkers(CavemanWorkersRequestSchema.parse(frame.params));
  },
  "fleet.preferences": async (server, _context, _frame) => {
    return requireFleetPreferences(server.options).list();
  },
  "fleet.folderDispositions": async (server, _context, _frame) => {
    return requireFleetPreferences(server.options).listFolderDispositions();
  },
  "fleet.nvimLayout": async (server, _context, _frame) => {
    return requireFleetPreferences(server.options).nvimLayoutEnabled();
  },
  // The single served answer to "what can be launched". Fleet's composer and the MCP
  // capabilities tool both read it here so neither can hold a list the other does not.
  "worker.capabilities": async (server, _context, frame) => {
    const { provider } = WorkerCapabilitiesParamsSchema.parse(frame.params);
    return requireWorkerCapabilities(server.options).resolve(provider);
  },
  // Fleet's own gesture, and deliberately not an MCP tool: moving another orchestrator's
  // workers out from under it is the operator's call, not a peer's.
  "fleet.workerHandoff": async (server, _context, frame) => {
    return requireWorkerHandoff(server.options).handoff(WorkerHandoffParamsSchema.parse(frame.params));
  },
  "fleet.workerCoordination": async (server, _context, _frame) => {
    return fleetWorkerCoordinationView(server.options.workerCoordination?.listSubjects() ?? []);
  },
  "fleet.orchestratorOwnership": async (server, _context, _frame) => {
    return server.options.orchestratorBindings === undefined
      ? []
      : fleetOrchestratorOwnership(await server.options.orchestratorBindings.list());
  },
  "fleet.reattach": async (server, _context, frame) => {
    const { detachIdentity } = FleetReattachParamsSchema.parse(frame.params);
    const detachStore = requireFleetDetaches(server.options);
    const sessionId = await detachStore.latestSessionId(detachIdentity);
    if (sessionId === undefined) return { status: "none" };
    const target = server.options.registry.resolveReattachTarget(sessionId);
    if (target.status === "stale") {
      await detachStore.clear(detachIdentity, sessionId);
    }
    return target;
  },
  "fleet.preference.set": async (server, _context, frame) => {
    const request = z.object({
      cwd: z.string().startsWith("/"),
      profile: FleetLaunchProfileSchema,
    }).parse(frame.params);
    await requireFleetPreferences(server.options).set(request.cwd, request.profile);
    return { saved: true };
  },
  "fleet.folderDisposition.set": async (server, _context, frame) => {
    // The key is the Fleet list's own folder key, so the sentinel Orcs roster persists here too.
    const request = z.object({
      key: z.string().startsWith("/"),
      disposition: FleetFolderDispositionSchema,
    }).parse(frame.params);
    await requireFleetPreferences(server.options).setFolderDisposition(request.key, request.disposition);
    return { saved: true };
  },
  "fleet.nvimLayout.set": async (server, _context, frame) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(frame.params);
    await requireFleetPreferences(server.options).setNvimLayout(enabled);
    return { saved: true };
  },
  // The registry is resolved through git here rather than in the client: only the broker is
  // guaranteed to be running beside the repositories, and a path is not a project until git
  // agrees it is a repository root.
  "fleet.projects": async (server, _context, _frame) => {
    return requireFleetProjects(server.options).list();
  },
  "fleet.project.add": async (server, _context, frame) => {
    const request = z.object({
      path: z.string().startsWith("/"),
      acceptParent: z.boolean().optional(),
    }).parse(frame.params);
    return requireFleetProjects(server.options).add(request);
  },
  "fleet.project.remove": async (server, _context, frame) => {
    const request = z.object({ path: z.string().startsWith("/") }).parse(frame.params);
    return requireFleetProjects(server.options).remove(request);
  },
};
