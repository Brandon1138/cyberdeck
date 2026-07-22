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
    expect(rendered).toContain("Claude provider-nat…");
    expect(rendered).toContain("Codex another-model…");
    expect(rendered).toContain("Done");
    expect(rendered).toContain("Latest useful response");
    expect(rendered).toContain("14s");
    expect(rendered).not.toMatch(/recommend|preferred|fallback/i);
  });

  it("uses provider activity for working but reserves Needs input for explicit blockers", () => {
    expect(threadStatus({
      record: session(),
      replay: "\u001b]0;⠹ cyberdeck\u0007",
    })).toBe("Working");
    expect(threadStatus({
      record: session(),
      replay: "\u001b]0;cyberdeck\u0007",
    })).toBe("Done");
    expect(threadStatus({
      record: session(),
      replay: "Do you trust the contents of this project?",
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
    const rendered = renderFleet(snapshot, {
      ...createFleetState(snapshot),
      draft: "Inspect the failure",
      launchProfiles: {
        "/Users/brandon/code/personal/cyberdeck": {
          provider: "claude",
          model: "opus",
          effort: "high",
        },
      },
    }, {
      color: false,
      width: 100,
      height: 28,
      now: NOW_MS,
      home: "/Users/brandon",
    });

    const lines = rendered.split("\n");
    expect(lines.at(-4)).toBe("› Inspect the failure");
    expect(lines.at(-2)).toContain("▶ Claude Opus · high · read-only");
    expect(lines.at(-1)).toContain("enter open/start");
  });

  it("shows Ctrl+O as the first-class orchestrator command", () => {
    const snapshot = fleet({ record: session() });
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 110,
      height: 28,
      now: NOW_MS,
    });

    expect(rendered).toContain("ctrl+o to choose");
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
  it("walks model and effort then opens an orchestrator without confirmation", () => {
    const snapshot = fleet();
    const initial = createFleetState(snapshot, "/repo/one");
    const model = transitionFleet(initial, snapshot, "ctrl+o", NOW_MS);
    expect(model.state.orchestratorPicker).toMatchObject({ step: "model" });
    const effort = transitionFleet(model.state, snapshot, "enter", NOW_MS);
    expect(effort.state.orchestratorPicker).toMatchObject({ step: "effort" });
    const lowEffort = transitionFleet(effort.state, snapshot, "down", NOW_MS);
    const launched = transitionFleet(lowEffort.state, snapshot, "enter", NOW_MS);
    expect(launched.action).toEqual({
      type: "orchestrator",
      request: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "low",
        cwd: "/repo/one",
        scope: "fleet",
      },
    });
    expect(launched.state.orchestratorPicker).toBeUndefined();
  });

  it("uses arrows in the picker and Escape moves back one step", () => {
    const snapshot = fleet();
    const initial = createFleetState(snapshot, "/repo/one");
    const model = transitionFleet(initial, snapshot, "ctrl+o", NOW_MS);
    const nextModel = transitionFleet(model.state, snapshot, "down", NOW_MS);
    const effort = transitionFleet(nextModel.state, snapshot, "enter", NOW_MS);
    const highEffort = transitionFleet(effort.state, snapshot, "down", NOW_MS);
    const back = transitionFleet(highEffort.state, snapshot, "escape", NOW_MS);

    expect(back.state.orchestratorPicker).toMatchObject({
      step: "model",
      choiceIndex: 1,
      effortIndex: 1,
    });
  });

  it("preselects the fleet orchestrator so quick Enter reopens it from any project", () => {
    const current = session({
      provider: "claude",
      model: "opus",
      effort: "high",
      kind: "orchestrator",
      cwd: "/repo/one",
      orchestratorScope: "fleet",
    });
    const snapshot = fleet({ record: current });
    const opened = transitionFleet(createFleetState(snapshot, "/repo/two"), snapshot, "ctrl+o", NOW_MS);

    expect(opened.state.orchestratorPicker).toMatchObject({
      choiceIndex: 3,
      effortIndex: 3,
    });
  });

  it("renders a fleet orchestrator independently of its process cwd", () => {
    const current = session({
      kind: "orchestrator",
      cwd: "/repo/one",
      orchestratorScope: "fleet",
    });
    const snapshot = fleet({ record: current });
    const rendered = renderFleet(snapshot, createFleetState(snapshot, "/repo/two"), {
      color: false,
      width: 110,
      height: 28,
      now: NOW_MS,
    });

    expect(rendered).toContain("provider-native-model · Provider managed · fleet");
    expect(rendered).not.toContain("provider-native-model · Provider managed · /repo/one");
  });

  it("decodes Ctrl+O without inserting it into the task composer", () => {
    expect(new FleetKeyDecoder().push(Buffer.from([0x0f]))).toEqual(["ctrl+o"]);
  });

  it("decodes shortcut-panel keys without leaking escape sequences into the composer", () => {
    const decoder = new FleetKeyDecoder();
    expect(decoder.push("\u001b[1;2A\u001b[1;2B\u001b1")).toEqual(["shift+up", "shift+down", "alt+1"]);
    expect(decoder.push(Buffer.from([0x0a, 0x12, 0x13, 0x14]))).toEqual([
      "ctrl+j", "ctrl+r", "ctrl+s", "ctrl+t",
    ]);
  });

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
    expect(stop.action).toEqual({ type: "stop-tree", sessionId: session().id });
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
    expect(rendered).toContain("Delete thread? press ctrl+x again");
    expect(rendered.match(/Delete thread\?/gu)).toHaveLength(1);

    const remove = transitionFleet(armed.state, stopped, "ctrl+x", NOW_MS + 1);
    expect(remove.action).toEqual({ type: "delete-tree", sessionId: session().id });
  });

  it("stops and deletes an orchestrator tree from the parent row without hunting children", () => {
    const root = session({ kind: "orchestrator", childIds: ["22222222-2222-4222-8222-222222222222"] });
    const child = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      role: "worker",
      parentSessionId: root.id,
    });
    const active = fleet({ record: root }, { record: child });
    const stop = transitionFleet(createFleetState(active), active, "ctrl+x", NOW_MS);

    expect(stop.action).toEqual({ type: "stop-tree", sessionId: root.id });
    expect(stop.state.notice).toBe("Stopping orchestrator + 1 worker · 0/2 stopped");
    const stopping = renderFleet(active, stop.state, {
      color: true,
      width: 140,
      height: 30,
      now: NOW_MS,
      home: "/Users/brandon",
    });
    expect(stopping).toContain("\u001b[38;2;212;168;91mStopping orchestrator + 1 worker · 0/2 stopped");
    expect(stopping).not.toContain("\u001b[38;2;217;108;117mStopping orchestrator");

    const terminal = fleet(
      { record: { ...root, executionState: "cancelled", attentionState: "stopped", exitCode: 0 } },
      { record: { ...child, executionState: "cancelled", attentionState: "stopped", exitCode: 0 } },
    );
    const armed = transitionFleet(stop.state, terminal, "ctrl+x", NOW_MS);
    expect(armed.state.notice).toBe("Delete orchestrator + 1 child thread? press ctrl+x again");
    const rendered = renderFleet(terminal, armed.state, {
      color: true,
      width: 140,
      height: 30,
      now: NOW_MS,
      home: "/Users/brandon",
    });
    expect(rendered).toContain("\u001b[38;2;217;108;117mDelete orchestrator + 1 child thread? press ctrl+x again");
    expect(rendered).not.toContain("Delete tree?");
    expect(transitionFleet(armed.state, terminal, "ctrl+x", NOW_MS + 1).action).toEqual({
      type: "delete-tree",
      sessionId: root.id,
    });
  });

  it("retries tree cleanup with progress instead of reporting only that the agent is stopping", () => {
    const root = session({
      kind: "orchestrator",
      executionState: "cancelled",
      attentionState: "stopping",
      exitCode: null,
      childIds: ["22222222-2222-4222-8222-222222222222"],
    });
    const child = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      parentSessionId: root.id,
      executionState: "cancelled",
      attentionState: "stopped",
      exitCode: 0,
    });
    const snapshot = fleet({ record: root }, { record: child });
    const retry = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+x", NOW_MS);

    expect(retry.action).toEqual({ type: "stop-tree", sessionId: root.id });
    expect(retry.state.notice).toBe("Stopping orchestrator + 1 worker · 1/2 stopped");
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

  it("requires two consecutive Ctrl+C presses and never exits on Escape", () => {
    const snapshot = fleet({ record: session() });
    const initial = createFleetState(snapshot);

    const armed = transitionFleet(initial, snapshot, "ctrl+c", NOW_MS);
    expect(armed.action).toBeUndefined();
    expect(armed.state.notice).toBe("Press ctrl+c again to exit");
    expect(armed.state.quitConfirmation?.expiresAt).toBe(NOW_MS + 5_000);

    const cancelled = transitionFleet(armed.state, snapshot, "?", NOW_MS + 1);
    expect(cancelled.state.quitConfirmation).toBeUndefined();
    expect(cancelled.state.notice).toBeUndefined();
    expect(transitionFleet(cancelled.state, snapshot, "ctrl+c", NOW_MS + 2).action).toBeUndefined();

    const confirmed = transitionFleet(armed.state, snapshot, "ctrl+c", NOW_MS + 1);
    expect(confirmed.action).toEqual({ type: "quit" });

    const expired = transitionFleet(armed.state, snapshot, "ctrl+c", NOW_MS + 5_001);
    expect(expired.action).toBeUndefined();
    expect(expired.state.quitConfirmation?.expiresAt).toBe(NOW_MS + 10_001);

    expect(transitionFleet(initial, snapshot, "escape", NOW_MS).action).toBeUndefined();
    const help = transitionFleet(initial, snapshot, "?", NOW_MS).state;
    const closedHelp = transitionFleet(help, snapshot, "escape", NOW_MS);
    expect(closedHelp.action).toBeUndefined();
    expect(closedHelp.state.helpOpen).toBe(false);
  });

  it("configures a new worker through /model then effort with no confirmation", () => {
    const snapshot = fleet({ record: session() });
    const command = { ...createFleetState(snapshot), draft: "/model" };
    const model = transitionFleet(command, snapshot, "enter", NOW_MS);
    expect(model.state.workerPicker).toMatchObject({ step: "model", modelIndex: 0 });
    const rendered = renderFleet(snapshot, model.state, { color: false, width: 100, height: 28 });
    expect(rendered).toContain("Codex Luna");
    expect(rendered).toContain("Claude Opus");
    expect(rendered).toContain("Claude Fable");
    expect(rendered).toContain("Cursor Composer");
    expect(rendered).toContain("Gemini 3.6 Flash");

    const effort = transitionFleet(model.state, snapshot, "enter", NOW_MS);
    expect(effort.state.workerPicker).toMatchObject({ step: "effort" });
    const medium = transitionFleet(effort.state, snapshot, "down", NOW_MS);
    const high = transitionFleet(medium.state, snapshot, "down", NOW_MS);
    const applied = transitionFleet(high.state, snapshot, "enter", NOW_MS);
    expect(applied.state.workerPicker).toBeUndefined();
    expect(applied.state.launchProfiles["/Users/brandon/code/personal/cyberdeck"]).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
      effort: "high",
    });

    const typed = { ...applied.state, draft: "Inspect the failing test" };
    const submitted = transitionFleet(typed, snapshot, "enter", NOW_MS);

    expect(submitted.action).toEqual({
      type: "start",
      request: {
        provider: "codex",
        cwd: "/Users/brandon/code/personal/cyberdeck",
        detached: true,
        sandbox: "read-only",
        model: "gpt-5.6-luna",
        effort: "high",
        name: "Inspect the failing test",
        initialPrompt: "Inspect the failing test",
      },
    });
    expect(submitted.state.draft).toBe("");
  });

  it("opens /model instead of parsing provider syntax when no launch profile exists", () => {
    const snapshot = fleet();
    const initial = { ...createFleetState(snapshot, "/repo/empty"), draft: "Fix the failing test" };
    const picker = transitionFleet(initial, snapshot, "enter", NOW_MS);
    expect(picker.action).toBeUndefined();
    expect(picker.state.workerPicker).toMatchObject({ cwd: "/repo/empty", returnDraft: "Fix the failing test" });
  });

  it("routes /fable-workers on to the selected durable orchestrator binding", () => {
    const orchestrator = session({
      kind: "orchestrator",
      provider: "claude",
      model: "fable",
      cwd: "/repo/one",
      orchestratorScope: "workspace",
    });
    const snapshot = fleet({ record: orchestrator });
    const state = { ...createFleetState(snapshot), draft: "/fable-workers on" };

    expect(transitionFleet(state, snapshot, "enter", NOW_MS)).toMatchObject({
      state: { draft: "" },
      action: {
        type: "fable-workers",
        request: { cwd: "/repo/one", scope: "workspace", enabled: true },
      },
    });
  });

  it("routes /caveman-workers on to the box preference without an orchestrator", () => {
    const snapshot = fleet();
    const state = { ...createFleetState(snapshot), draft: "/caveman-workers on" };

    expect(transitionFleet(state, snapshot, "enter", NOW_MS)).toMatchObject({
      state: { draft: "" },
      action: {
        type: "caveman-workers",
        request: { enabled: true },
      },
    });
  });

  it("reports the missing orchestrator instead of treating /fable-workers as a task", () => {
    const snapshot = fleet();
    const state = { ...createFleetState(snapshot), draft: "/fable-workers status" };
    const transition = transitionFleet(state, snapshot, "enter", NOW_MS);

    expect(transition.action).toBeUndefined();
    expect(transition.state.notice).toContain("No orchestrator is bound");
  });

  it("toggles the shortcut panel and exposes keyboard interactions", () => {
    const snapshot = fleet({ record: session() });
    const open = transitionFleet(createFleetState(snapshot), snapshot, "?", NOW_MS);
    const rendered = renderFleet(snapshot, open.state, { color: false, width: 120, height: 30 });
    expect(rendered).toContain("shift+↑↓ reorder");
    expect(rendered).toContain("ctrl+r rename");
    expect(rendered).toContain("ctrl+t pin to top");
    expect(transitionFleet(open.state, snapshot, "?", NOW_MS).state.helpOpen).toBe(false);
  });

  it("maps rename, pin, reorder, view, mention, and numbered-open shortcuts", () => {
    const second = session({ id: "22222222-2222-4222-8222-222222222222", name: "Second thread" });
    const snapshot = fleet({ record: session() }, { record: second });
    const initial = createFleetState(snapshot);

    expect(transitionFleet(initial, snapshot, "ctrl+t", NOW_MS).action).toEqual({
      type: "pin", sessionId: session().id,
    });
    expect(transitionFleet(initial, snapshot, "shift+down", NOW_MS).action).toEqual({
      type: "reorder", sessionId: session().id, direction: "down",
    });
    expect(transitionFleet(initial, snapshot, "alt+2", NOW_MS).action).toEqual({
      type: "attach", sessionId: second.id,
    });
    expect(transitionFleet(initial, snapshot, "ctrl+s", NOW_MS).state.view).toBe("diagnostics");
    expect(transitionFleet(initial, snapshot, "@", NOW_MS).state.draft).toContain("@Implement-modular");

    const renaming = transitionFleet(initial, snapshot, "ctrl+r", NOW_MS);
    expect(renaming.state.rename?.sessionId).toBe(session().id);
    expect(transitionFleet(renaming.state, snapshot, "enter", NOW_MS).action).toEqual({
      type: "rename",
      sessionId: session().id,
      name: "Implement modular cryptographic scheme",
    });
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
  it("opens the selected orchestrator from the Ctrl+O picker", async () => {
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
      write(_chunk: string | Uint8Array): boolean { return true; }
    }

    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [];
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close: vi.fn(),
    };
    const openOrchestrator = vi.fn(async () => undefined);
    const input = new Input();
    const running = runFleet(
      transport as never,
      input,
      new Output(),
      new EventEmitter(),
      { openOrchestrator },
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from([0x0f]));
    input.emit("data", Buffer.from("\r\r"));
    await vi.waitFor(() => expect(openOrchestrator).toHaveBeenCalledWith({
      provider: "codex",
      model: "gpt-5.6-sol",
      cwd: process.cwd(),
      scope: "fleet",
    }));

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

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
    expect(Buffer.concat(output.chunks).toString()).toContain("\u001b[27;3H\u001b[?25h");
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
    input.emit("data", Buffer.from([0x03, 0x03]));

    await expect(running).resolves.toBeUndefined();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(Buffer.concat(output.chunks).toString()).not.toContain("› <35;103;24M");
  });

  it("stops a detached orchestrator on the first Ctrl+X without deleting it", async () => {
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
      write(_chunk: string | Uint8Array): boolean { return true; }
    }

    const orchestrator = session({
      kind: "orchestrator",
      executionState: "active",
      attachmentState: "detached",
      detached: true,
      exitCode: null,
    });
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [orchestrator];
        if (method === "session.snapshot") return { data: "" };
        if (method === "session.stop") {
          return {
            rootSessionId: orchestrator.id,
            rootKind: "orchestrator",
            childCount: 0,
            total: 1,
            active: 0,
            stopping: 1,
            terminal: 0,
          };
        }
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      close: vi.fn(),
    };
    const input = new Input();
    const running = runFleet(transport as never, input, new Output(), new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from([0x18]));
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.stop", {
      sessionId: orchestrator.id,
    }));
    expect(transport.request).not.toHaveBeenCalledWith("session.deleteTree", expect.anything());

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });
});
