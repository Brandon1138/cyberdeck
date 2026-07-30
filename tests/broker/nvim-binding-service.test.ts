import { describe, expect, it } from "vitest";
import { NvimBindingService } from "../../src/broker/nvim-binding-service.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type { NvimEntryPoint } from "../../src/nvim/bridge.js";
import type { NvimWorktreeRequest } from "../../src/nvim/quickfix.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-07-22T10:00:00.000Z";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    provider: "claude",
    cwd: "/work/tree",
    detached: true,
    sandbox: "read-only",
    name: "worker-one",
    model: "provider-native-model",
    role: "worker",
    createdAt: NOW,
    updatedAt: NOW,
    executionState: "active",
    attachmentState: "detached",
    pid: 4321,
    exitCode: null,
    childIds: [],
    ...overrides,
  } as SessionRecord;
}

interface Harness {
  service: NvimBindingService;
  notifications: Array<{ address: string; entryPoint: NvimEntryPoint; request: NvimWorktreeRequest }>;
  update: (sessionId: string) => void;
  setRecord: (record: SessionRecord | undefined) => void;
  unsubscribed: () => boolean;
}

function harness(initial: SessionRecord = session()): Harness {
  let record: SessionRecord | undefined = initial;
  let listener: ((sessionId: string) => void) | undefined;
  let unsubscribed = false;
  const notifications: Harness["notifications"] = [];
  const service = new NvimBindingService({
    sessions: {
      get: (sessionId) => {
        if (record === undefined || record.id !== sessionId) throw new Error("unknown session");
        return record;
      },
    },
    onSessionUpdate: (subscriber) => {
      listener = subscriber;
      return () => { unsubscribed = true; };
    },
    changes: async () => ({ changes: [{ path: "src/a.ts", line: 4, text: "fn a() {" }], dropped: 0 }),
    notify: (options) => { notifications.push(options); },
  });
  return {
    service,
    notifications,
    update: (sessionId) => listener?.(sessionId),
    setRecord: (next) => { record = next; },
    unsubscribed: () => unsubscribed,
  };
}

describe("NvimBindingService", () => {
  it("refreshes and releases read-only in one message when the worker goes terminal", async () => {
    const context = harness();
    context.service.start();
    context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock" });

    context.setRecord(session({ executionState: "exited", exitCode: 0 }));
    context.update(SESSION_ID);
    await context.service.settled();

    expect(context.notifications).toEqual([{
      address: "/tmp/sock",
      entryPoint: "refresh",
      request: {
        worktree: "/work/tree",
        title: "Cyberdeck · worker-one",
        live: false,
        entries: [{ filename: "/work/tree/src/a.ts", lnum: 4, col: 1, text: "fn a() {" }],
      },
    }]);
    // The binding is gone: a worker only goes terminal once.
    expect(context.service.binding(SESSION_ID)).toBeUndefined();
  });

  it("does nothing while the worker is still live", async () => {
    const context = harness();
    context.service.start();
    context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock" });

    context.setRecord(session({ executionState: "active" }));
    context.update(SESSION_ID);
    await context.service.settled();

    expect(context.notifications).toEqual([]);
    expect(context.service.binding(SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      address: "/tmp/sock",
      worktree: "/work/tree",
    });
  });

  it("accepts a bind for an already terminal worker without holding it", () => {
    const context = harness(session({ executionState: "exited", exitCode: 0 }));
    context.service.start();

    const binding = context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock" });

    expect(binding.worktree).toBe("/work/tree");
    expect(context.service.binding(SESSION_ID)).toBeUndefined();
  });

  it("drops a binding whose session the registry no longer knows", async () => {
    const context = harness();
    context.service.start();
    context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock" });

    context.setRecord(undefined);
    context.update(SESSION_ID);
    await context.service.settled();

    expect(context.notifications).toEqual([]);
    expect(context.service.binding(SESSION_ID)).toBeUndefined();
  });

  it("survives an nvim that has since been closed", async () => {
    let record = session();
    const failing = new NvimBindingService({
      sessions: { get: () => record },
      onSessionUpdate: () => () => {},
      changes: async () => ({ changes: [], dropped: 0 }),
      notify: () => { throw new Error("nvim did not answer"); },
    });
    failing.start();
    failing.bind({ sessionId: SESSION_ID, address: "/tmp/sock" });

    record = session({ executionState: "exited", exitCode: 0 });
    await expect(failing.settle(SESSION_ID)).resolves.toBeUndefined();
    expect(failing.binding(SESSION_ID)).toBeUndefined();
  });

  it("unsubscribes and forgets every address on stop, because none survive a restart", () => {
    const context = harness();
    context.service.start();
    context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock" });

    context.service.stop();

    expect(context.unsubscribed()).toBe(true);
    expect(context.service.binding(SESSION_ID)).toBeUndefined();
  });

  it("rejects an address that is not a string and a session id that is not a uuid", () => {
    const context = harness();
    expect(() => context.service.bind({ sessionId: "not-a-uuid", address: "/tmp/sock" }))
      .toThrow();
    expect(() => context.service.bind({ sessionId: SESSION_ID, address: "" })).toThrow();
  });
});
