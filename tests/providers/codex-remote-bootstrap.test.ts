import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomic from "../../src/persistence/atomic-private-file.js";
import { CodexRemoteBootstrap, readBootstrap } from "../../src/providers/codex/remote-bootstrap.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp("/tmp/cd-bootstrap-"); roots.push(home);
  const bridge = new CodexRemoteBootstrap(home, "actor");
  const request = JSON.stringify({ id: 1, method: "thread/start", params: { cwd: "/work" } });
  const response = JSON.stringify({ id: 1, result: { thread: { id: "native", cwd: "/work", turns: [] } } });
  return { home, bridge, request, response };
}
describe("exact native bootstrap receipt", () => {
  it("publishes only the correlated empty start and revokes before input", async () => {
    const f = await fixture(); await f.bridge.incoming(f.response);
    expect(await readBootstrap(f.home, "actor")).toBeUndefined();
    await f.bridge.outgoing(f.request); await f.bridge.incoming(f.response);
    expect(await readBootstrap(f.home, "actor")).toMatchObject({ actorSessionId: "actor", nativeSessionId: "native", cwd: "/work" });
    await f.bridge.outgoing(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "native" } }));
    expect(await readBootstrap(f.home, "actor")).toBeUndefined();
    await f.bridge.incoming(f.response);
    expect(await readBootstrap(f.home, "actor")).toBeUndefined();
  });
  it.each(["turn/started", "turn/completed", "item/started", "thread/compacted", "thread/status/changed", "error"])("revokes external-client activity %s", async method => {
    const f = await fixture(); await f.bridge.outgoing(f.request); await f.bridge.incoming(f.response);
    await f.bridge.incoming(JSON.stringify({ method, params: { threadId: "native", status: { type: "active" } } }));
    expect(await readBootstrap(f.home, "actor")).toBeUndefined();
  });
  it("cannot republish a start reply racing revocation", async () => {
    const f = await fixture(); await f.bridge.outgoing(f.request);
    await Promise.all([f.bridge.incoming(f.response), f.bridge.revoke()]);
    expect(await readBootstrap(f.home, "actor")).toBeUndefined();
  });
  it.each(["thread/queue/add", "thread/queue/start", "thread/realtime/appendText", "thread/realtime/appendAudio", "thread/inject_items", "thread/sample", "thread/shellCommand", "review/start", "thread/revert", "thread/prepareApprovedPlan"])("revokes before %s", async method => {
    const f = await fixture(); await f.bridge.outgoing(f.request); await f.bridge.incoming(f.response);
    await f.bridge.outgoing(JSON.stringify({ id: 2, method, params: { threadId: "native" } }));
    expect(await readBootstrap(f.home, "actor")).toBeUndefined();
  });
  it("removes a receipt even after publication fails following rename", async () => {
    const f = await fixture(); await f.bridge.outgoing(f.request);
    const original = atomic.writeAtomicPrivateFile;
    const write = vi.spyOn(atomic, "writeAtomicPrivateFile").mockImplementationOnce(async (...args) => {
      await original(...args); throw new Error("directory sync failure");
    });
    try {
      await expect(f.bridge.incoming(f.response)).rejects.toThrow("directory sync failure");
      await f.bridge.revoke();
      expect(await readBootstrap(f.home, "actor")).toBeUndefined();
    } finally { write.mockRestore(); }
  });
  it.each(["cwd", "turns", "error"])("refuses a mismatched/nonempty/failed start: %s", async kind => {
    const f = await fixture(); await f.bridge.outgoing(f.request);
    const response = JSON.parse(f.response);
    if (kind === "cwd") response.result.thread.cwd = "/other";
    if (kind === "turns") response.result.thread.turns = [{ id: "old" }];
    if (kind === "error") response.error = { message: "failed" };
    await f.bridge.incoming(JSON.stringify(response));
    expect(await readBootstrap(f.home, "actor")).toBeUndefined();
  });
});
