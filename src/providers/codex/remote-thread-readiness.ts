import { createConnection } from "node:net";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

/** Read current runtime state from the existing daemon. Never loads, resumes or starts a thread. */
export function readCodexRemoteIdle(input: {
  homeDirectory: string; nativeSessionId: string; cwd: string; transcriptPath: string;
  timeoutMs?: number;
}): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new WebSocket("ws://localhost", {
      createConnection: () => createConnection(join(input.homeDirectory, "app-server-control", "app-server-control.sock")),
      handshakeTimeout: input.timeoutMs ?? 1_000, maxPayload: 1024 * 1024,
    });
    let settled = false, initialized = false;
    const finish = (idle = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.terminate(); resolve(idle);
    };
    const timer = setTimeout(() => finish(), input.timeoutMs ?? 1_000);
    const send = (message: unknown) => socket.send(JSON.stringify(message), error => { if (error) finish(); });
    socket.on("error", () => finish());
    socket.on("close", () => finish());
    socket.on("open", () => send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "cyberdeck_readiness", version: "1" }, capabilities: null,
    } }));
    socket.on("message", (data, binary) => {
      if (settled || binary) return;
      try {
        const frame = JSON.parse(data.toString()) as { id?: unknown; error?: unknown; result?: {
          thread?: { id?: string; cwd?: string; path?: string; status?: { type?: string }; canAcceptDirectInput?: boolean };
        } };
        if (frame.id === 1 && !initialized) {
          if (frame.error !== undefined || frame.result === undefined) { finish(); return; }
          initialized = true;
          send({ method: "initialized" });
          send({ id: 2, method: "thread/read", params: { threadId: input.nativeSessionId, includeTurns: false } });
        } else if (frame.id === 2 && initialized) {
          const thread = frame.result?.thread;
          if (frame.error !== undefined || thread?.id !== input.nativeSessionId || thread.cwd !== input.cwd
            || typeof thread.path !== "string" || thread.status?.type !== "idle" || thread.canAcceptDirectInput !== true) {
            finish(); return;
          }
          // Managed native homes share sessions through a symlink. Require the same file,
          // without rejecting the daemon's legitimate spelling of that exact bound path.
          if (thread.path === input.transcriptPath) finish(true);
          else void Promise.all([realpath(thread.path), realpath(input.transcriptPath)])
            .then(([actual, expected]) => finish(actual === expected), () => finish());
        }
      } catch { finish(); }
    });
  });
}
