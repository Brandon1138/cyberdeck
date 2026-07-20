import { connect, type Socket } from "node:net";
import {
  ServerFrameSchema,
  type ClientFrame,
  type ServerFrame,
} from "../protocol/frames.js";
import { encodeFrame, JsonlDecoder } from "../protocol/jsonl.js";

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: RpcError) => void;
}

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcClient {
  private readonly decoder = new JsonlDecoder(ServerFrameSchema);
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(frame: ServerFrame) => void>();
  private readonly closeListeners = new Set<() => void>();
  private nextRequestId = 1;
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const frame of this.decoder.push(bytes)) {
        if (frame.type === "response") {
          const pending = this.pending.get(frame.id);
          if (pending === undefined) continue;
          this.pending.delete(frame.id);
          if (frame.ok) pending.resolve(frame.result);
          else pending.reject(new RpcError(frame.error.code, frame.error.message));
        } else {
          for (const listener of this.listeners) listener(frame);
        }
      }
    });
    socket.on("close", () => this.handleClose());
    socket.on("error", () => {
      // The close event rejects pending requests with one stable error code.
    });
  }

  static async connect(socketPath: string): Promise<RpcClient> {
    const socket = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new RpcClient(socket);
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new RpcError("BROKER_DISCONNECTED", "Broker connection is closed"));
    }
    const id = this.nextRequestId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.sendFrame({ type: "request", id, method, params });
    return result;
  }

  sendFrame(frame: ClientFrame): void {
    if (this.closed) {
      throw new RpcError("BROKER_DISCONNECTED", "Broker connection is closed");
    }
    this.socket.write(encodeFrame(frame));
  }

  onFrame(listener: (frame: ServerFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.socket.end();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new RpcError("BROKER_DISCONNECTED", "Broker connection closed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}
