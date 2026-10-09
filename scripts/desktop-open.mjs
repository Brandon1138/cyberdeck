import { spawnSync } from "node:child_process";
import { release } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The target is JSON on stdin, never PowerShell source or a cmd.exe command line.
const WINDOWS_OPEN_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = [string]$request.target
  $start.UseShellExecute = $true
  [System.Diagnostics.Process]::Start($start) | Out-Null
  exit 0
} catch { exit 1 }
`;

/** A zero exit means the desktop accepted the request, not that a viewer was observed. */
export function openDesktop(target, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? spawnSync;
  const unavailable = (reason) => ({ status: "unavailable", reason });
  let value;
  try {
    if (typeof target?.value !== "string" || target.value.length === 0 || target.value.length > 8_192
      || /[\x00-\x1f\x7f]/u.test(target.value)) {
      return unavailable("Invalid desktop target");
    }
    if (target.kind === "url") {
      const url = new URL(target.value);
      if (!["http:", "https:"].includes(url.protocol) || !/^https?:\/\//iu.test(target.value) || /\s/u.test(target.value)) {
        return unavailable("Desktop URLs must use HTTP or HTTPS");
      }
      value = target.value;
    } else if (target.kind === "file") {
      value = target.value.startsWith("file:") ? fileURLToPath(target.value) : resolve(target.value);
    } else return unavailable("Invalid desktop target kind");
  } catch { return unavailable("Invalid desktop target"); }
  if (/[\x00-\x1f\x7f]/u.test(value)) return unavailable("Invalid desktop target");

  const execute = (command, args, input) => {
    try {
      const result = run(command, args, {
        env, shell: false, encoding: "utf8", windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"], timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16_384,
        ...(input === undefined ? {} : { input }),
      });
      if (result.error?.code === "ETIMEDOUT") return unavailable(`${command} desktop request timed out`);
      if (result.error?.code === "ENOENT") return unavailable(`${command} desktop integration is unavailable`);
      if (result.error || result.status !== 0) return unavailable(`${command} desktop request failed`);
      return { status: "ok", stdout: result.stdout ?? "" };
    } catch { return unavailable(`${command} desktop request failed`); }
  };
  let result;
  if (platform === "darwin") {
    result = execute("open", target.kind === "file" && options.application
      ? ["-a", options.application, value] : [value]);
  } else if (platform === "linux") {
    const wsl = Boolean(env.WSL_INTEROP || env.WSL_DISTRO_NAME || /microsoft|wsl/iu.test(options.release ?? release()));
    if (wsl) {
      if (target.kind === "file") {
        const converted = execute("wslpath", ["-w", value]);
        if (converted.status === "unavailable") return converted;
        value = converted.stdout.replace(/\r?\n$/u, "");
        if (!/^(?:[A-Za-z]:\\|\\\\)/u.test(value) || /[\x00-\x1f\x7f]/u.test(value)) {
          return unavailable("wslpath returned an invalid Windows file path");
        }
      }
      // ASCII JSON preserves Unicode paths across Windows console code pages.
      const input = JSON.stringify({ target: value }).replace(/[^\x00-\x7f]/g,
        (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);
      result = execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(WINDOWS_OPEN_SCRIPT, "utf16le").toString("base64")], input);
    } else {
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return unavailable("No Linux desktop session is available");
      result = execute("xdg-open", [value]);
    }
  } else return unavailable(`Desktop opening is unavailable on ${platform}`);
  return result.status === "ok" ? { status: "opened" } : result;
}
