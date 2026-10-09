import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { release } from "node:os";
import type { PasteboardCapture, PasteboardCaptureOutcome } from "./clipboard-image.js";
import {
  CLIPBOARD_TIMEOUT_MS, MAX_CLIPBOARD_IMAGE_BYTES, PNG_SIGNATURE,
  clipboardCommandReason, runClipboardCommand, type ClipboardCommand,
} from "./clipboard-process.js";
import { WINDOWS_CLIPBOARD_ARGS } from "./clipboard-windows.js";

// Preserve macOS PNG coercion, including TIFF-only screenshots.
const CAPTURE_SCRIPT: readonly string[] = [
  "on run argv", "set destination to item 1 of argv", "try",
  "set pasteboardImage to the clipboard as «class PNGf»", "on error number errorNumber",
  "if errorNumber is -1700 or errorNumber is -1728 then", 'return "no-image"',
  "else", 'return "unavailable"', "end if", "end try",
  "set handle to open for access (POSIX file destination) with write permission",
  "set eof handle to 0", "write pasteboardImage to handle", "close access handle",
  'return "captured"', "end run",
];

export interface ClipboardPlatformOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  release?: string;
  run?: ClipboardCommand;
}

export function createPasteboardCapture(options: ClipboardPlatformOptions = {}): PasteboardCapture {
  return async (destination) => {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const run = options.run ?? runClipboardCommand;
    const deadline = performance.now() + CLIPBOARD_TIMEOUT_MS;
    const execute = (command: string, args: readonly string[], maxBytes = MAX_CLIPBOARD_IMAGE_BYTES) =>
      run(command, args, { env, maxBytes, timeoutMs: Math.max(1, deadline - performance.now()) });
    const unavailable = (reason: string): PasteboardCaptureOutcome => ({ status: "unavailable", reason });

    if (platform === "darwin") {
      const result = await execute("osascript", [...CAPTURE_SCRIPT.flatMap((line) => ["-e", line]), destination], 4_096);
      if (result.status === "failed") return unavailable(clipboardCommandReason("osascript", result));
      const response = result.stdout.toString("utf8").trim();
      if (response === "captured" || response === "no-image") return { status: response };
      if (response === "unavailable") return unavailable("osascript could not read the clipboard");
      return unavailable("osascript returned an invalid clipboard response");
    }
    if (platform !== "linux") return unavailable(`Clipboard image integration is unavailable on ${platform}`);

    let command: string;
    let args: readonly string[];
    const wsl = Boolean(env.WSL_INTEROP || env.WSL_DISTRO_NAME || /microsoft|wsl/iu.test(options.release ?? release()));
    if (wsl) {
      command = "powershell.exe";
      args = WINDOWS_CLIPBOARD_ARGS;
    } else {
      command = env.WAYLAND_DISPLAY ? "wl-paste" : env.DISPLAY ? "xclip" : "";
      if (command === "") return unavailable("No Wayland or X11 clipboard session is available");
      const types = await execute(command, command === "wl-paste"
        ? ["--list-types"] : ["-selection", "clipboard", "-t", "TARGETS", "-o"], 65_536);
      if (types.status === "failed") {
        // These exact reader diagnostics mean no selection exists, not a denied display read.
        const empty = command === "wl-paste" ? "Nothing is copied" : "Error: target TARGETS not available";
        if (types.failure === "exit" && types.exitCode === 1 && types.stderr.toString("utf8").trim() === empty) {
          return { status: "no-image" };
        }
        return unavailable(clipboardCommandReason(command, types));
      }
      if (!types.stdout.toString("utf8").split(/\s+/u).includes("image/png")) return { status: "no-image" };
      args = command === "wl-paste" ? ["--no-newline", "--type", "image/png"]
        : ["-selection", "clipboard", "-t", "image/png", "-o"];
    }
    const result = await execute(command, args);
    if (result.status === "failed") {
      if (wsl && result.failure === "exit") {
        if (result.exitCode === 3) return { status: "no-image" };
        if (result.exitCode === 4) return unavailable("Windows clipboard image exceeds 20 MiB");
        if (result.exitCode === 5) return unavailable("Windows clipboard read timed out");
      }
      return unavailable(clipboardCommandReason(command, result));
    }
    if (result.stdout.length > MAX_CLIPBOARD_IMAGE_BYTES) return unavailable("Clipboard image exceeds 20 MiB");
    if (!result.stdout.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return unavailable("Clipboard image is not a PNG");
    try {
      const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
          return unavailable("Clipboard image destination is not a private file");
        }
        await file.chmod(0o600);
        await file.truncate(0);
        await file.writeFile(result.stdout);
      } finally { await file.close(); }
    } catch { return unavailable("Could not write the clipboard image to private storage"); }
    return { status: "captured" };
  };
}

/** Compatibility entry point for callers explicitly requesting the macOS reader. */
export const capturePasteboardImageWithOsascript: PasteboardCapture = (destination) =>
  process.platform === "darwin" ? createPasteboardCapture({ platform: "darwin" })(destination)
    : Promise.resolve({ status: "unavailable", reason: "osascript clipboard integration requires macOS" });
