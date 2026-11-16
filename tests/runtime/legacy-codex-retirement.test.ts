import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ readFile: vi.fn(), realpath: vi.fn(), exec: vi.fn(), absent: vi.fn(), empty: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, realpath: mocks.realpath }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: mocks.exec }) }));
vi.mock("../../src/runtime/host-process-retirement.js", () => ({ hostProcessGroupAbsent: mocks.absent }));
vi.mock("../../src/providers/codex/remote-loaded-threads.js", () => ({ codexDaemonHasNoLoadedThreads: mocks.empty }));
import { probeLegacyCodexRetirement } from "../../src/runtime/legacy-codex-retirement.js";
import type { SessionRecord } from "../../src/domain/session.js";

describe.skipIf(process.platform !== "darwin")("Darwin legacy retirement identity proof", () => {
  const home = "/managed", socket = "/private/daemon.sock", start = "Sun Nov 15 14:18:15 2026";
  const raw = JSON.stringify({ pid: 456, processStartTime: start,
    processIdentity: { bootId: "boot", uniqueId: 123, startSeconds: 100, startMicroseconds: 20 } });
  const server = `456 ${start} /managed/packages/app-server-daemon/releases/v/bin/codex app-server --managed-daemon`;
  const record = { id: "legacy", generation: 1, pid: 4242, createdAt: "2026-11-14T21:24:58.908Z", provider: "codex",
    executor: "host", kind: "orchestrator", codexActorMarker: true, exitCode: -1, executionState: "cancelled",
    launchRecord: { mode: "launch", transport: "pty", args: ["/app/providers/codex/remote-mcp-launch.js", "--actor-session", "legacy", "--remote", "unix://"] },
  } as SessionRecord;
  beforeEach(() => {
    vi.resetAllMocks(); mocks.readFile.mockResolvedValue(raw);
    mocks.realpath.mockImplementation(async (path: string) => path === home ? home : socket);
    mocks.exec.mockImplementation(async (path: string) => ({ stdout: path === "/bin/ps" ? server : `p456\nn${socket}\n`, stderr: "" }));
    mocks.absent.mockReturnValue(true); mocks.empty.mockResolvedValue(true);
  });
  it("requires exact daemon process, socket owner, empty roster and fresh host-group absence", async () => {
    expect(await probeLegacyCodexRetirement(record, home)).toMatchObject({ daemonPid: 456, socketPath: socket, homeDirectory: home });
    expect(mocks.absent.mock.calls).toEqual([[4242, 4242], [4242, 4242]]);
    expect(mocks.empty).toHaveBeenCalledExactlyOnceWith(socket);
  });
  it.each(["second-server", "wrong-start", "wrong-pid", "wrong-owner", "process-read-error"])("rejects %s before reading runtime state", async mode => {
    mocks.exec.mockImplementation(async (path: string) => {
      if (mode === "process-read-error") throw new Error("EPERM");
      return { stdout: path === "/bin/ps"
        ? mode === "second-server" ? `${server}\n${server.replace("456", "789")}`
          : mode === "wrong-start" ? server.replace("14:18:15", "14:18:16")
          : mode === "wrong-pid" ? server.replace("456", "789") : server
        : mode === "wrong-owner" ? "p456\nn/another.sock\n" : `p456\nn${socket}\n`, stderr: "" };
    });
    await expect(probeLegacyCodexRetirement(record, home)).rejects.toThrow(); expect(mocks.empty).not.toHaveBeenCalled();
  });
  it.each(["daemon-identity", "socket", "group-returned", "loaded-thread"])("rejects changed %s around the roster read", async mode => {
    if (mode === "daemon-identity") mocks.readFile.mockResolvedValueOnce(raw).mockResolvedValue(`${raw}\n`);
    if (mode === "socket") mocks.realpath.mockResolvedValueOnce(socket).mockResolvedValueOnce(home).mockResolvedValue("/other.sock");
    if (mode === "group-returned") mocks.absent.mockReturnValueOnce(true).mockReturnValue(false);
    if (mode === "loaded-thread") mocks.empty.mockResolvedValue(false);
    await expect(probeLegacyCodexRetirement(record, home)).rejects.toThrow();
  });
  it("rejects unavailable host absence evidence before any native read", async () => {
    mocks.absent.mockReturnValue(false);
    await expect(probeLegacyCodexRetirement(record, home)).rejects.toThrow(); expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
