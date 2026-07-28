import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import type { ProviderSessionTerminal } from "../../src/providers/provider.js";
import {
  canaryDenialObserved,
  verifyCursorReadOnlyCanary,
} from "../../src/providers/cursor/read-only-canary.js";
import { CursorProviderAdapter } from "../../src/providers/cursor/session-adapter.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const session = {
  id: SESSION_ID,
  provider: "cursor",
  model: "composer",
  cwd: "/repo",
  detached: true,
  sandbox: "read-only",
  approvalMode: "auto",
  profile: "scout",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  executionState: "active",
  attachmentState: "detached",
  pid: 12,
  exitCode: null,
  childIds: [],
} satisfies SessionRecord;

class ScriptedTerminal implements ProviderSessionTerminal {
  readonly writes: string[] = [];
  private replay = "→ \n";

  constructor(private readonly frames: string[]) {}

  snapshot(): Buffer { return Buffer.from(this.replay); }
  write(data: Buffer): void { this.writes.push(data.toString("utf8")); }
  async wait(): Promise<void> { this.replay += this.frames.shift() ?? ""; }
}

describe("Cursor Scout denied-write canary", () => {
  it("combines verified /run-everything, MCP isolation, plan sandbox, and canary before task", async () => {
    const dropBoxPath = "/private/tmp/cyberdeck-scout/session";
    const scoutSession: SessionRecord = {
      ...session,
      scout: {
        dropBoxPath,
        reportPath: `${dropBoxPath}/report.json`,
        canary: { status: "pending" },
        reportState: "missing",
      },
    };
    const readOnlyCanary = vi.fn(async () => ({
      verifiedAt: "2026-07-27T01:00:00.000Z",
    }));
    const isolateMcp = vi.fn(async () => undefined);
    const adapter = new CursorProviderAdapter({
      sourceEnvironment: { PATH: "/usr/bin", HOME: "/Users/operator" },
      timeoutMs: 100,
      pollIntervalMs: 1,
      readOnlyCanary,
      isolateMcp,
    });
    const terminal = new ScriptedTerminal([
      "Run Everything enabled\n→ \n",
      "/run-everything Toggle Run Everything (currently enabled)",
      "",
    ]);
    const launch = adapter.buildLaunchSpec(scoutSession);

    expect(launch.args).toEqual([
      "--workspace",
      "/repo",
      "--sandbox",
      "enabled",
      "--mode",
      "plan",
      "--trust",
      "--model",
      "composer",
    ]);
    expect(launch.args).not.toContain("--approve-mcps");
    expect(launch.env).toMatchObject({
      CURSOR_CONFIG_DIR: `${dropBoxPath}/cursor-config`,
      CURSOR_DATA_DIR: `${dropBoxPath}/cursor-data`,
      NODE_COMPILE_CACHE: `${dropBoxPath}/node-cache`,
      TMPDIR: `${dropBoxPath}/tmp`,
      CYBERDECK_SCOUT_DROP_BOX: dropBoxPath,
      CYBERDECK_SCOUT_REPORT_PATH: `${dropBoxPath}/report.json`,
    });

    await adapter.prepareLaunch(scoutSession, launch);
    await expect(adapter.initializeSession(scoutSession, terminal)).resolves.toEqual({
      scoutReadOnlyCanary: { verifiedAt: "2026-07-27T01:00:00.000Z" },
    });
    expect(isolateMcp).toHaveBeenCalledWith(scoutSession, launch);
    expect(terminal.writes).toEqual(["/run-everything\r", "/", "\u001b"]);
    expect(readOnlyCanary).toHaveBeenCalledOnce();
  });

  it("verifies an actual working turn, provider refusal, absent file, and unchanged git state", async () => {
    const canaryName = `.cyberdeck-scout-canary-${SESSION_ID}`;
    const terminal = new ScriptedTerminal([
      "Composing\nctrl+c to stop\n",
      `${canaryName}: creation denied because plan mode is read-only\nAdd a follow-up\n`,
    ]);
    const repositoryState = vi.fn(async () => " M existing-user-file\n");
    const pathExists = vi.fn(async () => false);

    await expect(verifyCursorReadOnlyCanary(session, terminal, {
      timeoutMs: 100,
      pollIntervalMs: 1,
      inputCommitDelayMs: 0,
      now: () => "2026-07-27T01:00:00.000Z",
      repositoryState,
      pathExists,
    })).resolves.toEqual({ verifiedAt: "2026-07-27T01:00:00.000Z" });
    expect(terminal.writes.join("")).toContain("never shell and never MCP");
    expect(terminal.writes.slice(-2)).toEqual(["\r", "\r"]);
    expect(repositoryState).toHaveBeenCalledTimes(2);
  });

  it("fails closed and cleans exact canary when write succeeds", async () => {
    const terminal = new ScriptedTerminal(["Composing\n"]);
    const pathExists = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const cleanupCanary = vi.fn(async () => undefined);

    await expect(verifyCursorReadOnlyCanary(session, terminal, {
      timeoutMs: 100,
      pollIntervalMs: 1,
      inputCommitDelayMs: 0,
      repositoryState: async () => "",
      pathExists,
      cleanupCanary,
    })).rejects.toMatchObject({ code: "PROVIDER_READ_ONLY_CANARY_FAILED" });
    expect(cleanupCanary).toHaveBeenCalledWith(
      `/repo/.cyberdeck-scout-canary-${SESSION_ID}`,
    );
  });

  it("checks and cleans canary once more after polling stops", async () => {
    const pathExists = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const cleanupCanary = vi.fn(async () => undefined);

    await expect(verifyCursorReadOnlyCanary(session, new ScriptedTerminal([]), {
      timeoutMs: 0,
      inputCommitDelayMs: 0,
      repositoryState: async () => "",
      pathExists,
      cleanupCanary,
    })).rejects.toMatchObject({ code: "PROVIDER_READ_ONLY_CANARY_FAILED" });
    expect(cleanupCanary).toHaveBeenCalledWith(
      `/repo/.cyberdeck-scout-canary-${SESSION_ID}`,
    );
  });

  it("does not accept generic completion without a canary-specific denial", () => {
    expect(canaryDenialObserved("Task done; Add a follow-up", `.canary-${SESSION_ID}`))
      .toBe(false);
  });

  it("recognizes current Cursor's plan-mode denial around the canary name", () => {
    const canaryName = `.cyberdeck-scout-canary-${SESSION_ID}`;
    expect(canaryDenialObserved(
      `The Write tool was blocked by plan mode, which only permits markdown edits, so ${canaryName} was not created.`,
      canaryName,
    )).toBe(true);
  });
});
