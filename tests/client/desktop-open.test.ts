import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openDesktop, type DesktopCommand } from "../../scripts/desktop-open.mjs";

describe("desktop URL and file opening", () => {
  it("preserves macOS open and application-specific file preview", () => {
    const run = vi.fn<DesktopCommand>().mockReturnValue({ status: 0 });
    expect(openDesktop({ kind: "file", value: "/tmp/screen shot.png" }, { platform: "darwin", application: "Preview", run }))
      .toEqual({ status: "opened" });
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual(["open", ["-a", "Preview", "/tmp/screen shot.png"]]);
    expect(openDesktop({ kind: "url", value: "https://example.test/?x=1&next=2" }, { platform: "darwin", run })).toEqual({ status: "opened" });
    expect(run.mock.calls[1]!.slice(0, 2)).toEqual(["open", ["https://example.test/?x=1&next=2"]]);
  });

  it.each([{ DISPLAY: ":0" }, { WAYLAND_DISPLAY: "wayland-0" }])("uses xdg-open for a native Linux desktop: %j", (env) => {
    const run = vi.fn<DesktopCommand>().mockReturnValue({ status: 0 });
    const value = "/tmp/quote' & $(do-not-run) 日本語.png";
    expect(openDesktop({ kind: "file", value }, { platform: "linux", release: "Linux", env, run })).toEqual({ status: "opened" });
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual(["xdg-open", [value]]);
    expect(run.mock.calls[0]![2]).toMatchObject({ shell: false, timeout: 5_000, maxBuffer: 16_384, killSignal: "SIGKILL" });
  });

  it("passes URL punctuation as a single argument, including tokens without logging them", () => {
    const run = vi.fn<DesktopCommand>().mockReturnValue({ status: 1 });
    const value = "https://example.test/path?token=private-test-token&x=$()";
    const result = openDesktop({ kind: "url", value }, { platform: "linux", release: "Linux", env: { DISPLAY: ":0" }, run });
    expect(run.mock.calls[0]![1]).toEqual([value]);
    expect(result).toEqual({ status: "unavailable", reason: "xdg-open desktop request failed" });
    expect(JSON.stringify(result)).not.toContain("private-test-token");
  });

  it("resolves relative files so a leading dash cannot become an opener option", () => {
    const run = vi.fn<DesktopCommand>().mockReturnValue({ status: 0 });
    expect(openDesktop({ kind: "file", value: "-danger.png" }, { platform: "linux", release: "Linux", env: { DISPLAY: ":0" }, run }).status).toBe("opened");
    expect(run.mock.calls[0]![1][0]).toBe(`${process.cwd()}/-danger.png`);
  });

  it("converts WSL files with safe argv then transports exact Windows paths as data", () => {
    const windows = "\\\\wsl.localhost\\Ubuntu\\home\\me\\quote' & $(do-not-run) 日本語 🐈.png";
    const run = vi.fn<DesktopCommand>().mockReturnValueOnce({ status: 0, stdout: `${windows}\n` }).mockReturnValueOnce({ status: 0 });
    const value = "/home/me/quote' & $(do-not-run) 日本語 🐈.png";
    const result = openDesktop({ kind: "file", value }, {
      platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, run,
    });
    expect(result).toEqual({ status: "opened" });
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual(["wslpath", ["-w", value]]);
    expect(run.mock.calls[1]![0]).toBe("powershell.exe");
    expect(run.mock.calls[1]![1]).toContain("-EncodedCommand");
    expect(run.mock.calls[1]![1].join(" ")).not.toContain("do-not-run");
    const input = String(run.mock.calls[1]![2].input);
    expect(input).toMatch(/^[\x00-\x7f]+$/u);
    expect(JSON.parse(input)).toEqual({ target: windows });
    expect(run.mock.calls[1]![2].shell).toBe(false);
  });

  it.each([
    { env: { WSL_INTEROP: "/run/WSL/interop" }, release: "Linux" },
    { env: {}, release: "6.6.87.2-microsoft-standard-WSL2" },
  ])("opens WSL URLs through Windows without file conversion", ({ env, release }) => {
    const run = vi.fn<DesktopCommand>().mockReturnValue({ status: 0 });
    const value = "https://example.test/?a=1&b='literal'";
    expect(openDesktop({ kind: "url", value }, { platform: "linux", env, release, run }).status).toBe("opened");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe("powershell.exe");
    expect(JSON.parse(String(run.mock.calls[0]![2].input))).toEqual({ target: value });
  });

  it.each([{ status: 1 }, { status: null, error: Object.assign(new Error("private target"), { code: "ENOENT" }) }])(
    "reports failed WSL conversion without launching Windows opener", (result) => {
      const run = vi.fn<DesktopCommand>().mockReturnValue(result);
      expect(openDesktop({ kind: "file", value: "/home/me/a.png" }, { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, run }).status).toBe("unavailable");
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["", "/still/linux.png\n", "C:\\bad\npath.png\n"])("rejects invalid Windows path conversion: %j", (stdout) => {
    const run = vi.fn<DesktopCommand>().mockReturnValue({ status: 0, stdout });
    expect(openDesktop({ kind: "file", value: "/home/me/a.png" }, { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, run }))
      .toEqual({ status: "unavailable", reason: "wslpath returned an invalid Windows file path" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports a real opener timeout without exposing process output", () => {
    const run: DesktopCommand = (_command, _args, options) => spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, timeout: 100 });
    expect(openDesktop({ kind: "url", value: "https://example.test/" }, { platform: "linux", release: "Linux", env: { DISPLAY: ":0" }, run }))
      .toEqual({ status: "unavailable", reason: "xdg-open desktop request timed out" });
  });

  it("reports missing Windows integration and preserves URL privacy", () => {
    const run = vi.fn<DesktopCommand>().mockReturnValue({ status: null, error: Object.assign(new Error("private token"), { code: "ENOENT" }) });
    expect(openDesktop({ kind: "url", value: "https://example.test/?token=private" }, { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, run }))
      .toEqual({ status: "unavailable", reason: "powershell.exe desktop integration is unavailable" });
  });

  it.each(["linux", "win32"] as const)("reports headless or unsupported desktop %s", (platform) => {
    const run = vi.fn<DesktopCommand>();
    expect(openDesktop({ kind: "file", value: "/tmp/a.png" }, { platform, release: "Linux", env: {}, run }).status).toBe("unavailable");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "url", value: "javascript:alert(1)" }, { kind: "url", value: "file:///tmp/a.png" },
    { kind: "url", value: "https:example.test" }, { kind: "url", value: "https://example.test/unsafe argument" },
    { kind: "url", value: "not a URL" }, { kind: "file", value: "/tmp/a\u0000.png" },
    { kind: "file", value: "file:///tmp/a%0A.png" }, { kind: "file", value: "" },
  ] as const)("rejects unsafe or malformed desktop target: $value", (target) => {
    const run = vi.fn<DesktopCommand>();
    expect(openDesktop(target, { platform: "darwin", run }).status).toBe("unavailable");
    expect(run).not.toHaveBeenCalled();
  });
});
