import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import {
  collectFleetSnapshot,
  createFleetState,
  FleetKeyDecoder,
  renderFleet,
  runFleet,
  startFleetSession,
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

  it("keeps multiplexed rows single-line with indented markers, aligned previews, and right-aligned time", () => {
    const done = session({
      name: "Completed task",
      attentionState: "done",
      latestPreview: "The latest reply begins here.\nIts continuation stays inline.",
      updatedAt: "2026-07-22T09:59:46.000Z",
      displayOrder: 0,
    });
    const needsInput = session({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Approval task",
      attentionState: "needs-input",
      latestPreview: "Approval is required before continuing.",
      updatedAt: "2026-07-22T09:58:00.000Z",
      displayOrder: 1,
    });
    const snapshot = fleet({ record: done }, { record: needsInput });
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 76,
      height: 28,
      now: NOW_MS,
      home: "/Users/brandon",
    });
    const lines = rendered.split("\n");
    const doneLine = lines.find((line) => line.includes("Completed task"))!;
    const needsInputLine = lines.find((line) => line.includes("Approval task"))!;

    expect(lines).toContain("~/code/personal/cyberdeck");
    expect(doneLine).toMatch(/^  \*/u);
    expect(needsInputLine).toMatch(/^  ·/u);
    expect(doneLine).toContain("The latest reply begins");
    expect(doneLine).not.toContain("\n");
    expect(doneLine).toHaveLength(76);
    expect(needsInputLine).toHaveLength(76);
    expect(doneLine).toMatch(/14s$/u);
    expect(needsInputLine).toMatch(/ 2m$/u);
  });

  it("counts only running agents in the header while finished threads stay listed", () => {
    // The shape the fleet has right after a broker restart: durable history plus one live agent.
    const snapshot = fleet(
      { record: session({ name: "Still running", attentionState: "working", displayOrder: 0 }) },
      {
        record: session({
          id: "22222222-2222-4222-8222-222222222222",
          name: "Finished earlier",
          executionState: "exited",
          exitCode: 0,
          attentionState: "done",
          displayOrder: 1,
        }),
      },
      {
        record: session({
          id: "33333333-3333-4333-8333-333333333333",
          name: "Finished before that",
          executionState: "exited",
          exitCode: 0,
          attentionState: "done",
          displayOrder: 2,
        }),
      },
      {
        record: session({
          id: "44444444-4444-4444-8444-444444444444",
          name: "Died mid-task",
          executionState: "errored",
          attentionState: "failed",
          displayOrder: 3,
        }),
      },
    );

    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 150,
      height: 40,
      now: NOW_MS,
      home: "/Users/brandon",
    });

    expect(rendered).toContain("1 agents · 0 needs input · 1 working · 2 done · 1 failed");
    expect(rendered).toContain("Finished earlier");
    expect(rendered).toContain("Finished before that");
  });

  it("reads a session that died inside a live process as failed, never as needs input", () => {
    const errored = session({ executionState: "errored", attentionState: "failed" });
    expect(threadStatus({ record: errored, replay: "Codex needs your approval\nAllow" })).toBe("Failed");
    // Even with no persisted attention state, the execution state alone settles it.
    expect(threadStatus({
      record: session({ executionState: "errored" }),
      replay: "Codex needs your approval\nAllow",
    })).toBe("Failed");
  });

  it("colors both Done and Needs input markers and status labels", () => {
    const done = session({ attentionState: "done", displayOrder: 0 });
    const needsInput = session({
      id: "22222222-2222-4222-8222-222222222222",
      attentionState: "needs-input",
      displayOrder: 1,
    });
    const snapshot = fleet({ record: done }, { record: needsInput });
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: true,
      width: 120,
      height: 28,
      now: NOW_MS,
    });

    expect(rendered).toContain("\u001b[1m\u001b[38;2;120;198;121m*\u001b[0m\u001b[0m");
    expect(rendered).toContain("\u001b[38;2;212;168;91m·\u001b[0m");
    expect(rendered).toContain("\u001b[38;2;120;198;121mDone       \u001b[0m");
    expect(rendered).toContain("\u001b[38;2;212;168;91mNeeds input\u001b[0m");
  });

  it("keeps thread and project positions stable when lifecycle timestamps change", () => {
    const first = session({
      kind: "orchestrator",
      name: "First orchestrator",
      cwd: "/repo/one",
      createdAt: "2026-07-22T09:00:00.000Z",
      updatedAt: "2026-07-22T09:59:00.000Z",
    });
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "orchestrator",
      name: "Second orchestrator",
      cwd: "/repo/one",
      createdAt: "2026-07-22T09:01:00.000Z",
      updatedAt: "2026-07-22T09:58:00.000Z",
    });
    const otherProject = session({
      id: "33333333-3333-4333-8333-333333333333",
      kind: "orchestrator",
      name: "Other project",
      cwd: "/repo/two",
      createdAt: "2026-07-22T09:02:00.000Z",
      updatedAt: "2026-07-22T09:57:00.000Z",
    });
    const before = renderFleet(
      fleet({ record: first }, { record: second }, { record: otherProject }),
      createFleetState(fleet({ record: first }, { record: second }, { record: otherProject })),
      { color: false, width: 140, height: 30, now: NOW_MS },
    );
    const afterRecords = [
      {
        record: {
          ...first,
          executionState: "cancelled" as const,
          attachmentState: "detached" as const,
          attentionState: "stopped" as const,
          exitCode: 0,
          updatedAt: "2026-07-22T10:05:00.000Z",
          meaningfulUpdatedAt: "2026-07-22T10:05:00.000Z",
        },
      },
      { record: second },
      {
        record: {
          ...otherProject,
          attentionState: "needs-input" as const,
          updatedAt: "2026-07-22T10:06:00.000Z",
          meaningfulUpdatedAt: "2026-07-22T10:06:00.000Z",
        },
      },
    ];
    const afterSnapshot = fleet(...afterRecords);
    const after = renderFleet(
      afterSnapshot,
      createFleetState(afterSnapshot),
      { color: false, width: 140, height: 30, now: NOW_MS },
    );
    const positions = (rendered: string) => [
      rendered.indexOf("First orchestrator"),
      rendered.indexOf("Second orchestrator"),
      rendered.indexOf("Other project"),
    ];

    expect(positions(before)).toEqual([...positions(before)].sort((left, right) => left - right));
    expect(positions(after)).toEqual([...positions(after)].sort((left, right) => left - right));
  });

  it("rejects a persisted provider tip instead of repeating it as the thread preview", () => {
    const snapshot = fleet({
      record: session({
        latestPreview: "Tip: Try the Desktop app. Run 'codex app' or visit",
      }),
      replay: "",
    });
    const rendered = renderFleet(snapshot, createFleetState(snapshot), {
      color: false,
      width: 120,
      height: 28,
      now: NOW_MS,
    });

    expect(rendered).toContain("No response yet");
    expect(rendered).not.toContain("Tip: Try the Desktop app");
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
    const approval = fleet({
      record: session({ provider: "claude", model: "opus" }),
      replay: [
        "Claude needs your permission to use Bash",
        "Do you want to proceed?",
        "❯ 1. Yes",
        "  2. No",
        "Esc to cancel · Tab to amend",
      ].join("\n"),
    });
    expect(threadStatus(approval.threads[0]!)).toBe("Needs input");
    const rendered = renderFleet(approval, createFleetState(approval), {
      color: false,
      width: 120,
      height: 28,
      now: NOW_MS,
    });
    expect(rendered).toContain("1 needs input");
    expect(rendered).toContain("Needs input");
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
    expect(lines.at(-2)).toContain("cwd ~/code/personal/cyberdeck · ctrl+g change");
    expect(lines.at(-1)).toContain("enter open/start");
  });

  it("soft-wraps long composer drafts and expands the footer upward", () => {
    const snapshot = fleet({ record: session() });
    const draft = `${"a".repeat(47)}${"b".repeat(47)}${"c".repeat(10)}`;
    const rendered = renderFleet(snapshot, {
      ...createFleetState(snapshot),
      draft,
    }, {
      color: false,
      width: 50,
      height: 30,
      now: NOW_MS,
    });

    const lines = rendered.split("\n");
    expect(lines.at(-6)).toBe(`› ${"a".repeat(47)}`);
    expect(lines.at(-5)).toBe(`  ${"b".repeat(47)}`);
    expect(lines.at(-4)).toBe(`  ${"c".repeat(10)}`);
  });

  it("caps a large composer while keeping its newest wrapped rows visible", () => {
    const snapshot = fleet({ record: session() });
    const rendered = renderFleet(snapshot, {
      ...createFleetState(snapshot),
      draft: Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n"),
    }, {
      color: false,
      width: 50,
      height: 30,
      now: NOW_MS,
    });

    const lines = rendered.split("\n");
    expect(lines.at(-13)).toBe("… line 6");
    expect(lines.at(-4)).toBe("  line 15");
    expect(rendered).not.toContain("line 5");
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
    expect(rendered).toContain("ctrl+] detach/reattach");
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
  it("walks a new model and effort then creates a distinct orchestrator", () => {
    const snapshot = fleet();
    const initial = createFleetState(snapshot, "/repo/one");
    const target = transitionFleet(initial, snapshot, "ctrl+o", NOW_MS);
    expect(target.state.orchestratorPicker).toMatchObject({ step: "target" });
    expect(renderFleet(snapshot, target.state, { color: false, width: 110, height: 30 }))
      .toContain("No interactive orchestrators");
    const effort = transitionFleet(target.state, snapshot, "enter", NOW_MS);
    expect(effort.state.orchestratorPicker).toMatchObject({ step: "effort" });
    const lowEffort = transitionFleet(effort.state, snapshot, "down", NOW_MS);
    const launched = transitionFleet(lowEffort.state, snapshot, "enter", NOW_MS);
    expect(launched.action).toEqual({
      type: "create-orchestrator",
      cockpitCwd: "/repo/one",
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
    const target = transitionFleet(initial, snapshot, "ctrl+o", NOW_MS);
    const nextModel = transitionFleet(target.state, snapshot, "down", NOW_MS);
    const effort = transitionFleet(nextModel.state, snapshot, "enter", NOW_MS);
    const highEffort = transitionFleet(effort.state, snapshot, "down", NOW_MS);
    const back = transitionFleet(highEffort.state, snapshot, "escape", NOW_MS);

    expect(back.state.orchestratorPicker).toMatchObject({
      step: "target",
      choiceIndex: 1,
    });
  });

  it("switches to the exact selected existing orchestrator", () => {
    const current = session({
      id: "11111111-1111-4111-8111-111111111111",
      provider: "claude",
      model: "opus",
      effort: "high",
      kind: "orchestrator",
      role: "orchestrator",
      cwd: "/repo/one",
      orchestratorScope: "fleet",
      displayOrder: 0,
    });
    const peer = session({
      id: "22222222-2222-4222-8222-222222222222",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      kind: "orchestrator",
      role: "orchestrator",
      cwd: "/repo/one",
      orchestratorScope: "fleet",
      displayOrder: 1,
    });
    const snapshot = fleet({ record: current }, { record: peer });
    const opened = transitionFleet(createFleetState(snapshot, "/repo/one"), snapshot, "ctrl+o", NOW_MS);
    const selectedPeer = transitionFleet(opened.state, snapshot, "down", NOW_MS);
    const switched = transitionFleet(selectedPeer.state, snapshot, "enter", NOW_MS);

    expect(switched.action).toEqual({
      type: "open-orchestrator",
      sessionId: peer.id,
      cockpitCwd: "/repo/one",
      requiresResume: false,
    });
    expect(switched.state.selectedSessionId).toBe(peer.id);

    const reopened = transitionFleet(switched.state, snapshot, "ctrl+o", NOW_MS);
    const switchedBack = transitionFleet(reopened.state, snapshot, "enter", NOW_MS);
    expect(switchedBack.action).toEqual({
      type: "open-orchestrator",
      sessionId: current.id,
      cockpitCwd: "/repo/one",
      requiresResume: false,
    });
  });

  it("excludes workers and terminal orchestrators from the existing section", () => {
    const available = session({
      kind: "orchestrator",
      role: "orchestrator",
      name: "Available peer",
    });
    const worker = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "worker",
      role: "worker",
      name: "Must not appear",
    });
    const ended = session({
      id: "33333333-3333-4333-8333-333333333333",
      kind: "orchestrator",
      role: "orchestrator",
      name: "Ended peer",
      executionState: "exited",
      exitCode: 0,
    });
    const snapshot = fleet({ record: available }, { record: worker }, { record: ended });
    const picker = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+o", NOW_MS);
    const rendered = renderFleet(snapshot, picker.state, { color: false, width: 110, height: 30 });

    expect(rendered).toContain("Existing orchestrators");
    expect(rendered).toContain("Available peer");
    expect(rendered).toContain("New orchestrator");
    expect(rendered).not.toContain("Must not appear");
    expect(rendered).not.toContain("Ended peer");
  });

  it("labels a controller-held orchestrator and refuses to route somewhere else", () => {
    const controlled = session({
      kind: "orchestrator",
      role: "orchestrator",
      attachmentState: "controlled",
      name: "Busy peer",
    });
    const snapshot = fleet({ record: controlled });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+o", NOW_MS);
    const rendered = renderFleet(snapshot, opened.state, { color: false, width: 110, height: 30 });
    const refused = transitionFleet(opened.state, snapshot, "enter", NOW_MS);

    expect(rendered).toContain("Busy peer");
    expect(rendered).toContain("in use");
    expect(refused.action).toBeUndefined();
    expect(refused.state.orchestratorPicker).toBeDefined();
    expect(refused.state.notice).toContain("another controller");
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

  it("decodes Ctrl+] and attaches the exact selected orchestrator to the cockpit", () => {
    const decoder = new FleetKeyDecoder();
    expect(decoder.push(Buffer.from([0x1d]))).toEqual(["ctrl+]"]);
    expect(decoder.push(Buffer.from([0x1b]))).toEqual([]);
    expect(decoder.flush()).toEqual(["escape"]);

    const first = session({ kind: "orchestrator" });
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "orchestrator",
    });
    const snapshot = fleet({ record: first }, { record: second });
    const selectedSecond = transitionFleet(createFleetState(snapshot), snapshot, "down", NOW_MS).state;

    expect(transitionFleet(selectedSecond, snapshot, "ctrl+]", NOW_MS).action).toEqual({
      type: "open-orchestrator",
      sessionId: second.id,
      cockpitCwd: process.cwd(),
      requiresResume: false,
    });
  });

  it("uses Ctrl+G for cwd navigation while leaving Tab unbound", () => {
    const decoder = new FleetKeyDecoder();
    expect(decoder.push(Buffer.from([0x07]))).toEqual(["ctrl+g"]);
    expect(decoder.push(Buffer.from([0x09]))).toEqual([]);

    const snapshot = fleet({ record: session({ cwd: "/repo/one" }) });
    expect(transitionFleet(createFleetState(snapshot), snapshot, "ctrl+g", NOW_MS).action).toEqual({
      type: "change-directory",
      cwd: "/repo/one",
    });
  });

  it("launches from the explicitly selected composer cwd rather than the selected thread cwd", () => {
    const snapshot = fleet({ record: session({ cwd: "/repo/one", sandbox: "workspace-write" }) });
    const state = {
      ...createFleetState(snapshot),
      workingDirectory: "/repo/two",
      draft: "Inspect the failure",
      launchProfiles: {
        "/repo/two": { provider: "codex" as const, model: "gpt-5.6-sol" },
      },
    };

    expect(transitionFleet(state, snapshot, "enter", NOW_MS).action).toEqual({
      type: "start",
      request: expect.objectContaining({
        cwd: "/repo/two",
        sandbox: "workspace-write",
        initialPrompt: "Inspect the failure",
      }),
    });
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

  it("stops an initially done thread before allowing the separate deletion sequence", () => {
    const done = fleet({
      record: session({
        executionState: "exited",
        attentionState: "done",
        exitCode: 0,
      }),
    });
    const initial = createFleetState(done);

    const stop = transitionFleet(initial, done, "ctrl+x", NOW_MS);
    expect(stop.action).toEqual({ type: "stop-tree", sessionId: session().id });
    expect(stop.state.deleteConfirmation).toBeUndefined();
    expect(stop.state.notice).toBe("Stopping agent · 1/1 stopped");
    expect(renderFleet(done, stop.state, { color: false, width: 160, height: 28 }))
      .toContain("ctrl+x delete thread");

    const armed = transitionFleet(stop.state, done, "ctrl+x", NOW_MS + 1);
    expect(armed.action).toBeUndefined();
    expect(armed.state.deleteConfirmation?.sessionId).toBe(session().id);
    expect(armed.state.notice).toBe("Delete thread? press ctrl+x again");

    const stopped = fleet({
      record: {
        ...done.threads[0]!.record,
        attentionState: "stopped",
      },
    });
    expect(threadStatus(stopped.threads[0]!)).toBe("Stopped");

    expect(transitionFleet(armed.state, done, "ctrl+x", NOW_MS + 2).action).toEqual({
      type: "delete-tree",
      sessionId: session().id,
    });
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
    const stopped = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+x", NOW_MS).state;
    const armed = transitionFleet(stopped, snapshot, "ctrl+x", NOW_MS + 1).state;
    expect(transitionFleet(armed, snapshot, "down", NOW_MS).state.deleteConfirmation).toBeUndefined();

    const expired = transitionFleet(armed, snapshot, "ctrl+x", NOW_MS + 6_000);
    expect(expired.action).toBeUndefined();
    expect(expired.state.deleteConfirmation?.expiresAt).toBe(NOW_MS + 11_000);
  });

  it("never carries a Ctrl+X deletion confirmation onto another session ID", () => {
    const stopped = session({
      executionState: "cancelled",
      attentionState: "stopped",
      exitCode: 0,
      displayOrder: 0,
    });
    const active = session({
      id: "22222222-2222-4222-8222-222222222222",
      displayOrder: 1,
    });
    const snapshot = fleet({ record: stopped }, { record: active });
    const stop = transitionFleet(createFleetState(snapshot), snapshot, "ctrl+x", NOW_MS);
    expect(stop.action).toEqual({ type: "stop-tree", sessionId: stopped.id });
    const armed = transitionFleet(stop.state, snapshot, "ctrl+x", NOW_MS + 1);
    expect(armed.state.deleteConfirmation?.sessionId).toBe(stopped.id);

    const switched = transitionFleet(armed.state, snapshot, "alt+2", NOW_MS + 2);
    expect(switched.state.selectedSessionId).toBe(active.id);
    expect(switched.state.deleteConfirmation).toBeUndefined();

    const stopOther = transitionFleet(switched.state, snapshot, "ctrl+x", NOW_MS + 3);
    expect(stopOther.action).toEqual({ type: "stop-tree", sessionId: active.id });
    expect(stopOther.state.deleteConfirmation).toBeUndefined();
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

  it("opens slash palette only from an empty composer and filters commands", () => {
    const snapshot = fleet({ record: session() });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "/", NOW_MS);

    expect(opened.state.commandPalette).toMatchObject({
      level: "commands",
      selectedIndex: 0,
      scrollOffset: 0,
    });
    expect(renderFleet(snapshot, opened.state, {
      color: false,
      width: 100,
      height: 24,
    })).toContain("/permissions  Inspect or configure provider launch permissions");

    const filtered = [..."permissions"].reduce(
      (state, key) => transitionFleet(state, snapshot, key, NOW_MS).state,
      opened.state,
    );
    const rendered = renderFleet(snapshot, filtered, {
      color: false,
      width: 100,
      height: 24,
    });
    expect(rendered).toContain("/permissions");
    expect(rendered).not.toContain("/model  ");

    const existingDraft = { ...createFleetState(snapshot), draft: "task" };
    const appended = transitionFleet(existingDraft, snapshot, "/", NOW_MS).state;
    expect(appended.draft).toBe("task/");
    expect(appended.commandPalette).toBeUndefined();
  });

  it("navigates and scrolls slash commands, then Escape closes and clears them", () => {
    const snapshot = fleet({ record: session() });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "/", NOW_MS);
    const second = transitionFleet(opened.state, snapshot, "down", NOW_MS);
    const third = transitionFleet(second.state, snapshot, "down", NOW_MS);
    const fourth = transitionFleet(third.state, snapshot, "down", NOW_MS);

    expect(fourth.state.commandPalette).toMatchObject({
      selectedIndex: 3,
      scrollOffset: 1,
    });
    const rendered = renderFleet(snapshot, fourth.state, {
      color: false,
      width: 100,
      height: 24,
    });
    expect(rendered).toContain("2-4 of 4");
    expect(rendered).not.toContain("/model  ");

    expect(transitionFleet(fourth.state, snapshot, "escape", NOW_MS).state)
      .toMatchObject({ draft: "", commandPalette: undefined });
  });

  it("exposes nested command values and completes the selected value", () => {
    const orchestrator = session({
      kind: "orchestrator",
      cwd: "/repo/one",
      orchestratorScope: "workspace",
    });
    const snapshot = fleet({ record: orchestrator });
    const opened = transitionFleet(createFleetState(snapshot), snapshot, "/", NOW_MS);
    const permissions = transitionFleet(opened.state, snapshot, "down", NOW_MS);
    const fable = transitionFleet(permissions.state, snapshot, "down", NOW_MS);
    const values = transitionFleet(fable.state, snapshot, "enter", NOW_MS);

    expect(values.state).toMatchObject({
      draft: "/fable-workers ",
      commandPalette: { level: "values", command: "/fable-workers" },
    });
    expect(renderFleet(snapshot, values.state, {
      color: false,
      width: 100,
      height: 24,
    })).toContain("on  Enable Fable workers");

    const on = transitionFleet(values.state, snapshot, "down", NOW_MS);
    expect(transitionFleet(on.state, snapshot, "enter", NOW_MS)).toMatchObject({
      state: { draft: "", commandPalette: undefined },
      action: {
        type: "fable-workers",
        request: { cwd: "/repo/one", scope: "workspace", enabled: true },
      },
    });
  });

  it("inspects and persists explicit provider permission policies", () => {
    const snapshot = fleet({ record: session() });
    const command = { ...createFleetState(snapshot), draft: "/permissions" };
    const providers = transitionFleet(command, snapshot, "enter", NOW_MS);
    const claude = transitionFleet(providers.state, snapshot, "down", NOW_MS);
    const policies = transitionFleet(claude.state, snapshot, "enter", NOW_MS);
    const automatic = transitionFleet(policies.state, snapshot, "down", NOW_MS);
    const applied = transitionFleet(automatic.state, snapshot, "enter", NOW_MS);

    expect(renderFleet(snapshot, automatic.state, {
      color: false,
      width: 100,
      height: 24,
    })).toContain("automatic  auto mode · --permission-mode auto");
    expect(applied.state.permissionPolicies.claude).toBe("automatic");
    expect(applied.action).toEqual({
      type: "permission-policy",
      provider: "claude",
      policy: "automatic",
      previousPolicy: "permissioned",
    });
    expect(applied.state.notice).toBe("Claude permissions: auto mode");
  });

  it("fails visibly for an unsupported provider permission policy", () => {
    const snapshot = fleet({ record: session() });
    const command = { ...createFleetState(snapshot), draft: "/permissions" };
    let state = transitionFleet(command, snapshot, "enter", NOW_MS).state;
    state = transitionFleet(state, snapshot, "down", NOW_MS).state;
    state = transitionFleet(state, snapshot, "down", NOW_MS).state;
    state = transitionFleet(state, snapshot, "down", NOW_MS).state;
    state = transitionFleet(state, snapshot, "enter", NOW_MS).state;
    state = transitionFleet(state, snapshot, "down", NOW_MS).state;
    const refused = transitionFleet(state, snapshot, "enter", NOW_MS);

    expect(refused.action).toBeUndefined();
    expect(refused.state.permissionPicker).toMatchObject({
      step: "policy",
      providerIndex: 3,
      policyIndex: 1,
    });
    expect(refused.state.notice).toBe(
      "Antigravity does not support automatic permission policy",
    );
    expect(renderFleet(snapshot, refused.state, {
      color: false,
      width: 100,
      height: 24,
    })).toContain("Antigravity does not support automatic permission policy");
  });

  it("applies Composer automatic mode before submitting the initial prompt", async () => {
    const snapshot = fleet({ record: session({ provider: "cursor", model: "composer" }) });
    const state = {
      ...createFleetState(snapshot),
      draft: "Fix the failing test",
      permissionPolicies: {
        ...createFleetState(snapshot).permissionPolicies,
        cursor: "automatic" as const,
      },
      launchProfiles: {
        "/Users/brandon/code/personal/cyberdeck": {
          provider: "cursor",
          model: "composer",
        },
      },
    };
    const transition = transitionFleet(state, snapshot, "enter", NOW_MS);
    expect(transition.action).toMatchObject({
      type: "start",
      permissionLaunch: {
        provider: "cursor",
        policy: "automatic",
        nativeMode: "/run-everything",
        application: {
          kind: "post-launch-command",
          command: "/run-everything",
        },
      },
    });

    const started = session({
      id: "22222222-2222-4222-8222-222222222222",
      provider: "cursor",
      model: "composer",
    });
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "session.start") return started;
      if (method === "session.submit") return { submitted: true };
      throw new Error(`unexpected ${method}`);
    });
    await expect(startFleetSession(
      { request } as never,
      transition.action as Extract<NonNullable<typeof transition.action>, { type: "start" }>,
    )).resolves.toEqual(started);

    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      [
        "session.start",
        expect.objectContaining({
          provider: "cursor",
          model: "composer",
          cwd: "/Users/brandon/code/personal/cyberdeck",
        }),
      ],
      [
        "session.submit",
        { sessionId: started.id, message: "/run-everything" },
      ],
      [
        "session.submit",
        { sessionId: started.id, message: "Fix the failing test" },
      ],
    ]);
  });

  it("applies persisted Codex automatic mode to newly spawned sessions", () => {
    const snapshot = fleet({ record: session({ provider: "codex" }) });
    const state = {
      ...createFleetState(snapshot),
      draft: "Run the checks",
      permissionPolicies: {
        ...createFleetState(snapshot).permissionPolicies,
        codex: "automatic" as const,
      },
      launchProfiles: {
        "/Users/brandon/code/personal/cyberdeck": {
          provider: "codex",
          model: "gpt-5.6-sol",
        },
      },
    };

    expect(transitionFleet(state, snapshot, "enter", NOW_MS).action).toMatchObject({
      type: "start",
      request: {
        provider: "codex",
        model: "gpt-5.6-sol",
        approvalMode: "auto",
        initialPrompt: "Run the checks",
      },
    });
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
  it("visibly applies a Ctrl+G cwd selection before launch", async () => {
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
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [];
        if (method === "fleet.preferences") return {};
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    const changeDirectory = vi.fn(async () => "/repo/two");
    const running = runFleet(
      transport as never,
      input,
      output,
      new EventEmitter(),
      { changeDirectory, detachIdentity: "operator:one" },
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from([0x07]));
    await vi.waitFor(() => expect(changeDirectory).toHaveBeenCalledWith(process.cwd()));
    await vi.waitFor(() => expect(Buffer.concat(output.chunks).toString()).toContain(
      "cwd /repo/two · ctrl+g change",
    ));

    input.emit("data", Buffer.from([0x1d]));
    await vi.waitFor(() => expect(Buffer.concat(output.chunks).toString()).toContain(
      "Select a detached orchestrator to attach to the cockpit",
    ));

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("creates and presents a second independent orchestrator through the cockpit", async () => {
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

    const current = session({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "orchestrator",
      role: "orchestrator",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      attachmentState: "detached",
    });
    const created = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "orchestrator",
      role: "orchestrator",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      attachmentState: "detached",
    });
    const sessions = [current];
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return sessions;
        if (method === "session.snapshot") return { data: "" };
        if (method === "fleet.preferences") return {};
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
    const input = new Input();
    const openOrchestrator = vi.fn(async () => {
      sessions.push(created);
      return created;
    });
    const running = runFleet(
      transport as never,
      input,
      new Output(),
      new EventEmitter(),
      { detachIdentity: "operator:one", openOrchestrator },
    );
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from([0x0f]));
    input.emit("data", Buffer.from("\u001b[B\r"));
    input.emit("data", Buffer.from("\u001b[B\u001b[B\u001b[B\r"));
    await vi.waitFor(() => expect(openOrchestrator).toHaveBeenCalledWith({
      type: "create",
      cockpitCwd: process.cwd(),
      request: {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        cwd: process.cwd(),
        scope: "fleet",
      },
    }));
    expect(current.executionState).toBe("active");
    expect(current.id).not.toBe(created.id);
    expect(sessions).toEqual([current, created]);

    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });

  it("attaches the selected detached orchestrator to the cockpit", async () => {
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

    const first = session({
      kind: "orchestrator",
      name: "First orchestrator",
      displayOrder: 0,
    });
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "orchestrator",
      name: "Second orchestrator",
      displayOrder: 1,
    });
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [first, second];
        if (method === "session.snapshot") return { data: "" };
        if (method === "fleet.preferences") return {};
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose(listener: () => void) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    const openOrchestrator = vi.fn(async () => second);
    const running = runFleet(
      transport as never,
      input,
      output,
      new EventEmitter(),
      { detachIdentity: "operator:one", openOrchestrator },
    );

    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.list", {}));
    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    input.emit("data", Buffer.from("\u001b[B"));
    input.emit("data", Buffer.from([0x1d]));
    await vi.waitFor(() => expect(openOrchestrator).toHaveBeenCalledWith({
      type: "existing",
      session: second,
      cockpitCwd: process.cwd(),
      requiresResume: false,
    }));
    expect(transport.request).not.toHaveBeenCalledWith("fleet.reattach", expect.anything());

    await vi.waitFor(() => expect(input.isRaw).toBe(true));
    input.emit("data", Buffer.from([0x03, 0x03]));

    await expect(running).resolves.toBeUndefined();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("places the cursor on the final soft-wrapped composer row", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 50;
      rows = 30;
      chunks: Buffer[] = [];
      write(chunk: string | Uint8Array): boolean {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
        return true;
      }
    }

    const record = session();
    const closeListeners = new Set<() => void>();
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "session.list") return [record];
        if (method === "session.snapshot") return { data: "" };
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
    const input = new Input();
    const output = new Output();
    const running = runFleet(transport as never, input, output, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from(`${"a".repeat(47)}${"b".repeat(13)}`));
    await vi.waitFor(() => {
      const screen = Buffer.concat(output.chunks).toString();
      expect(screen).toContain(`› ${"a".repeat(47)}\n  ${"b".repeat(13)}`);
      expect(screen).toContain("\u001b[27;16H\u001b[?25h");
    });

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
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

  it("keeps the selector at the deleted row position instead of resetting to the top", async () => {
    class Input extends EventEmitter {
      isTTY = true;
      isRaw = false;
      setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class Output {
      isTTY = false;
      columns = 100;
      rows = 30;
      chunks: Buffer[] = [];
      write(chunk: string | Uint8Array): boolean {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
        return true;
      }
    }

    const first = session({
      name: "First thread",
      executionState: "cancelled",
      attentionState: "stopped",
      exitCode: 0,
      displayOrder: 0,
    });
    const second = session({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Second thread",
      executionState: "cancelled",
      attentionState: "stopped",
      exitCode: 0,
      displayOrder: 1,
    });
    const third = session({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Third thread",
      executionState: "cancelled",
      attentionState: "stopped",
      exitCode: 0,
      displayOrder: 2,
    });
    let records = [first, second, third];
    const transport = {
      request: vi.fn(async (method: string, params: { sessionId?: string }) => {
        if (method === "session.list") return records;
        if (method === "session.snapshot") return { data: "" };
        if (method === "session.stop") {
          return {
            rootSessionId: params.sessionId,
            rootKind: "worker",
            childCount: 0,
            total: 1,
            active: 0,
            stopping: 0,
            terminal: 1,
          };
        }
        if (method === "session.deleteTree") {
          records = records.filter((record) => record.id !== params.sessionId);
          return {
            rootSessionId: params.sessionId,
            rootKind: "worker",
            childCount: 0,
            total: 1,
            active: 0,
            stopping: 0,
            terminal: 1,
          };
        }
        throw new Error(`unexpected ${method}`);
      }),
      sendFrame: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClose: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    const input = new Input();
    const output = new Output();
    const running = runFleet(transport as never, input, output, new EventEmitter());
    await vi.waitFor(() => expect(input.isRaw).toBe(true));

    input.emit("data", Buffer.from("\u001b[B"));
    input.emit("data", Buffer.from([0x18, 0x18, 0x18]));
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith("session.deleteTree", {
      sessionId: second.id,
    }));
    await vi.waitFor(() => {
      const latestScreen = Buffer.concat(output.chunks).toString().split("\u001b[2J\u001b[H").at(-1) ?? "";
      expect(latestScreen).toContain("Deleted thread");
      expect(latestScreen).toContain("  * Third thread");
      expect(latestScreen).not.toContain("  * First thread");
    });

    input.emit("data", Buffer.from([0x03, 0x03]));
    await expect(running).resolves.toBeUndefined();
  });
});
