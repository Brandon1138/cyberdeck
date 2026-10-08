import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPairingQr, resolveNativeCodex } from "../../scripts/codex-remote.mjs";
import type { DesktopCommand } from "../../scripts/desktop-open.mjs";

const directories: string[] = [];
async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-remote-desktop-"));
  directories.push(path);
  return path;
}
async function executable(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "codex");
  await writeFile(path, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  return path;
}
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("RC desktop compatibility without activation", () => {
  it("preserves macOS Preview and offers Linux QR opening", () => {
    const run = vi.fn<DesktopCommand>().mockReturnValue({ status: 0 });
    expect(openPairingQr("/tmp/phone-pairing.png", { platform: "darwin", run }).status).toBe("opened");
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual(["open", ["-a", "Preview", "/tmp/phone-pairing.png"]]);
    expect(openPairingQr("/tmp/phone-pairing.png", { platform: "linux", release: "Linux", env: { DISPLAY: ":0" }, run }).status).toBe("opened");
    expect(run.mock.calls[1]!.slice(0, 2)).toEqual(["xdg-open", ["/tmp/phone-pairing.png"]]);
  });

  it("retains the installer-managed native path on macOS", async () => {
    const home = await scratch();
    expect(resolveNativeCodex({ platform: "darwin", home, env: {} })).toBe(join(home, ".local/bin/codex"));
  });

  it("prefers an existing user installation on Linux", async () => {
    const home = await scratch();
    const native = await executable(join(home, ".local/bin"));
    const other = await scratch();
    await executable(other);
    expect(resolveNativeCodex({ platform: "linux", home, env: { PATH: other } })).toBe(native);
  });

  it("finds npm/system Codex on PATH when the installer path is absent", async () => {
    const home = await scratch();
    const bin = await scratch();
    const native = await executable(bin);
    expect(resolveNativeCodex({ platform: "linux", home, env: { PATH: `${home}:${bin}` } })).toBe(native);
  });

  it("skips nonexecutable files and its own launcher on PATH", async () => {
    const home = await scratch();
    const first = await scratch();
    const fake = await executable(first);
    await chmod(fake, 0o600);
    const second = await scratch();
    await symlink(resolve("scripts/codex-remote.mjs"), join(second, "codex"));
    const third = await scratch();
    const native = await executable(third);
    expect(resolveNativeCodex({ platform: "linux", home, env: { PATH: `${first}:${second}:${third}` } })).toBe(native);
  });

  it("honors an explicit absolute native executable and rejects invalid overrides", async () => {
    const home = await scratch();
    const native = await executable(await scratch());
    expect(resolveNativeCodex({ platform: "linux", home, env: { CYBERDECK_NATIVE_CODEX: native } })).toBe(native);
    for (const override of ["relative/codex", join(home, "missing"), resolve("scripts/codex-remote.mjs")]) {
      expect(() => resolveNativeCodex({ platform: "linux", home, env: { CYBERDECK_NATIVE_CODEX: override } }))
        .toThrow("CYBERDECK_NATIVE_CODEX must name an absolute native Codex executable");
    }
  });

  it("gives a clear failure when no native executable exists", async () => {
    const home = await scratch();
    expect(() => resolveNativeCodex({ platform: "linux", home, env: { PATH: home } })).toThrow("Native Codex executable not found");
  });

  it("keeps noninteractive utility arguments intact and never prepares or activates RC", async () => {
    const native = await executable(await scratch());
    const argv = ["exec", "literal argument with spaces", "--help"];
    const result = execFileSync(process.execPath, [resolve("scripts/codex-remote.mjs"), "run", "--", ...argv], {
      env: { ...process.env, CYBERDECK_NATIVE_CODEX: native }, encoding: "utf8", timeout: 5_000,
    });
    expect(JSON.parse(result)).toEqual(argv);
  });
});
