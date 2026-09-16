import { connect } from "node:net";
import { healthMethods } from "./collector.js";
/** One bounded read-only request per owned socket; destruction also cancels connecting sockets. */
export function readHealth(socketPath: string, method: string, signal: AbortSignal): Promise<unknown> {
  if (!(healthMethods as readonly string[]).includes(method)) return Promise.reject(new Error("method-not-allowed"));
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let bytes = Buffer.alloc(0), settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return; settled = true; signal.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new Error("health-timeout"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    socket.once("error", () => finish(new Error("health-unavailable")));
    socket.once("close", () => finish(new Error("health-disconnected")));
    socket.once("connect", () => socket.write(JSON.stringify({ type: "request", id: 1, method, params: {} }) + "\n"));
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (bytes.length > 1024 * 1024) { finish(new Error("health-size-limit")); return; }
      let newline: number;
      while ((newline = bytes.indexOf(10)) >= 0) {
        const line = bytes.subarray(0, newline); bytes = bytes.subarray(newline + 1);
        try {
          const frame = JSON.parse(line.toString("utf8"));
          if (frame.type === "response" && frame.id === 1) {
            if (frame.ok === true) finish(undefined, frame.result); else finish(new Error("health-refused"));
            return;
          }
        } catch { finish(new Error("health-invalid-frame")); return; }
      }
    });
  });
}
