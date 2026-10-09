#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { openDesktop } from "./desktop-open.mjs";

const [operation, separator, ...args] = process.argv.slice(2);
const utilityCommands = new Set([
  "exec", "e", "review", "login", "logout", "mcp", "mcp-server", "app-server", "debug",
  "completion", "sandbox", "apply", "a", "cloud", "features", "remote-control", "agents",
  "archive", "delete", "unarchive", "help",
  "plugin", "app", "update", "doctor", "queue", "migrate-rollouts", "exec-server",
]);
const valueFlags = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-C", "--cd", "-s", "--sandbox", "-a", "--ask-for-approval", "-i", "--image", "--enable", "--disable", "--remote", "--remote-auth-token-env", "--add-dir"]);

export function interactiveInvocation(argv) {
  let commandFound = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--help", "-h", "--version", "-V", "--no-daemon"].includes(arg)) return false;
    if (arg === "--remote" || arg.startsWith("--remote=")) return false;
    if (["-p", "--profile", "--oss", "--local-provider"].includes(arg)
      || arg.startsWith("--profile=") || arg.startsWith("--local-provider=") || arg.startsWith("-p")) return false;
    if (arg === "--") return true;
    if (valueFlags.has(arg)) { i++; continue; }
    if (!commandFound && !arg.startsWith("-")) {
      if (utilityCommands.has(arg)) return false;
      commandFound = true;
    }
  }
  return true;
}

export function dedicatedRemoteControlInvocation(argv) {
  let subcommand;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--help", "-h", "--version", "-V", "-p", "--profile", "--remote"].includes(arg)
      || arg.startsWith("--profile=") || arg.startsWith("-p") || arg.startsWith("--remote=")) return false;
    if (arg === "--") break;
    if (valueFlags.has(arg)) { i++; continue; }
    if (!subcommand && !arg.startsWith("-")) subcommand = arg;
  }
  return subcommand === "remote-control";
}

export function resolveNativeCodex(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const self = fileURLToPath(import.meta.url);
  const executable = (path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile() && realpathSync(path) !== self;
    } catch { return false; }
  };
  if (env.CYBERDECK_NATIVE_CODEX) {
    if (isAbsolute(env.CYBERDECK_NATIVE_CODEX) && executable(env.CYBERDECK_NATIVE_CODEX)) return env.CYBERDECK_NATIVE_CODEX;
    throw new Error("CYBERDECK_NATIVE_CODEX must name an absolute native Codex executable");
  }
  const legacy = join(home, ".local", "bin", "codex");
  // Preserve the installer-managed macOS path. Linux also accepts npm/system/PATH installs.
  if (platform === "darwin" || executable(legacy)) return legacy;
  for (const directory of (env.PATH ?? "").split(":")) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, "codex");
    if (executable(candidate)) return candidate;
  }
  throw new Error("Native Codex executable not found; install codex on PATH or set CYBERDECK_NATIVE_CODEX");
}

function nativeCommand(argv, env = process.env, capture = false) {
  const result = spawnSync(resolveNativeCodex(), argv, { env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

export async function createPairingQr(pairing, directory) {
  if (typeof pairing.pairingCode !== "string" || pairing.pairingCode.length === 0
    || !Number.isFinite(pairing.expiresAt) || pairing.expiresAt * 1000 <= Date.now()) {
    throw new Error("Native pairing response is missing a current pairing code");
  }
  // This is the QR payload used by the installed ChatGPT Desktop mobile setup dialog.
  const url = new URL("https://chatgpt.com/codex/pair");
  url.searchParams.set("pairing_code", pairing.pairingCode);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "phone-pairing.png");
  await writeFile(path, await QRCode.toBuffer(url.toString(), {
    type: "png", errorCorrectionLevel: "M", margin: 4, width: 900,
  }), { mode: 0o600 });
  return { path, expiresAt: new Date(pairing.expiresAt * 1000).toISOString() };
}

async function main() {
  const remoteUtility = operation === "run" && dedicatedRemoteControlInvocation(args);
  if (operation === "run" && separator === "--" && !interactiveInvocation(args) && !remoteUtility) {
    process.exitCode = nativeCommand(args).status ?? 1;
    return;
  }
  if (!["prepare", "run", "pair"].includes(operation)) throw new Error("Usage: codex-remote.mjs prepare | pair | run -- [Codex arguments]");
  const { CodexOrchestratorHome } = await import("../dist/src/providers/codex/orchestrator-home.js");
  const home = new CodexOrchestratorHome(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  // Refreshing pairing must not migrate configuration underneath a running old broker.
  if (operation !== "pair") await home.prepare();
  if (operation === "prepare") { process.stdout.write(`${home.directory}\n`); return; }
  const env = { ...process.env, CODEX_HOME: home.directory };
  delete env.OPENAI_BASE_URL;
  if (remoteUtility) {
    // start/stop/status/pair must own the same identity as the interactive TUI, never Desktop's.
    process.exitCode = nativeCommand(args, env).status ?? 1;
    return;
  }
  // Desktop owns the original installation; never start or disable its daemon here.
  const ready = nativeCommand(["remote-control", "start", "--json"], env, true);
  if (ready.status !== 0) throw new Error(ready.stderr || ready.stdout || "Could not start Codex RC");
  const status = JSON.parse(ready.stdout);
  if (status.status !== "connected") throw new Error(`Codex RC is ${status.status}; retry once the dedicated daemon connects`);
  if (operation === "pair") {
    const result = nativeCommand(["remote-control", "pair", "--json"], env, true);
    if (result.status !== 0) throw new Error(result.stderr || "Could not create phone pairing code");
    const qr = await createPairingQr(JSON.parse(result.stdout), join(homedir(), ".local/share/cyberdeck/remote-pairing"));
    process.stdout.write(`Scan the QR with iPhone Camera, then finish setup in ChatGPT.\nQR: ${qr.path}\nExpires: ${qr.expiresAt}\n`);
    nativeCommandForPreview(qr.path);
    return;
  }
  let commandIndex = -1;
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) { i++; continue; }
    if (args[i] === "resume" || args[i] === "fork") { commandIndex = i; break; }
    if (!args[i].startsWith("-")) break;
  }
  const nativeArgs = [...args];
  const insertAt = commandIndex >= 0 ? commandIndex + 1 : 0;
  nativeArgs.splice(insertAt, 0, "--remote", "unix://", "-c", 'model_provider="openai"',
    "-c", 'plugins."headroom@headroom-marketplace".enabled=false');
  process.exitCode = nativeCommand(nativeArgs, env).status ?? 1;
}

export function openPairingQr(path, options = {}) {
  return openDesktop({ kind: "file", value: path }, { ...options, application: "Preview" });
}

function nativeCommandForPreview(path) {
  const opened = openPairingQr(path);
  if (opened.status === "unavailable") process.stderr.write(`QR preview unavailable: ${opened.reason}\nOpen the QR image manually: ${path}\n`);
}

if (process.argv[1] && process.argv[1] !== "-" && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => { process.stderr.write(`Codex Remote Control: ${error.message}\n`); process.exitCode = 1; });
}
