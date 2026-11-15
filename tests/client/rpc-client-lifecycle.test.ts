import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { RpcClient } from "../../src/client/rpc-client.js";

it("notifies a listener registered after the RPC transport has already closed", () => {
  const socket = new EventEmitter();
  const Client = RpcClient as unknown as new (socket: Socket) => RpcClient;
  const client = new Client(socket as Socket);
  socket.emit("close");
  const listener = vi.fn();
  const unsubscribe = client.onClose(listener);
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  socket.emit("close");
  expect(listener).toHaveBeenCalledOnce();
});

it("expires a pending RPC without retrying and ignores its late response", async () => {
  vi.useFakeTimers();
  try {
    const socket = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
    const Client = RpcClient as unknown as new (socket: Socket) => RpcClient;
    const client = new Client(socket as unknown as Socket);
    const pending = client.requestWithDeadline("agent.thread.enqueue", {}, 100);
    const rejected = expect(pending).rejects.toMatchObject({ code: "CONTROL_PLANE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    socket.emit("data", Buffer.from(JSON.stringify({ type: "response", id: 1, ok: true, result: { accepted: true } }) + "\n"));
    const next = client.requestWithDeadline("broker.status", {}, 100);
    socket.emit("data", Buffer.from(JSON.stringify({ type: "response", id: 2, ok: true, result: { healthy: true } }) + "\n"));
    await expect(next).resolves.toEqual({ healthy: true });
    expect(socket.write).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    socket.emit("close");
  } finally { vi.useRealTimers(); }
});
