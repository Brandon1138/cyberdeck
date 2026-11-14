import { expect, it, vi } from "vitest";
import { watchStrigoi } from "../../src/client/strigoi-watch.js";
it("reattaches only read-only logical watches through existing attachment APIs", async () => {
  let current = "old", desired = "enabled", closed: () => void = () => {};
  const off = vi.fn();
  const transport = { request: vi.fn(async (_method: string, _params: unknown) => ({ state: { desired, activeBinding: { sessionId: current } }, runtime: { exitCode: null } })),
    onClose: (callback: () => void) => { closed = callback; return off; } };
  const attach = vi.fn(async () => { if (current === "old") { current = "new"; return 1; } desired = "suspended"; return 0; });
  expect(await watchStrigoi(transport as never, { attach })).toBe(0);
  expect(attach.mock.calls).toEqual([[{ transport, sessionId: "old", mode: "watch", closeTransport: false }], [{ transport, sessionId: "new", mode: "watch", closeTransport: false }]]);
  expect(off).toHaveBeenCalledOnce(); closed();
});
it("does not attach again to a retired identity or start a provider during a renewal gap", async () => {
  let next = false, stop = false;
  const transport = { request: vi.fn(async (_method: string, _params: unknown) => ({ state: { desired: stop ? "disabled" : "enabled", activeBinding: { sessionId: next ? "new" : "old" } }, runtime: { exitCode: next ? null : 0 } })), onClose: () => () => {} };
  const attach = vi.fn(async () => { stop = true; return 0; });
  const pause = vi.fn(async () => { next = true; });
  expect(await watchStrigoi(transport as never, { attach, pause })).toBe(0);
  expect(pause).toHaveBeenCalledOnce(); expect(attach).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "new", mode: "watch" }));
  expect(transport.request.mock.calls.every(([method]) => method === "strigoi.inspect")).toBe(true);
});
