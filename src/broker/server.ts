import { randomUUID } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import {
  ClientFrameSchema,
  type ClientFrame,
  type ProtocolErrorFrame,
  type RequestFrame,
} from "./protocol/frames.js";
import { encodeFrame, JsonlDecoder } from "./protocol/jsonl.js";
import {
  requireLocalWorkerControl,
  type BrokerMethodContext,
} from "./server/method-context.js";
import { BROKER_METHODS } from "./server/methods.js";
import type { BrokerServerOptions, ConnectionContext } from "./server/options.js";
import { RegistryError, type AttachmentMode } from "./session-registry.js";

/**
 * `BrokerServerOptions` is re-exported here because it is this server's constructor contract:
 * `main.ts` and every test compose it against `BrokerServer`, not against the module the interface
 * happens to live in.
 */
export type { BrokerServerOptions } from "./server/options.js";

export class BrokerServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private listening = false;
  private closePromise: Promise<void> | undefined;
  /** The half of this server a method handler is allowed to see. Built once, per server. */
  private readonly methodContext: BrokerMethodContext;

  constructor(private readonly options: BrokerServerOptions) {
    this.server = createServer((socket) => this.accept(socket));
    this.methodContext = {
      options,
      attach: (context, sessionId, mode, detachIdentity) =>
        this.attach(context, sessionId, mode, detachIdentity),
      subscribeLocalWorkerTelemetry: (context) => this.subscribeLocalWorkerTelemetry(context),
      unsubscribeLocalWorkerTelemetry: (context) => this.unsubscribeLocalWorkerTelemetry(context),
    };
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
      this.unsubscribeLocalWorkerTelemetry(context);
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
    const handler = BROKER_METHODS[frame.method];
    if (handler === undefined) {
      throw Object.assign(new Error(`Unknown method ${frame.method}`), { code: "METHOD_NOT_FOUND" });
    }
    return handler(this.methodContext, context, frame);
  }

  private subscribeLocalWorkerTelemetry(context: ConnectionContext): void {
    if (context.localWorkerTelemetry !== undefined) return;
    const subscription: NonNullable<ConnectionContext["localWorkerTelemetry"]> = {
      unsubscribe: () => undefined,
      lastSentAt: 0,
    };
    subscription.unsubscribe = requireLocalWorkerControl(this.options).onUpdate((snapshot) => {
      const elapsed = Date.now() - subscription.lastSentAt;
      if (elapsed >= 100 && subscription.timer === undefined) {
        subscription.lastSentAt = Date.now();
        this.send(context.socket, { type: "local-worker-telemetry", snapshot });
        return;
      }
      subscription.pending = snapshot;
      if (subscription.timer !== undefined) return;
      subscription.timer = setTimeout(() => {
        delete subscription.timer;
        const pending = subscription.pending;
        delete subscription.pending;
        if (pending === undefined || context.localWorkerTelemetry !== subscription) return;
        subscription.lastSentAt = Date.now();
        this.send(context.socket, { type: "local-worker-telemetry", snapshot: pending });
      }, Math.max(0, 100 - elapsed));
      subscription.timer.unref();
    });
    context.localWorkerTelemetry = subscription;
  }

  private unsubscribeLocalWorkerTelemetry(context: ConnectionContext): void {
    const subscription = context.localWorkerTelemetry;
    if (subscription === undefined) return;
    delete context.localWorkerTelemetry;
    subscription.unsubscribe();
    if (subscription.timer !== undefined) clearTimeout(subscription.timer);
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
