import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePasteboardImage } from "../../src/client/clipboard-image.js";
import { createPasteboardCapture, type ClipboardPlatformOptions } from "../../src/client/clipboard-platform.js";
import { PNG_SIGNATURE, type ClipboardCommand, type ClipboardCommandResult } from "../../src/client/clipboard-process.js";

const PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from("test image payload")]);
const directories: string[] = [];
const ok = (stdout: Buffer | string): ClipboardCommandResult => ({ status: "ok", stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout) });
const failed = (exitCode = 1, stderr = "private clipboard details"): ClipboardCommandResult =>
  ({ status: "failed", failure: "exit", exitCode, stderr: Buffer.from(stderr) });

async function capture(options: ClipboardPlatformOptions) {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-clipboard-platform-"));
  directories.push(directory);
  return { directory, result: await capturePasteboardImage({ directory, capture: createPasteboardCapture(options) }) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("clipboard platform integrations", () => {
  it.each([
    { env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, command: "wl-paste", types: "text/plain\nimage/png\n" },
    { env: { DISPLAY: ":0" }, command: "xclip", types: "TARGETS\nUTF8_STRING\nimage/png\n" },
  ])("captures PNG bytes from $command into Linux storage", async ({ env, command, types }) => {
    const run = vi.fn<ClipboardCommand>().mockResolvedValueOnce(ok(types)).mockResolvedValueOnce(ok(PNG));
    const { result } = await capture({ platform: "linux", release: "Linux", env, run });
    expect(result.status).toBe("captured");
    if (result.status === "captured") expect(await readFile(result.path)).toEqual(PNG);
    expect(run.mock.calls.map(([name]) => name)).toEqual([command, command]);
    expect(run.mock.calls[1]![1]).toContain("image/png");
  });

  it.each([{ WAYLAND_DISPLAY: "wayland-0" }, { DISPLAY: ":0" }])("does not request an attachment when advertised types contain no PNG: %j", async (env) => {
    const run = vi.fn<ClipboardCommand>().mockResolvedValue(ok("text/plain\nUTF8_STRING\nimage/jpeg\n"));
    const { result, directory } = await capture({ platform: "linux", release: "Linux", env, run });
    expect(result).toEqual({ status: "no-image" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    { env: { WAYLAND_DISPLAY: "wayland-0" }, stderr: "Nothing is copied\n" },
    { env: { DISPLAY: ":0" }, stderr: "Error: target TARGETS not available\n" },
  ])("recognizes a reader's explicit empty-selection diagnostic", async ({ env, stderr }) => {
    const run = vi.fn<ClipboardCommand>().mockResolvedValue(failed(1, stderr));
    expect((await capture({ platform: "linux", release: "Linux", env, run })).result).toEqual({ status: "no-image" });
  });

  it.each(["missing", "timeout", "too-large", "exit"] as const)("keeps %s integration failures visible and redacts reader output", async (failure) => {
    const run = vi.fn<ClipboardCommand>().mockResolvedValue({ status: "failed", failure, stderr: Buffer.from("clipboard secret") });
    const { result, directory } = await capture({ platform: "linux", release: "Linux", env: { WAYLAND_DISPLAY: "wayland-0" }, run });
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("clipboard secret");
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not silently switch to X11 after a failed Wayland read", async () => {
    const run = vi.fn<ClipboardCommand>().mockResolvedValue(failed(1, "Display access denied"));
    const { result } = await capture({ platform: "linux", release: "Linux", env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, run });
    expect(result.status).toBe("unavailable");
    expect(run.mock.calls.map(([command]) => command)).toEqual(["wl-paste"]);
  });

  it("rejects corrupt image output after a successful MIME query", async () => {
    const run = vi.fn<ClipboardCommand>().mockResolvedValueOnce(ok("image/png")).mockResolvedValueOnce(ok("not PNG: clipboard secret"));
    const { result, directory } = await capture({ platform: "linux", release: "Linux", env: { DISPLAY: ":0" }, run });
    expect(result).toEqual({ status: "unavailable", reason: "Clipboard image is not a PNG" });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    { env: { WSL_DISTRO_NAME: "Ubuntu", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, release: "Linux" },
    { env: { WSL_INTEROP: "/run/WSL/interop" }, release: "Linux" },
    { env: {}, release: "6.6.87.2-microsoft-standard-WSL2" },
  ])("uses Windows STA clipboard on WSL even when WSLg exposes a Linux display", async ({ env, release }) => {
    const run = vi.fn<ClipboardCommand>().mockResolvedValue(ok(PNG));
    const { result } = await capture({ platform: "linux", env, release, run });
    expect(result.status).toBe("captured");
    if (result.status === "captured") expect(await readFile(result.path)).toEqual(PNG);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe("powershell.exe");
    expect(run.mock.calls[0]![1]).toContain("-STA");
    expect(run.mock.calls[0]![1]).toContain("-EncodedCommand");
    expect(run.mock.calls[0]![1].join(" ")).not.toContain("paste-");
  });

  it.each([
    { code: 3, status: "no-image" }, { code: 2, status: "unavailable" },
    { code: 4, status: "unavailable" }, { code: 5, status: "unavailable" },
  ])("honors Windows bridge exit code $code without exposing output", async ({ code, status }) => {
    const run = vi.fn<ClipboardCommand>().mockResolvedValue(failed(code));
    const { result, directory } = await capture({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, run });
    expect(result.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain("private clipboard details");
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not downgrade a missing Windows bridge to WSLg clipboard", async () => {
    const run = vi.fn<ClipboardCommand>().mockResolvedValue({ status: "failed", failure: "missing", stderr: Buffer.alloc(0) });
    const { result } = await capture({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu", WAYLAND_DISPLAY: "wayland-0" }, run });
    expect(result.status).toBe("unavailable");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["linux", "win32"] as const)("reports missing integration on headless/unsupported platform %s", async (platform) => {
    const run = vi.fn<ClipboardCommand>();
    expect((await capture({ platform, release: "Linux", env: {}, run })).result.status).toBe("unavailable");
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves osascript PNG coercion and passes the destination as a separate argument", async () => {
    const run = vi.fn<ClipboardCommand>(async (command, args) => {
      expect(command).toBe("osascript");
      expect(args).toContain("set pasteboardImage to the clipboard as «class PNGf»");
      await writeFile(args.at(-1)!, PNG);
      return ok("captured\n");
    });
    expect((await capture({ platform: "darwin", env: {}, run })).result.status).toBe("captured");
  });

  it.each(["no-image\n", "unavailable\n", "unrecognized output"])("distinguishes macOS empty-image reply from protocol failure: %j", async (reply) => {
    const run = vi.fn<ClipboardCommand>().mockResolvedValue(ok(reply));
    expect((await capture({ platform: "darwin", env: {}, run })).result.status)
      .toBe(reply.startsWith("no-image") ? "no-image" : "unavailable");
  });

  it("shares a single five-second budget between type discovery and image read", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const run = vi.fn<ClipboardCommand>(async (_command, _args, options) => {
      if (now === 0) { expect(options.timeoutMs).toBe(5_000); now = 4_000; return ok("image/png"); }
      expect(options.timeoutMs).toBe(1_000);
      return ok(PNG);
    });
    expect((await capture({ platform: "linux", release: "Linux", env: { DISPLAY: ":0" }, run })).result.status).toBe("captured");
  });
});
