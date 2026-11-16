import { createConnection } from "node:net";
import WebSocket from "ws";

/** A bounded read of the existing daemon; never starts or loads a native thread. */
export function codexDaemonHasNoLoadedThreads(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new WebSocket("ws://localhost", { createConnection: () => createConnection(socketPath),
      handshakeTimeout: timeoutMs, maxPayload: 1024 * 1024 });
    let settled = false, initialized = false;
    const finish = (empty = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.terminate(); resolve(empty);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    const send = (frame: unknown) => socket.send(JSON.stringify(frame), error => { if (error) finish(); });
    socket.on("error", () => finish()); socket.on("close", () => finish());
    socket.on("open", () => send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "cyberdeck_legacy_retirement", version: "1" }, capabilities: null,
    } }));
    socket.on("message", (bytes, binary) => {
      if (settled || binary) return;
      try {
        const frame = JSON.parse(bytes.toString());
        if (frame.id === 1 && !initialized) {
          if (frame.error !== undefined || frame.result === undefined) { finish(); return; }
          initialized = true; send({ method: "initialized" });
          send({ id: 2, method: "thread/loaded/list", params: {} });
        } else if (frame.id === 2 && initialized) {
          finish(frame.error === undefined && Array.isArray(frame.result?.data) && frame.result.data.length === 0
            && frame.result.nextCursor === null);
        }
      } catch { finish(); }
    });
  });
}
