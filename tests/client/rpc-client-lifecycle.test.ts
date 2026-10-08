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
