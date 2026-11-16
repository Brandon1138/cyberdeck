import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, beforeEach, expect, it } from "vitest";
import { codexDaemonHasNoLoadedThreads } from "../../src/providers/codex/remote-loaded-threads.js";

let root: string, path: string, server: Server, ws: WebSocketServer;
let response: unknown, silent: boolean, calls: string[];
beforeEach(async () => {
  root = await mkdtemp("/tmp/cd-loaded-"); path = join(root, "daemon.sock");
  response = { data: [], nextCursor: null }; silent = false; calls = [];
  server = createServer(); ws = new WebSocketServer({ server });
  ws.on("connection", client => client.on("message", bytes => {
    const frame = JSON.parse(bytes.toString()); calls.push(frame.method);
    if (silent) return;
    if (frame.method === "initialize") client.send(JSON.stringify({ id: frame.id, result: {} }));
    if (frame.method === "thread/loaded/list") client.send(JSON.stringify({ id: frame.id, result: response }));
  }));
  server.listen(path); await once(server, "listening");
});
afterEach(async () => {
  for (const client of ws.clients) client.terminate(); ws.close();
  await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
});
it("requires an explicitly empty complete roster without loading, resuming or mutating a thread", async () => {
  expect(await codexDaemonHasNoLoadedThreads(path)).toBe(true);
  expect(calls).toEqual(["initialize", "initialized", "thread/loaded/list"]);
});
it.each([{ data: ["thread"], nextCursor: null }, { data: [], nextCursor: "more" }, { data: [] }, null, {}])
  ("refuses nonempty, partial or malformed runtime evidence: %j", async value => {
    response = value; expect(await codexDaemonHasNoLoadedThreads(path)).toBe(false);
  });
it("bounds silent and absent daemons without starting one", async () => {
  silent = true;
  expect(await codexDaemonHasNoLoadedThreads(path, 50)).toBe(false);
  expect(await codexDaemonHasNoLoadedThreads(join(root, "absent.sock"), 50)).toBe(false);
});
