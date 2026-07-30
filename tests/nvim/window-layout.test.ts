import { describe, expect, it, vi } from "vitest";
import {
  findLiveOrchestratorPane,
  type SpawnSyncLike,
} from "../../src/tmux/cockpit.js";
import {
  planWindowLayout,
  rebalanceNvimWindow,
  startsThisCliAttach,
  type WindowLayoutPane,
  type WindowLayoutRole,
} from "../../src/nvim/window-layout.js";

function pane(
  paneId: string,
  role: WindowLayoutRole | undefined,
  left: number,
  width: number,
  overrides: Partial<WindowLayoutPane> = {},
): WindowLayoutPane {
  return {
    paneId,
    dead: false,
    left,
    top: 0,
    height: 40,
    width,
    currentCommand: role === "nvim" ? "nvim" : "node",
    startCommand: role === "orc" ? "/opt/cyberdeck attach orc-session" : "/opt/cyberdeck",
    role,
    ...overrides,
  };
}

describe("planWindowLayout", () => {
  it.each([
    {
      name: "Fleet alone",
      width: 235,
      panes: [pane("%1", "fleet", 0, 235)],
      state: "fleet",
      usable: 235,
      resizes: [],
    },
    {
      name: "Fleet and Orc",
      width: 235,
      panes: [pane("%1", "fleet", 0, 117), pane("%2", "orc", 118, 117)],
      state: "fleet-orc",
      usable: 234,
      resizes: [{ paneId: "%1", width: 117 }],
    },
    {
      name: "Fleet and nvim",
      width: 235,
      panes: [pane("%1", "fleet", 0, 117), pane("%3", "nvim", 118, 117)],
      state: "fleet-nvim",
      usable: 234,
      resizes: [{ paneId: "%1", width: 117 }],
    },
    {
      name: "Fleet, Orc, and nvim",
      width: 235,
      panes: [
        pane("%1", "fleet", 0, 64),
        pane("%2", "orc", 65, 52),
        pane("%3", "nvim", 118, 117),
      ],
      state: "fleet-orc-nvim",
      usable: 233,
      resizes: [{ paneId: "%1", width: 64 }, { paneId: "%2", width: 52 }],
    },
  ])("plans $name", ({ width, panes, state, usable, resizes }) => {
    expect(planWindowLayout({
      windowWidth: width,
      windowHeight: 40,
      windowZoomed: false,
      panes,
    })).toMatchObject({
      state,
      usableWidth: usable,
      resizes,
    });
  });

  it("sorts resize commands left-to-right and never explicitly resizes the rightmost pane", () => {
    const plan = planWindowLayout({
      windowWidth: 235,
      windowHeight: 40,
      windowZoomed: false,
      panes: [
        pane("%3", "nvim", 118, 117),
        pane("%1", "fleet", 0, 64),
        pane("%2", "orc", 65, 52),
      ],
    });

    expect(plan?.panes.map(({ paneId }) => paneId)).toEqual(["%1", "%2", "%3"]);
    expect(plan?.resizes).toEqual([
      { paneId: "%1", width: 64 },
      { paneId: "%2", width: 52 },
    ]);
    expect(plan?.resizes.some(({ paneId }) => paneId === "%3")).toBe(false);
  });

  it.each([
    ["unknown pane", [pane("%1", "fleet", 0, 117), pane("%9", undefined, 118, 117)], false, 235],
    ["zoomed window", [pane("%1", "fleet", 0, 235)], true, 235],
    ["stacked pane", [pane("%1", "fleet", 0, 117), pane("%3", "nvim", 118, 117, { top: 20 })], false, 235],
    ["short pane", [pane("%1", "fleet", 0, 117), pane("%3", "nvim", 118, 117, { height: 20 })], false, 235],
    ["dead pane", [pane("%1", "fleet", 0, 117), pane("%3", "nvim", 118, 117, { dead: true })], false, 235],
    ["wrong order", [pane("%3", "nvim", 0, 117), pane("%1", "fleet", 118, 117)], false, 235],
    ["duplicate role", [pane("%1", "fleet", 0, 117), pane("%2", "fleet", 118, 117)], false, 235],
    ["too narrow", [pane("%1", "fleet", 0, 59), pane("%3", "nvim", 60, 59)], false, 120],
  ])("refuses %s", (_name, panes, windowZoomed, windowWidth) => {
    expect(planWindowLayout({
      windowWidth: windowWidth as number,
      windowHeight: 40,
      windowZoomed: windowZoomed as boolean,
      panes: panes as WindowLayoutPane[],
    })).toBeUndefined();
  });
});

describe("rebalanceNvimWindow", () => {
  it("classifies exact Fleet, Orc, and nvim panes and emits exact tmux argv", () => {
    const calls: string[][] = [];
    const spawnSync: SpawnSyncLike = vi.fn((_command, args) => {
      calls.push(args);
      if (args[0] === "display-message") return { status: 0, stdout: "235\t40\t0\n" };
      if (args[0] === "list-panes") {
        return {
          status: 0,
          stdout: [
            "%3\t0\t118\t0\t40\t117\tnvim\tnvim",
            "%1\t0\t0\t0\t40\t64\tnode\t/opt/cyberdeck",
            "%2\t0\t65\t0\t40\t52\tnode\t/opt/cyberdeck attach orc-session",
          ].join("\n"),
        };
      }
      return { status: 0 };
    });

    expect(rebalanceNvimWindow({
      spawnSync,
      windowId: "@4",
      paneFormat: "layout-format",
      hostPaneId: "%1",
      orchestratorSessionIds: ["orc-session"],
    })?.state).toBe("fleet-orc-nvim");
    expect(calls.filter(([verb]) => verb === "resize-pane")).toEqual([
      ["resize-pane", "-t", "%1", "-x", "64"],
      ["resize-pane", "-t", "%2", "-x", "52"],
    ]);
  });

  it("emits no resize when strict Orc session identity does not match", () => {
    const spawnSync = vi.fn<SpawnSyncLike>((_command, args) => {
      if (args[0] === "display-message") return { status: 0, stdout: "235\t40\t0\n" };
      if (args[0] === "list-panes") {
        return {
          status: 0,
          stdout: [
            "%1\t0\t0\t0\t40\t64\tnode\t/opt/cyberdeck",
            "%2\t0\t65\t0\t40\t52\tnode\t/opt/cyberdeck attach another-session",
            "%3\t0\t118\t0\t40\t117\tnvim\tnvim",
          ].join("\n"),
        };
      }
      return { status: 0 };
    });

    expect(rebalanceNvimWindow({
      spawnSync,
      windowId: "@4",
      paneFormat: "layout-format",
      hostPaneId: "%1",
      orchestratorSessionIds: ["orc-session"],
    })).toBeUndefined();
    expect(spawnSync.mock.calls.some(([, args]) => args[0] === "resize-pane")).toBe(false);
  });
});

describe("out-of-process Orc predicate", () => {
  it.each([
    ["/opt/cyberdeck attach 11111111-1111-4111-8111-111111111111", true],
    ["node /opt/cyberdeck attach 11111111-1111-4111-8111-111111111111", true],
    ["/other/cyberdeck attach 11111111-1111-4111-8111-111111111111", false],
    ["/opt/cyberdeck watch 11111111-1111-4111-8111-111111111111", false],
    ["/opt/cyberdeck attach not-a-session", false],
    ["sh -c '/opt/cyberdeck attach 11111111-1111-4111-8111-111111111111'", false],
    ["/opt/cyberdeck attach 11111111-1111-4111-8111-111111111111; touch /tmp/no", false],
  ])("classifies %j as %j", (command, expected) => {
    expect(startsThisCliAttach(command, "/opt/cyberdeck")).toBe(expected);
  });

  it("accepts only a start command the strict finder can identify by its embedded session id", () => {
    const command = "/opt/cyberdeck attach 11111111-1111-4111-8111-111111111111";
    expect(startsThisCliAttach(command, "/opt/cyberdeck")).toBe(true);
    expect(findLiveOrchestratorPane(
      `%2\t0\t${command}`,
      "11111111-1111-4111-8111-111111111111",
    )).toBe("%2");
  });
});
