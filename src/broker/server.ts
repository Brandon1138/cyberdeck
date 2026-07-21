import { randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import {
  AcknowledgeReportParamsSchema,
  CancelJobParamsSchema,
  GetJobParamsSchema,
  IngestReportParamsSchema,
  type JobControlPlane,
} from "../control-plane/job-control-plane.js";
import type { ControlPlaneRuntime } from "../control-plane/runtime.js";
import { StartSessionRequestSchema } from "../domain/session.js";
import { ClientFrameSchema, type ClientFrame, type ProtocolErrorFrame, type RequestFrame } from "../protocol/frames.js";
import { encodeFrame, JsonlDecoder } from "../protocol/jsonl.js";
import { RegistryError, type AttachmentMode, type SessionRegistry } from "./session-registry.js";

const SessionIdParamsSchema = z.object({ sessionId: z.uuid() });
const SendParamsSchema = SessionIdParamsSchema.extend({ data: z.string() });
const AttachParamsSchema = SessionIdParamsSchema;

interface ConnectionContext {
  id: string;
  socket: Socket;
  attachments: Map<string, AttachmentMode>;
}

export interface BrokerServerOptions {
  socketPath: string;
  registry: SessionRegistry;
  controlPlane?: JobControlPlane;
  /** Supplies the reconciliation view; queue/budget queries work from the control plane alone. */
  controlPlaneRuntime?: Pick<ControlPlaneRuntime, "lastReconciliation">;
  onShutdown?: () => void;
}

export class BrokerServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private listening = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: BrokerServerOptions) {
    this.server = createServer((socket) => this.accept(socket));
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
      const mode = context.attachments.get(frame.sessionId);
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
      case "session.start":
        return this.options.registry.start(StartSessionRequestSchema.parse(frame.params));
      case "session.list":
        return this.options.registry.list();
      case "session.snapshot": {
        const { sessionId } = SessionIdParamsSchema.parse(frame.params);
        return { data: this.options.registry.snapshot(sessionId).toString("base64") };
      }
      case "session.stop": {
        const { sessionId } = SessionIdParamsSchema.parse(frame.params);
        await this.options.registry.stop(sessionId);
        return { stopped: true };
      }
      case "session.send": {
        const { sessionId, data } = SendParamsSchema.parse(frame.params);
        if (context.attachments.get(sessionId) === "watch") {
          throw new RegistryError("NOT_SESSION_CONTROLLER", "Watch clients are read-only");
        }
        const clientId = context.attachments.get(sessionId) === "control" ? context.id : undefined;
        await this.options.registry.write(sessionId, clientId, Buffer.from(data, "base64"));
        return { sent: true };
      }
      case "session.attach":
        return this.attach(context, AttachParamsSchema.parse(frame.params).sessionId, "control");
      case "session.watch":
        return this.attach(context, AttachParamsSchema.parse(frame.params).sessionId, "watch");
      case "session.detach": {
        const { sessionId } = SessionIdParamsSchema.parse(frame.params);
        await this.options.registry.detach(sessionId, context.id);
        context.attachments.delete(sessionId);
        return { detached: true };
      }
      case "job.submit":
        return this.requireControlPlane().submit(frame.params);
      case "job.delegate":
        return this.requireControlPlane().delegate(frame.params);
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
        return { healthy: true, pid: process.pid };
      case "broker.shutdown":
        return { shuttingDown: true };
      default:
        throw Object.assign(new Error(`Unknown method ${frame.method}`), { code: "METHOD_NOT_FOUND" });
    }
  }

  private requireControlPlane(): JobControlPlane {
    if (this.options.controlPlane === undefined) {
      throw Object.assign(new Error("Control plane is not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.options.controlPlane;
  }

  private async attach(
    context: ConnectionContext,
    sessionId: string,
    mode: AttachmentMode,
  ): Promise<unknown> {
    const replay = await this.options.registry.attach(sessionId, context.id, mode, (chunk) => {
      this.send(context.socket, {
        type: "output",
        sessionId,
        data: chunk.toString("base64"),
      });
    });
    context.attachments.set(sessionId, mode);
    return { session: this.options.registry.get(sessionId), data: replay.toString("base64") };
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
      code: "INVALID_FRAME",
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
