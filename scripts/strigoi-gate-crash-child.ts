import { execFile, spawn } from "node:child_process";
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SessionRegistry } from "../src/broker/session-registry.js";
import { BrokerRuntimeConfigSchema } from "../src/config.js";
import { composeStrigoiEvidence } from "../src/persistence/strigoi-evidence-runtime.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { ThreadTranscriptStore } from "../src/persistence/thread-transcript-store.js";
import { AgentActivityStore } from "../src/persistence/agent-activity-store.js";
import { CodexProviderAdapter } from "../src/providers/codex.js";
import { CodexOrchestratorHome } from "../src/providers/codex/orchestrator-home.js";
import { CodexOrchestratorModelProbe } from "../src/providers/codex-orchestrator-model-probe.js";
import { WorkerCapabilityCatalog } from "../src/orchestration/worker-capability-catalog.js";
import { createSessionRuntime } from "../src/runtime/session-runtime-adapter.js";
import { WorkerTurnObservationAdapter } from "../src/runtime/worker-turn-observation-adapter.js";
import type { ProviderAdapter } from "../src/providers/provider.js";
import { composeGateServices } from "./strigoi-gate-services.js";
import type { CrashChildRequest, CrashObservation } from "./strigoi-gate-supervisor.js";

const command = promisify(execFile);
if (!process.send || !process.connected) throw new Error("Private supervisor IPC required");
process.once("disconnect", () => process.exit(2));
process.once("message", (message: CrashChildRequest) => {
  void run(message).catch(error => {
    process.send?.({ token: message.token, error: String(error) }, () => process.exit(1));
  });
});

async function run({ options: o, token, restart, synthetic }: CrashChildRequest) {
  const marker = JSON.parse(await readFile(join(o.stateDirectory, "strigoi-gate.lock"), "utf8"));
  if (marker.token !== token || marker.pid !== process.ppid || o.mode !== "crash" || (!synthetic && !o.allowInference)) throw new Error("Supervisor ownership/authorization mismatch");
  const record = (entry: unknown) => {
    const fd = openSync(join(o.stateDirectory, "child-resources.jsonl"), "a", 0o600);
    try { writeSync(fd, JSON.stringify({ token, controllerPid: process.pid, restart, at: new Date().toISOString(), entry }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const nativeRoot = join(o.stateDirectory, "native"), home = new CodexOrchestratorHome(nativeRoot);
  if (!restart) {
    await mkdir(nativeRoot, { mode: 0o700 });
    if (!synthetic) {
      await symlink(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), join(nativeRoot, "auth.json"));
      await writeFile(join(nativeRoot, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    }
  }
  const evidence = composeStrigoiEvidence(o.stateDirectory), sessions = new SessionStore(o.stateDirectory);
  const transcripts = new ThreadTranscriptStore(o.stateDirectory, { codexSessionsDirectory: join(nativeRoot, "sessions"), continuity: evidence.transcriptContinuity });
  await evidence.startup(transcripts, sessions);
  const activity = await AgentActivityStore.open(join(o.stateDirectory, "activity"));
  let launches = 0, submissions = 0;
  const identities = new WeakMap<object, { sessionId: string; generation: number | undefined }>();
  let services: Awaited<ReturnType<typeof composeGateServices>>;
  const observe = async (type: CrashObservation["type"]) => {
    const observation = { type, token, state: await evidence.orchestratorStore.strigoi.read(), launches, submissions };
    record(observation); process.send!(observation);
  };
  const native = new CodexProviderAdapter({ orchestratorHome: home, sourceEnvironment: { ...process.env, CODEX_HOME: home.directory },
    sessionsDirectory: join(nativeRoot, "sessions"), runCommand: async (exe, args, options) => {
      if (options.env.CODEX_HOME !== home.directory) throw new Error("Native home escaped ownership");
      record({ resource: "native-command", executable: exe, args, home: home.directory });
      return (await command("rtk", ["proxy", exe, ...args], { ...options, timeout: 30_000 })).stdout;
    } });
  const adapter: ProviderAdapter = {
    id: "codex",
    buildLaunchSpec: (session, prompt) => {
      const spec = synthetic ? { executable: process.execPath,
        args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => { require('node:fs').writeFileSync(process.argv[1], 'pipe EOF observed'); process.exit(0); });", join(o.stateDirectory, "synthetic-exit.txt")],
        cwd: o.selection.cwd, env: {}, transport: "pipe" as const } : native.buildLaunchSpec(session, prompt);
      identities.set(spec, { sessionId: session.id, generation: session.generation }); return spec;
    },
    buildResumeSpec: session => native.buildResumeSpec(session),
    prepareLaunch: async (session, spec) => {
      // Durable reservation and provisional session exist; no process has been spawned yet.
      if (!restart && o.caseId === "reserved-launch") { await observe("ready"); await new Promise(() => {}); }
      if (!synthetic) await native.prepareLaunch(session, spec);
    },
    submitInput: message => { submissions++; if (synthetic) throw new Error("Synthetic crash case must remain passive"); return native.submitInput(message); },
  };
  const registry = new SessionRegistry({ config: BrokerRuntimeConfigSchema.parse({}), adapters: { codex: adapter }, store: sessions, transcripts,
    recoveredSessions: restart ? await sessions.load() : [], journal: { append: async event => record({ event }) },
    sessionRuntimeFactory: (spec, bytes) => {
      // Restart must never manufacture process ownership from a persisted session/PID.
      launches++; record({ resource: "launch-attempt", launches });
      if (restart) throw new Error("Unexpected restart launch");
      const identity = identities.get(spec);
      if (!identity) throw new Error("Untracked crash-gate launch refused");
      const runtime = synthetic ? syntheticProcess(spec) : createSessionRuntime(spec, bytes);
      record({ resource: "session-process", ...identity, pid: runtime.pid, executable: spec.executable, nativeHome: home.directory, synthetic });
      runtime.onExit(code => record({ resource: "session-exit", ...identity, pid: runtime.pid, code }));
      return runtime;
    }, workerTurnObservation: new WorkerTurnObservationAdapter() });
  await registry.ready();
  const catalog = new WorkerCapabilityCatalog({ probe: new CodexOrchestratorModelProbe(undefined, home) });
  services = await composeGateServices({ root: o.stateDirectory, registry, transcripts, evidence, activity,
    readCapabilities: synthetic ? async () => [] : provider => catalog.resolve(provider) });
  // Explicit single driver, production participants; no timer races with the crash barrier.
  await services.start();
  if (!restart) await services.runtime.lifecycle.configure(o.selection, "crash-gate-configure");
  await services.runtime.lifecycle.reconcile();
  if (restart) {
    for (let n = 0; n < 8; n++) {
      const state = await evidence.orchestratorStore.strigoi.read();
      if (state.hold || !state.transition?.predecessor) break;
      await services.runtime.succession!.advance(state.transition.id);
    }
  }
  process.on("message", message => {
    const m = message as { type?: string; token?: string };
    if (m.type !== "close" || m.token !== token) return;
    void (async () => {
      await services.close(); await registry.stopAll(); await activity.close();
      record({ resource: "cleanup", scope: "only runtimes owned by this child", nativeOrphans: "UNQUALIFIED: never signal persisted PIDs" });
      process.exit(0);
    })().catch(error => { record({ cleanupError: String(error) }); process.exit(1); });
  });
  await observe(restart ? "recovered" : "ready");
}

/** No provider: a real passive process whose lifetime is bounded by the owned stdin pipe.
 * It records EOF itself; neither supervisor nor restart guesses its PID or retirement. */
function syntheticProcess(spec: import("../src/providers/provider.js").ProviderLaunchSpec): import("../src/domain/session-runtime.js").SessionRuntime {
  const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "ignore", "ignore"] });
  const callbacks = new Set<(code: number) => void>();
  let exit: number | undefined;
  child.once("exit", code => { exit = code ?? 1; for (const callback of callbacks) callback(exit); });
  return { pid: child.pid!, snapshot: () => Buffer.alloc(0), resize: () => {}, write: () => { throw new Error("Synthetic inference refused"); },
    kill: signal => { if (exit === undefined) child.kill(signal as NodeJS.Signals | undefined); }, onOutput: () => () => {},
    onExit: callback => { callbacks.add(callback); if (exit !== undefined) queueMicrotask(() => callback(exit!)); return () => { callbacks.delete(callback); }; } };
}
