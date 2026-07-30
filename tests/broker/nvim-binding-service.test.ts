import { describe, expect, it } from "vitest";
import { NvimBindingService } from "../../src/broker/nvim-binding-service.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type { NvimEntryPoint } from "../../src/nvim/bridge.js";
import type { NvimWorktreeRequest } from "../../src/nvim/quickfix.js";
import type { WorktreeBaseline } from "../../src/nvim/worktree-changes.js";

const FORK_POINT: WorktreeBaseline = { kind: "fork-point", label: "since origin/main" };

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
    changes: async () => ({
      changes: [{ path: "src/a.ts", line: 4, text: "fn a() {" }],
      dropped: 0,
      baseline: FORK_POINT,
    }),
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
    context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock", live: true });

    context.setRecord(session({ executionState: "exited", exitCode: 0 }));
    context.update(SESSION_ID);
    await context.service.settled();

    expect(context.notifications).toEqual([{
      address: "/tmp/sock",
      entryPoint: "refresh",
      request: {
        session: SESSION_ID,
        worktree: "/work/tree",
        title: "Cyberdeck · worker-one · since origin/main",
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
    context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock", live: true });

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

  it("accepts a bind for a worker the client already rendered as finished, and says nothing", async () => {
    const context = harness(session({ executionState: "exited", exitCode: 0 }));
    context.service.start();

    const binding = context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock", live: false });
    await context.service.settled();

    expect(binding.worktree).toBe("/work/tree");
    expect(context.service.binding(SESSION_ID)).toBeUndefined();
    // nvim was never locked, so there is nothing to release and no reason to talk to it.
    expect(context.notifications).toEqual([]);
  });

  it("releases nvim when the worker went terminal between the open and the bind", async () => {
    // The client read the worker while it was live, sent `open` with `live: true`, and only then
    // bound. Without a release here the transition is already behind the service and those buffers
    // stay `nomodifiable` for the life of that nvim.
    const context = harness(session({ executionState: "exited", exitCode: 0 }));
    context.service.start();

    context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock", live: true });
    await context.service.settled();

    expect(context.notifications).toEqual([{
      address: "/tmp/sock",
      entryPoint: "refresh",
      request: {
        session: SESSION_ID,
        worktree: "/work/tree",
        title: "Cyberdeck · worker-one · since origin/main",
        live: false,
        entries: [{ filename: "/work/tree/src/a.ts", lnum: 4, col: 1, text: "fn a() {" }],
      },
    }]);
    expect(context.service.binding(SESSION_ID)).toBeUndefined();
  });

  it("sends exactly one release when the worker is live at bind time and goes terminal after", async () => {
    const context = harness();
    context.service.start();
    context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock", live: true });

    context.setRecord(session({ executionState: "exited", exitCode: 0 }));
    context.update(SESSION_ID);
    context.update(SESSION_ID);
    await context.service.settled();

    expect(context.notifications).toHaveLength(1);
  });

  it("drops a binding whose session the registry no longer knows", async () => {
    const context = harness();
    context.service.start();
    context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock", live: true });

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
      changes: async () => ({ changes: [], dropped: 0, baseline: FORK_POINT }),
      notify: () => { throw new Error("nvim did not answer"); },
    });
    failing.start();
    failing.bind({ sessionId: SESSION_ID, address: "/tmp/sock", live: true });

    record = session({ executionState: "exited", exitCode: 0 });
    await expect(failing.settle(SESSION_ID)).resolves.toBeUndefined();
    expect(failing.binding(SESSION_ID)).toBeUndefined();
  });

  it("unsubscribes and forgets every address on stop, because none survive a restart", () => {
    const context = harness();
    context.service.start();
    context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock", live: true });

    context.service.stop();

    expect(context.unsubscribed()).toBe(true);
    expect(context.service.binding(SESSION_ID)).toBeUndefined();
  });

  it("rejects an address that is not a string and a session id that is not a uuid", () => {
    const context = harness();
    expect(() => context.service.bind({ sessionId: "not-a-uuid", address: "/tmp/sock", live: true }))
      .toThrow();
    expect(() => context.service.bind({ sessionId: SESSION_ID, address: "", live: true })).toThrow();
    // What the client told nvim is not optional: without it a locked nvim is indistinguishable
    // from one that was opened read-write.
    expect(() => context.service.bind({ sessionId: SESSION_ID, address: "/tmp/sock" } as never))
      .toThrow();
  });
});
