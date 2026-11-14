import { expect, it, vi } from "vitest";
import { RpcError } from "../../src/client/rpc-client.js";
import type { AttachTransport } from "../../src/client/attach.js";
import { watchStrigoi } from "../../src/client/strigoi-watch.js";
import type { ServerFrame } from "../../src/protocol/frames.js";

function scriptedTransport(options: {
  inspect: () => { desired: string; sessionId: string };
  watch: (sessionId: string, attempt: number, end: () => void) => Promise<{ data: string }>;
}) {
  const calls: string[] = [];
  const frames = new Set<(frame: ServerFrame) => void>();
  const close = vi.fn();
  let attempts = 0;
  const transport: AttachTransport = {
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "strigoi.inspect") {
        calls.push(method);
        const { desired, sessionId } = options.inspect();
        return { state: { desired, activeBinding: { sessionId } }, runtime: { exitCode: null } } as T;
      }
      if (method === "session.watch") {
        const { sessionId } = params as { sessionId: string };
        calls.push(`${method}:${sessionId}`);
        attempts += 1;
        return options.watch(sessionId, attempts, () => {
          for (const listener of frames) listener({ type: "session-ended", sessionId, exitCode: 0 });
        }) as Promise<T>;
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    sendFrame: () => { throw new Error("A read-only watch sent a frame"); },
    onFrame: listener => { frames.add(listener); return () => { frames.delete(listener); }; },
    onClose: () => () => {},
    close,
  };
  return { transport, calls, close };
}

it("re-inspects and watches the successor after a retired session refuses attachment", async () => {
  let current = "A", desired = "enabled";
  const { transport, calls, close } = scriptedTransport({
    inspect: () => ({ desired, sessionId: current }),
    watch: async (id, _attempt, end) => {
      if (id === "A") {
        current = "B";
        throw new RpcError("SESSION_NOT_ACTIVE", "Session is not active");
      }
      setImmediate(() => { desired = "suspended"; end(); });
      return { data: "" };
    },
  });
  const pause = vi.fn(async () => {});

  await expect(watchStrigoi(transport, { pause })).resolves.toBe(0);
  expect(calls).toEqual(["strigoi.inspect", "session.watch:A", "strigoi.inspect", "session.watch:B", "strigoi.inspect"]);
  expect(pause).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

it("retries a still-current identity after a transient attachment refusal", async () => {
  let desired = "enabled";
  const { transport, calls } = scriptedTransport({
    inspect: () => ({ desired, sessionId: "A" }),
    watch: async (_id, attempt, end) => {
      if (attempt === 1) throw new RpcError("SESSION_NOT_ACTIVE", "Session is not active");
      setImmediate(() => { desired = "suspended"; end(); });
      return { data: "" };
    },
  });
  await expect(watchStrigoi(transport, { pause: async () => {} })).resolves.toBe(0);
  expect(calls).toEqual(["strigoi.inspect", "session.watch:A", "strigoi.inspect", "session.watch:A", "strigoi.inspect"]);
});

it("propagates unrelated attachment errors", async () => {
  const { transport, calls } = scriptedTransport({
    inspect: () => ({ desired: "enabled", sessionId: "A" }),
    watch: async () => { throw new RpcError("INVALID_ARGUMENT", "Unexpected attachment failure"); },
  });
  const pause = vi.fn(async () => {});
  await expect(watchStrigoi(transport, { pause })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(calls).toEqual(["strigoi.inspect", "session.watch:A"]);
  expect(pause).not.toHaveBeenCalled();
});
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
