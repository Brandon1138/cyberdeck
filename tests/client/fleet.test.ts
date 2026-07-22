import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import {
  collectFleetSnapshot,
  createFleetState,
  FleetKeyDecoder,
  renderFleet,
  runFleet,
  threadStatus,
  transitionFleet,
  type FleetSnapshot,
} from "../../src/client/fleet.js";

const NOW = "2026-07-22T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    cwd: "/Users/brandon/code/personal/cyberdeck",
    detached: true,
    sandbox: "read-only",
    name: "Implement modular cryptographic scheme",
    model: "provider-native-model",
    role: "orchestrator",
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

function fleet(...records: Array<{ record: SessionRecord; replay?: string }>): FleetSnapshot {
  return {
    threads: records.map(({ record, replay = "" }) => ({ record, replay })),
  };
}

describe("fleet presentation", () => {
  it("groups threads by project and shows provider, model, status, preview, and recency", () => {
    const snapshot = fleet(
      {
        record: session({ updatedAt: "2026-07-22T09:59:46.000Z" }),
        replay: "\u001b]0;cyberdeck\u0007\r\nLatest useful response",
      },
      {
        record: session({
          id: "22222222-2222-4222-8222-222222222222",
          provider: "codex",
          cwd: "/Users/brandon/code/personal/keystone",
          name: "Review key schedule",
          model: "another-model",
          role: undefined,
          executionState: "exited",
          updatedAt: "2026-07-22T09:58:00.000Z",
        }),
        replay: "Finished review",
      },
    );

    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 150,
      height: 40,
      now: NOW_MS,
      home: "/Users/brandon",
    });

    expect(rendered).toContain("~/code/personal/cyberdeck");
    expect(rendered).toContain("~/code/personal/keystone");
    expect(rendered).toContain("claude · provider-native-model · orchestrator");
    expect(rendered).toContain("codex · another-model");
    expect(rendered).toContain("Needs input");
    expect(rendered).toContain("Done");
    expect(rendered).toContain("Latest useful response");
    expect(rendered).toContain("14s");
    expect(rendered).not.toMatch(/recommend|preferred|fallback/i);
  });

  it("uses the provider terminal title to distinguish working from awaiting input", () => {
    expect(threadStatus({
      record: session(),
      replay: "\u001b]0;⠹ cyberdeck\u0007",
    })).toBe("Working");
    expect(threadStatus({
      record: session(),
      replay: "\u001b]0;cyberdeck\u0007",
    })).toBe("Needs input");
    expect(threadStatus({
      record: session({ executionState: "failed" }),
      replay: "",
    })).toBe("Failed");
    expect(threadStatus({
      record: session({ executionState: "cancelled", exitCode: 0 }),
      replay: "",
    })).toBe("Stopped");
  });

  it("keeps a dedicated new-thread composer at the bottom with explicit launch context", () => {
    const snapshot = fleet({ record: session(), replay: "First line\r\nMost recent answer" });
    const rendered = renderFleet(snapshot, { ...createFleetState(snapshot), draft: "Inspect the failure" }, {
      color: false,
      width: 100,
      height: 28,
      now: NOW_MS,
      home: "/Users/brandon",
    });

    const lines = rendered.split("\n");
    expect(lines.at(-3)).toBe("› Inspect the failure");
    expect(lines.at(-2)).toContain("new: claude · provider-native-model · read-only");
    expect(lines.at(-1)).toContain("enter open/start");
  });

  it("preserves word boundaries from cursor-positioned provider output", () => {
    const snapshot = fleet({
      record: session(),
      replay: "-\u001b[5GCyberdeck\u001b[15Gis\u001b[18Ga\u001b[20Glocal\u001b[26Gbroker",
    });
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 160,
      height: 28,
      now: NOW_MS,
      home: "/Users/brandon",
    });

    expect(rendered).toContain("- Cyberdeck is a local broker");
    expect(rendered).not.toContain("Cyberdeckisalocalbroker");
  });
});

describe("fleet controls", () => {
  it("consumes complete and fragmented terminal mouse reports instead of typing coordinates", () => {
    const decoder = new FleetKeyDecoder();

    expect(decoder.push("\u001b[<35;103;24M")).toEqual([]);
    expect(decoder.push("\u001b[<35;10")).toEqual([]);
    expect(decoder.hasPendingInput).toBe(true);
    expect(decoder.push("3;24Mhello")).toEqual(["h", "e", "l", "l", "o"]);
    expect(decoder.hasPendingInput).toBe(false);
  });

  it("buffers Escape briefly while preserving a literal Escape key", () => {
    const decoder = new FleetKeyDecoder();

    expect(decoder.push("\u001b")).toEqual([]);
    expect(decoder.flush()).toEqual(["escape"]);
  });

  it("opens a live provider TUI with Enter or Right Arrow and moves between project threads", () => {
    const second = session({ id: "22222222-2222-4222-8222-222222222222", cwd: "/repo/two" });
    const snapshot = fleet({ record: session() }, { record: second });
    const initial = createFleetState(snapshot);

    expect(transitionFleet(initial, snapshot, "enter", NOW_MS).action).toEqual({
      type: "attach",
      sessionId: session().id,
    });
    expect(transitionFleet(initial, snapshot, "right", NOW_MS).action).toEqual({
      type: "attach",
      sessionId: session().id,
    });
    expect(transitionFleet(initial, snapshot, "left", NOW_MS).action).toBeUndefined();
    expect(transitionFleet(initial, snapshot, "down", NOW_MS).state.selectedSessionId).toBe(second.id);
  });

  it("resumes the exact provider conversation when a terminal thread is opened", () => {
    const stoppedRecord = session({ executionState: "cancelled", exitCode: 129 });
    const snapshot = fleet({ record: stoppedRecord });
    const initial = createFleetState(snapshot);

    expect(transitionFleet(initial, snapshot, "right", NOW_MS).action).toEqual({
      type: "resume",
      sessionId: stoppedRecord.id,
    });
    expect(transitionFleet(initial, snapshot, "enter", NOW_MS).action).toEqual({
      type: "resume",
      sessionId: stoppedRecord.id,
    });
  });

  it("stops a live agent, then requires two more Ctrl+X presses before deletion", () => {
    const active = fleet({ record: session() });
    const initial = createFleetState(active);
    const stop = transitionFleet(initial, active, "ctrl+x", NOW_MS);
    expect(stop.action).toEqual({ type: "stop", sessionId: session().id });
    expect(stop.state.deleteConfirmation).toBeUndefined();

    const stopped = fleet({ record: session({ executionState: "cancelled", exitCode: 0 }) });
    const armed = transitionFleet(stop.state, stopped, "ctrl+x", NOW_MS);
    expect(armed.action).toBeUndefined();
    expect(armed.state.deleteConfirmation?.sessionId).toBe(session().id);

    const rendered = renderFleet(stopped, armed.state, {
      color: true,
      width: 140,
      height: 30,
      now: NOW_MS,
      home: "/Users/brandon",
    });
    expect(rendered).toContain("\u001b[31mpress ctrl+x again to delete");

    const remove = transitionFleet(armed.state, stopped, "ctrl+x", NOW_MS + 1);
    expect(remove.action).toEqual({ type: "delete", sessionId: session().id });
  });

  it("cancels pending deletion when selection moves or confirmation expires", () => {
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      executionState: "cancelled",
      exitCode: 0,
    });
    const snapshot = fleet(
      { record: session({ executionState: "cancelled", exitCode: 0 }) },
      { record: second },
    );
    const armed = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+x", NOW_MS).state;
    expect(transitionFleet(armed, snapshot, "down", NOW_MS).state.deleteConfirmation).toBeUndefined();

    const expired = transitionFleet(armed, snapshot, "ctrl+x", NOW_MS + 6_000);
    expect(expired.action).toBeUndefined();
    expect(expired.state.deleteConfirmation?.expiresAt).toBe(NOW_MS + 11_000);
  });

  it("starts a new thread from the selected explicit provider context", () => {
    const snapshot = fleet({ record: session() });
    const typed = { ...createFleetState(snapshot), draft: "Inspect the failing test" };
    const submitted = transitionFleet(typed, snapshot, "enter", NOW_MS);

    expect(submitted.action).toEqual({
      type: "start",
      request: {
        provider: "claude",
        cwd: "/Users/brandon/code/personal/cyberdeck",
        detached: true,
        sandbox: "read-only",
        model: "provider-native-model",
        name: "Inspect the failing test",
        initialPrompt: "Inspect the failing test",
      },
    });
    expect(submitted.state.draft).toBe("");
  });

  it("can bootstrap an empty fleet with an explicit provider command", () => {
    const snapshot = fleet();
    const initial = { ...createFleetState(snapshot, "/repo/empty"), draft: "/codex Fix the failing test" };
    const started = transitionFleet(initial, snapshot, "enter", NOW_MS);

    expect(started.action).toEqual({
      type: "start",
      request: {
        provider: "codex",
        cwd: "/repo/empty",
        detached: true,
        sandbox: "read-only",
        name: "Fix the failing test",
        initialPrompt: "Fix the failing test",
      },
    });
  });

  it("requires an explicit model when bootstrapping Claude", () => {
    const snapshot = fleet();
    const initial = { ...createFleetState(snapshot, "/repo/empty"), draft: "/claude Fix the failing test" };
    const blocked = transitionFleet(initial, snapshot, "enter", NOW_MS);

    expect(blocked.action).toBeUndefined();
    expect(blocked.state.draft).toBe("/claude Fix the failing test");
    expect(blocked.state.notice).toContain("/claude:MODEL");
  });
});

describe("collectFleetSnapshot", () => {
  it("loads replay for every durable session", async () => {
    const record = session();
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return [record];
      if (method === "session.snapshot") return { data: Buffer.from("latest").toString("base64") };
      throw new Error(`unexpected ${method}`);
    });

    await expect(collectFleetSnapshot({ request } as never)).resolves.toEqual({
      threads: [{ record, replay: "latest" }],
    });
    expect(request).toHaveBeenCalledWith("session.snapshot", { sessionId: record.id });
  });
});

describe("runFleet", () => {
  it("hands an opened thread to the native provider PTY and returns to the fleet on detach", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 120;
      rows = 30;
      chunks: Buffer[] = [];
      write(chunk: string | Uint8Array): boolean {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
        return true;
      }
    }

    const record = session();
    const frameListeners = new Set<(frame: never) => void>();
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [record];
        if (method === "session.snapshot") return { data: Buffer.from("LIST PREVIEW").toString("base64") };
        if (method === "session.attach") return { data: Buffer.from("NATIVE PROVIDER TUI").toString("base64") };
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame(listener: (frame: never) => void) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
      onClose(listener: () => void) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    const running = runFleet(transport as never, input, output, new EventEmitter());

    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.list", {}));
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    expect(Buffer.concat(output.chunks).toString()).toContain("\u001b[28;3H\u001b[?25h");
    input.emit("data", Buffer.from("\r"));
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.attach", { sessionId: record.id }));
    expect(Buffer.concat(output.chunks).toString()).toContain("NATIVE PROVIDER TUI");

    input.emit("data", Buffer.from([0x1d]));
    await vi.waitFor(() => expect(transport.sendFrame).toHaveBeenCalledWith({ type: "detach", sessionId: record.id }));
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    const renderedAfterDetach = Buffer.concat(output.chunks).toString();
    expect(renderedAfterDetach).toContain("\u001b[?1003l");
    expect(renderedAfterDetach).toContain("\u001b[?1006l");
    input.emit("data", Buffer.from("\u001b[<35;103;24M"));
    input.emit("data", Buffer.from([0x03]));

    await expect(running).resolves.toBeUndefined();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(Buffer.concat(output.chunks).toString()).not.toContain("› <35;103;24M");
  });
});
