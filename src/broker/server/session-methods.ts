import {
  LOCAL_WORKER_CONTROL_SCHEMA_VERSION,
  LocalWorkerSnapshotRequestSchema,
  LocalWorkerSubscribeRequestSchema,
  LocalWorkerUnsubscribeRequestSchema,
  LocalWorkerUnsubscribeResultSchema,
} from "../../domain/local-worker-control.js";
import { SessionSnapshotParamsSchema } from "../../domain/session-snapshot.js";
import { StartSessionRequestSchema } from "../../domain/session.js";
import { ScoutEgressRequestSchema } from "../../domain/worker-profile.js";
import { NvimBindParamsSchema } from "../nvim-binding-service.js";
import { RegistryError } from "../session-registry.js";
import {
  type BrokerMethodHandler,
  requireFleetDetaches,
  requireLocalWorkerControl,
  requireNvimBindings,
  requireScoutEgress,
  requireTranscripts,
  withSessionWorkerMode,
} from "./method-context.js";
import {
  AttachParamsSchema,
  RenameSessionParamsSchema,
  ReorderSessionParamsSchema,
  SendParamsSchema,
  SessionIdParamsSchema,
  StartSessionWithPromptParamsSchema,
  SubmitParamsSchema,
  ThreadChangesParamsSchema,
  ThreadReadParamsSchema,
} from "./params.js";

/** Threads as the operator drives them: start, read, attach, stop, and the local telemetry channel. */
export const sessionMethods: Record<string, BrokerMethodHandler> = {
  "local.worker.v1.snapshot": async (server, _context, frame) => {
    LocalWorkerSnapshotRequestSchema.parse(frame.params);
    return requireLocalWorkerControl(server.options).snapshot();
  },
  "local.worker.v1.subscribe": async (server, context, frame) => {
    LocalWorkerSubscribeRequestSchema.parse(frame.params);
    server.subscribeLocalWorkerTelemetry(context);
    return requireLocalWorkerControl(server.options).snapshot();
  },
  "local.worker.v1.unsubscribe": async (server, context, frame) => {
    LocalWorkerUnsubscribeRequestSchema.parse(frame.params);
    server.unsubscribeLocalWorkerTelemetry(context);
    return LocalWorkerUnsubscribeResultSchema.parse({
      schemaVersion: LOCAL_WORKER_CONTROL_SCHEMA_VERSION,
      subscribed: false,
    });
  },
  "local.worker.v1.command": async (server, _context, frame) => {
    return requireLocalWorkerControl(server.options).command(frame.params);
  },
  "session.start": async (server, _context, frame) => {
    const request = await withSessionWorkerMode(StartSessionRequestSchema.parse(frame.params));
    return server.options.registry.start(request);
  },
  "session.startWithPrompt": async (server, _context, frame) => {
    const { initialPrompt, ...request } = StartSessionWithPromptParamsSchema.parse(frame.params);
    return server.options.registry.start(await withSessionWorkerMode(request), initialPrompt);
  },
  "session.list": async (server, _context, _frame) => {
    return server.options.registry.list();
  },
  "thread.list": async (server, _context, _frame) => {
    return server.options.registry.list();
  },
  "thread.read": async (server, _context, frame) => {
    const { sessionId, afterCursor, limit } = ThreadReadParamsSchema.parse(frame.params);
    server.options.registry.get(sessionId);
    return requireTranscripts(server.options).read(sessionId, afterCursor, limit);
  },
  "thread.changes": async (server, _context, frame) => {
    const { afterCursor, limit } = ThreadChangesParamsSchema.parse(frame.params);
    return requireTranscripts(server.options).changes(afterCursor, limit);
  },
  // The client resolved the nvim address from its own tmux pane and has already drawn the
  // first list. Registering it here only buys the completion refresh, which needs an observer
  // that outlives a one-shot `cyberdeck open`.
  "nvim.bind": async (server, _context, frame) => {
    return requireNvimBindings(server.options).bind(NvimBindParamsSchema.parse(frame.params));
  },
  "scout.egress": async (server, _context, frame) => {
    const request = ScoutEgressRequestSchema.parse(frame.params);
    if (request.enabled !== undefined) {
      await requireScoutEgress(server.options).set(request.root, request.enabled);
    }
    return requireScoutEgress(server.options).status(request.root);
  },
  // Read-only inspection of what the broker actually spawned. The broker is the source of
  // record: no client rebuilds a spec, so nothing here runs a provider preflight or writes.
  "session.launchRecord": async (server, _context, frame) => {
    const { sessionId } = SessionIdParamsSchema.parse(frame.params);
    const session = server.options.registry.get(sessionId);
    return {
      sessionId,
      provider: session.provider,
      launchRecord: server.options.registry.launchRecord(sessionId) ?? null,
    };
  },
  "session.snapshot": async (server, _context, frame) => {
    const { sessionId } = SessionSnapshotParamsSchema.parse(frame.params);
    return { data: server.options.registry.snapshot(sessionId).toString("base64") };
  },
  "session.stop": async (server, _context, frame) => {
    const { sessionId } = SessionIdParamsSchema.parse(frame.params);
    return server.options.registry.stopTree(sessionId);
  },
  "session.stopOne": async (server, _context, frame) => {
    const { sessionId } = SessionIdParamsSchema.parse(frame.params);
    await server.options.registry.stop(sessionId);
    return { stopped: true };
  },
  "session.resume": async (server, _context, frame) => {
    const { sessionId } = SessionIdParamsSchema.parse(frame.params);
    return server.options.registry.resume(sessionId);
  },
  "session.delete": async (server, _context, frame) => {
    const { sessionId } = SessionIdParamsSchema.parse(frame.params);
    const record = server.options.registry.get(sessionId);
    await server.options.registry.delete(sessionId, async () => {
      if (record.kind === "orchestrator") {
        await server.options.orchestrators?.resetSessionBinding(sessionId);
      }
    });
    return { deleted: true };
  },
  "session.rename": async (server, _context, frame) => {
    const { sessionId, name } = RenameSessionParamsSchema.parse(frame.params);
    return server.options.registry.rename(sessionId, name);
  },
  "session.togglePin": async (server, _context, frame) => {
    const { sessionId } = SessionIdParamsSchema.parse(frame.params);
    return server.options.registry.togglePin(sessionId);
  },
  "session.reorder": async (server, _context, frame) => {
    const { sessionId, direction } = ReorderSessionParamsSchema.parse(frame.params);
    return server.options.registry.reorder(sessionId, direction);
  },
  "session.submit": async (server, context, frame) => {
    const { sessionId, message } = SubmitParamsSchema.parse(frame.params);
    if (context.attachments.get(sessionId)?.mode === "watch") {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Watch clients are read-only");
    }
    const clientId = context.attachments.get(sessionId)?.mode === "control" ? context.id : undefined;
    await server.options.registry.submit(sessionId, clientId, message);
    return { submitted: true };
  },
  "session.send": async (server, context, frame) => {
    const { sessionId, data } = SendParamsSchema.parse(frame.params);
    if (context.attachments.get(sessionId)?.mode === "watch") {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Watch clients are read-only");
    }
    const clientId = context.attachments.get(sessionId)?.mode === "control" ? context.id : undefined;
    await server.options.registry.write(sessionId, clientId, Buffer.from(data, "base64"));
    return { sent: true };
  },
  "session.attach": async (server, context, frame) => {
    const { sessionId, detachIdentity } = AttachParamsSchema.parse(frame.params);
    return server.attach(context, sessionId, "control", detachIdentity);
  },
  "session.watch": async (server, context, frame) => {
    const { sessionId } = AttachParamsSchema.parse(frame.params);
    return server.attach(context, sessionId, "watch");
  },
  "session.detach": async (server, context, frame) => {
    const { sessionId } = SessionIdParamsSchema.parse(frame.params);
    const attachment = context.attachments.get(sessionId);
    await server.options.registry.detach(sessionId, context.id);
    context.attachments.delete(sessionId);
    if (attachment?.mode === "control" && attachment.detachIdentity !== undefined) {
      await requireFleetDetaches(server.options).record(attachment.detachIdentity, sessionId);
    }
    return { detached: true };
  },
};
