#!/usr/bin/env node
// Run outside Cyberdeck's process tree. Wait for native and broker work to settle before restart.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, readlink, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withClient, startDetachedBroker, waitForBrokerStop, isBrokerUnavailable } from "../dist/src/cli/broker-process.js";
import { CodexOrchestratorHome } from "../dist/src/providers/codex/orchestrator-home.js";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(homedir(), ".codex");
const home = new CodexOrchestratorHome(source);
const native = join(homedir(), ".local", "bin", "codex");
const evidence = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : join(homedir(), ".local/share/cyberdeck/rc-coexistence-20261006"));
const checkOnly = process.argv.includes("--check");
const statePath = join(evidence, checkOnly ? "activation-check.json" : "activation.json");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, CODEX_HOME: home.directory };
delete env.OPENAI_BASE_URL;
let shutdownOwned = false;
let previousBroker;
let restartTargets = [];
let activationLock;
const lockPath = join(evidence, "activation.lock");

async function state(phase, details = {}) {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify({ phase, at: new Date().toISOString(), ...details }, null, 2) + "\n", { mode: 0o600 });
  console.log(phase);
}

function inspect(clients = false) {
  const result = spawnSync("python3", [join(repo, "scripts/codex-remote-inspect.py"), home.directory, ...(clients ? ["--clients"] : [])], { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}

function birth(pid) {
  return spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).stdout.trim();
}

async function fingerprint() {
  const files = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
    }
  }
  await collect(join(repo, "dist/src"));
  files.push(...["scripts/activate-codex-remote.mjs", "scripts/codex-remote.mjs", "scripts/codex-remote-shell.zsh", "scripts/codex-remote-inspect.py", "package.json", "pnpm-lock.yaml"].map((path) => join(repo, path)));
  const hash = createHash("sha256");
  for (const path of files.sort()) hash.update(path).update(await readFile(path));
  return hash.digest("hex");
}

async function acquireLock() {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  try {
    const previous = JSON.parse(await readFile(lockPath, "utf8"));
    if (birth(previous.pid) === previous.birth) throw new Error("Another activation process is already running");
    await unlink(lockPath);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  activationLock = await open(lockPath, "wx", 0o600);
  await activationLock.writeFile(JSON.stringify({ pid: process.pid, birth: birth(process.pid) }));
}

async function installShell() {
  const directory = join(homedir(), ".local/share/cyberdeck");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ["codex-remote.mjs", "codex-remote-shell.zsh"]) {
    const path = join(directory, name), target = join(repo, "scripts", name);
    try { await symlink(target, path); } catch (error) {
      if (error.code !== "EEXIST" || await realpath(path) !== target) throw error;
    }
  }
  const path = await realpath(join(homedir(), ".zshrc"));
  const contents = await readFile(path, "utf8");
  const marker = "# >>> Codex shared native Remote Control >>>";
  if (!contents.includes(marker)) {
    await writeFile(join(evidence, "zshrc.before"), contents, { mode: 0o600 });
    await writeFile(path, contents + `\n${marker}\nsource "$HOME/.local/share/cyberdeck/codex-remote-shell.zsh"\n# <<< Codex shared native Remote Control <<<\n`);
  }
}

async function main() {
  if (!checkOnly) await acquireLock();
  const builtFingerprint = await fingerprint();
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  let sessions;
  let previousWaiting;
  let idleSince;
  for (;;) {
    sessions = await withClient((client) => client.request("session.list", {}));
    const loaded = inspect().loaded;
    const nativeBusy = loaded.filter((thread) => thread.status?.type !== "idle");
    const brokerBusy = sessions.filter((session) => ["active", "starting"].includes(session.executionState)
      && session.attentionState !== "done");
    if (nativeBusy.length === 0 && brokerBusy.length === 0) {
      idleSince ??= Date.now();
      if (checkOnly || Date.now() - idleSince >= 10_000) break;
      await pause(5000);
      continue;
    }
    idleSince = undefined;
    const waiting = JSON.stringify({ native: nativeBusy.map((thread) => thread.id), broker: brokerBusy.map((session) => session.id) });
    if (waiting !== previousWaiting) {
      await state("waiting-for-idle", JSON.parse(waiting));
      previousWaiting = waiting;
    }
    if (checkOnly) return;
    if (Date.now() >= deadline) throw new Error("Activation timed out waiting for idle; no services were restarted");
    await pause(5000);
  }
  if (checkOnly) { await state("ready-for-activation"); return; }
  if (await fingerprint() !== builtFingerprint) throw new Error("Built code changed while waiting; activation was not started");
  const before = inspect(true);
  if (before.loaded.some((thread) => thread.status?.type !== "idle")) throw new Error("Native work restarted before activation; no services were stopped");
  // Capture restart targets and the exact old process before any lifecycle mutation.
  const active = sessions.filter((session) => session.executionState === "active");
  const status = await withClient((client) => client.request("broker.status", {}));
  const brokerPid = status.pid;
  if (!Number.isInteger(brokerPid)) throw new Error("Broker did not report a process identity");
  const brokerBirth = birth(brokerPid);
  if (!brokerBirth) throw new Error("Original broker process is absent");
  previousBroker = { pid: brokerPid, birth: brokerBirth };
  restartTargets = active;
  const rollback = {};
  for (const name of ["config.toml", "hooks.json"]) {
    const path = join(home.directory, name);
    try { rollback[name] = { link: await readlink(path) }; }
    catch (error) {
      if (error.code !== "EINVAL") throw error;
      rollback[name] = { file: await readFile(path, "utf8") };
    }
  }
  await state("activating", { brokerPid, brokerBirth, resumedSessionIds: active.map((session) => session.id) });
  await writeFile(join(evidence, "home-before.json"), JSON.stringify(rollback, null, 2) + "\n", { mode: 0o600 });
  await withClient((client) => client.request("broker.shutdown", {}));
  shutdownOwned = true;
  await waitForBrokerStop(60_000);
  const stoppedDeadline = Date.now() + 30_000;
  while (birth(brokerPid) === brokerBirth) {
    if (Date.now() >= stoppedDeadline) throw new Error("Old broker is still alive; no replacement was started");
    await pause(100);
  }
  await home.prepare();
  const restarted = spawnSync(native, ["app-server", "daemon", "restart"], { env, encoding: "utf8", timeout: 90_000 });
  if (restarted.error || restarted.status !== 0) throw new Error(restarted.error?.message ?? restarted.stderr);
  const ready = spawnSync(native, ["remote-control", "start", "--json"], { env, encoding: "utf8", timeout: 45_000 });
  if (ready.status !== 0 || JSON.parse(ready.stdout).status !== "connected") throw new Error("Dedicated RC daemon is not connected after restart");
  await startDetachedBroker(false);
  const failedResumes = [];
  for (const session of active) {
    try { await withClient((client) => client.request("session.resume", { sessionId: session.id })); }
    catch (error) { failedResumes.push({ id: session.id, error: error.message }); }
  }
  await installShell();
  const after = inspect(true);
  if (after.remote.installationId !== before.remote.installationId
    || after.remote.environmentId !== before.remote.environmentId) throw new Error("Dedicated host identity changed during restart");
  if (after.registeredClientCount < before.registeredClientCount) throw new Error("Phone enrollment was not preserved during restart");
  if (after.defaultList.some((thread) => thread.provider !== "openai")) throw new Error("Daemon thread-list default is still not OpenAI");
  const listed = new Set(after.defaultList.map((thread) => thread.id));
  if (before.loaded.some((thread) => thread.provider === "openai" && !listed.has(thread.id))) throw new Error("Previously loaded Orc conversations are missing from the default OpenAI thread list");
  await state(failedResumes.length ? "activated-with-resume-errors" : "activated", { remote: after.remote, loaded: after.loaded, registeredClientCount: after.registeredClientCount, resumedSessionIds: active.map((session) => session.id).filter((id) => !failedResumes.some((failure) => failure.id === id)), failedResumes, builtFingerprint });
}

main().catch(async (error) => {
  if (!checkOnly && !activationLock) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  let recovery = "not-needed";
  if (shutdownOwned) {
    try {
      await withClient((client) => client.request("broker.status", {}));
      recovery = "broker-running";
    } catch (statusError) {
      if (isBrokerUnavailable(statusError) && birth(previousBroker.pid) !== previousBroker.birth) {
        try {
          await startDetachedBroker(false);
          const failedResumes = [];
          for (const session of restartTargets) {
            try { await withClient((client) => client.request("session.resume", { sessionId: session.id })); }
            catch (resumeError) { failedResumes.push({ id: session.id, error: resumeError.message }); }
          }
          recovery = { brokerRestored: true, failedResumes };
        } catch (recoveryError) { recovery = { error: recoveryError.message }; }
      } else recovery = "original-broker-still-running-or-unverifiable";
    }
  }
  await state("failed", { error: error.message, recovery });
  process.exitCode = 1;
}).finally(async () => {
  if (activationLock) {
    await activationLock.close();
    await unlink(lockPath);
  }
});
