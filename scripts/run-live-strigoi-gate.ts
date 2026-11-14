import { WorkerCapabilityCatalog } from "../src/orchestration/worker-capability-catalog.js";
import { CodexOrchestratorModelProbe } from "../src/providers/codex-orchestrator-model-probe.js";
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, readdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionRegistry } from "../src/broker/session-registry.js";
import { BrokerRuntimeConfigSchema } from "../src/config.js";
import { composeStrigoiEvidence } from "../src/persistence/strigoi-evidence-runtime.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { ThreadTranscriptStore } from "../src/persistence/thread-transcript-store.js";
import { AgentActivityStore } from "../src/persistence/agent-activity-store.js";
import { CodexProviderAdapter } from "../src/providers/codex.js";
import { CodexOrchestratorHome } from "../src/providers/codex/orchestrator-home.js";
import { createSessionRuntime } from "../src/runtime/session-runtime-adapter.js";
import { WorkerTurnObservationAdapter } from "../src/runtime/worker-turn-observation-adapter.js";
import { orchestratorController } from "../src/domain/orchestrator.js";
import { composeGateServices } from "./strigoi-gate-services.js";
import { semanticCase, runSemanticPair } from "./strigoi-gate-semantics.js";
import { runCrashGate } from "./strigoi-gate-supervisor.js";
import { parseStrigoiGate, validateStrigoiGate, type StrigoiGateOptions } from "./strigoi-gate-options.js";
export { parseStrigoiGate, validateStrigoiGate } from "./strigoi-gate-options.js";

const command = promisify(execFile);
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Explicit opt-in only. All services and native resources belong to a fresh private directory.
 * This is an isolated service controller, never a client of the operator's broker. */
export async function runStrigoiGate(o: StrigoiGateOptions): Promise<void> {
  if (o.mode === "crash") { await runCrashGate(o); return; }
  const selectedCase = o.mode === "semantic" ? await semanticCase(o.caseId) : undefined;
  await validateStrigoiGate(o);
  const nativeRoot = join(o.stateDirectory, "native"), home = new CodexOrchestratorHome(nativeRoot);
  const plan = { state: o.stateDirectory, nativeHome: home.directory, socketNamespace: home.directory,
    primaryContact: false, nvim: false, participants: "production Task7/8", idleMilliseconds: selectedCase ? null : 600_000,
    semanticCase: selectedCase ?? null,
    stages: selectedCase ? ["fresh resident and ordinary baseline", "matched fixed inputs", `${selectedCase.execution.handoffs} resident renewals and paired continuations`, "human review required"]
      : ["passive boot", "ten-minute idle/inspection", "normal delivery and worker result", "three renewals", "confirmed process loss without model checkpoint", "service reopen"],
    inferenceRequests: { observed: null, qualification: "UNQUALIFIED: adapter has no complete upstream request counter" },
    physicalBrokerCrash: "NOT RUN: select --mode crash --case passive or reserved-launch for supervised child SIGKILL/restart", humanSemantics: "NOT RUN" };
  if (o.validateOnly) { process.stdout.write(JSON.stringify({ status: "VALIDATED", live: "NOT RUN", plan, selection: o.selection }) + "\n"); return; }
  if (!o.allowInference) throw new Error("Live inference is not authorized");
  // Exclusive creation closes the validation/ownership race, including directory alias swaps.
  await mkdir(o.stateDirectory, { mode: 0o700 });
  const lock = await open(join(o.stateDirectory, "strigoi-gate.lock"), "wx", 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, id: randomUUID(), plan })); await lock.sync();
  const ownership = (entry: unknown) => {
    const fd = openSync(join(o.stateDirectory, "owned-processes.jsonl"), "a", 0o600);
    try { writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...entry as object }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  };
  ownership({ resource: "controller", pid: process.pid, nativeHome: home.directory, socketNamespace: home.directory });
  const processes: { pid: number; exited: boolean; executable: string; sessionId: string; resident: boolean }[] = [];
  const launches = new WeakMap<object, { sessionId: string; resident: boolean }>();
  const activeResidents = new Set<string>();
  const submissions: { sessionId: string | null; at: string }[] = [];
  let registry: SessionRegistry | undefined, services: Awaited<ReturnType<typeof composeGateServices>> | undefined;
  let activity: AgentActivityStore | undefined, daemonPrepared = false;
  const result: Record<string, unknown> = { status: "RUNNING", plan, selection: o.selection, providerUsage: null, costUsd: null, startedAt: new Date().toISOString(), stages: [] };
  const save = async () => writeFile(join(o.stateDirectory, "gate-result.json"), JSON.stringify({ ...result, processes, submissions }, null, 2), { mode: 0o600 });
  const version = async (exe: string, ...args: string[]) => (await command(exe, args, { timeout: 30_000 })).stdout.trim();
  try {
    result.versions = { node: process.version, provider: await version("codex", "--version"), source: await version("git", "rev-parse", "HEAD"), dirty: await version("git", "status", "--porcelain") };
    await mkdir(nativeRoot, { mode: 0o700 });
    // Share only the operator's login file. No primary config, hooks, skills, sockets or transcripts.
    await symlink(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), join(nativeRoot, "auth.json"));
    await writeFile(join(nativeRoot, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    let evidence = composeStrigoiEvidence(o.stateDirectory);
    const sessions = new SessionStore(o.stateDirectory);
    const transcripts = new ThreadTranscriptStore(o.stateDirectory, { codexSessionsDirectory: join(nativeRoot, "sessions"), continuity: evidence.transcriptContinuity });
    await evidence.startup(transcripts, sessions);
    activity = await AgentActivityStore.open(join(o.stateDirectory, "activity"));
    const env = { ...process.env, CODEX_HOME: home.directory };
    const provider = new CodexProviderAdapter({ orchestratorHome: home, sourceEnvironment: env, sessionsDirectory: join(nativeRoot, "sessions"),
      runCommand: async (exe, args, options) => {
        daemonPrepared = true; ownership({ resource: "native-daemon", home: home.directory, command: args });
        // Every native command uses the isolated home supplied in the launch spec.
        if (options.env.CODEX_HOME !== home.directory) throw new Error("Native home escaped ownership");
        return (await command(exe, [...args], { ...options, timeout: 30_000 })).stdout;
      } });
    const launchSpec = provider.buildLaunchSpec.bind(provider);
    provider.buildLaunchSpec = (session, prompt) => {
      const spec = launchSpec(session, prompt);
      // Observational only: actual authority remains the production resident repository.
      launches.set(spec, { sessionId: session.id, resident: session.kind === "orchestrator" && session.name === "Strigoi" });
      return spec;
    };
    const encode = provider.submitInput.bind(provider);
    provider.submitInput = (message, session?: import("../src/domain/session.js").SessionRecord) => {
      submissions.push({ sessionId: session?.id ?? null, at: new Date().toISOString() }); return encode(message);
    };
    registry = new SessionRegistry({ config: BrokerRuntimeConfigSchema.parse({}), adapters: { codex: provider }, store: sessions, transcripts,
      journal: { append: async event => { await writeFile(join(o.stateDirectory, "events.jsonl"), JSON.stringify(event) + "\n", { flag: "a", mode: 0o600 }); } },
      sessionRuntimeFactory: (spec, bytes) => {
        const metadata = launches.get(spec);
        if (!metadata) throw new Error("Untracked launch refused");
        const process = createSessionRuntime(spec, bytes), owned = { pid: process.pid, executable: spec.executable, exited: false, ...metadata };
        if (owned.resident) activeResidents.add(owned.sessionId);
        result.activeResidentHighWater = Math.max(Number(result.activeResidentHighWater ?? 0), activeResidents.size);
        processes.push(owned); ownership({ resource: "session-process", ...owned });
        process.onExit(() => { owned.exited = true; activeResidents.delete(owned.sessionId); ownership({ resource: "session-exit", pid: owned.pid }); });
        if (activeResidents.size > 1) { process.kill(); throw new Error("Resident physical high-water exceeded one"); }
        return process;
      }, workerTurnObservation: new WorkerTurnObservationAdapter() });
    await registry.ready();
    const capabilities = new WorkerCapabilityCatalog({ probe: new CodexOrchestratorModelProbe(undefined, home) });
    result.capabilities = await capabilities.resolve("codex");
    const compose = async () => composeGateServices({ root: o.stateDirectory, registry: registry!, transcripts, evidence, activity: activity!, readCapabilities: provider => capabilities.resolve(provider) });
    services = await compose(); await services.start(true);
    await services.runtime.lifecycle.configure(o.selection, "gate-configure"); await services.runtime.lifecycle.reconcile();
    const stages = result.stages as unknown[];
    const inspect = async () => {
      const state = (await services!.runtime.lifecycle.inspect()).state;
      if (state.hold) throw new Error(`Resident hold: ${state.hold.code}`);
      if (!state.activeBinding) throw new Error("No active resident binding");
      return state;
    };
    const waitSafe = async () => {
      const end = Date.now() + 120_000;
      while (Date.now() < end) {
        const state = await inspect();
        if (await services!.runtime.turns.boundary({ sessionId: state.activeBinding!.sessionId, incarnation: state.incarnation, generation: state.activeGeneration! }) === "safe") return state;
        await delay(250);
      }
      throw new Error("No safe provider boundary; no blind input retry");
    };
    const input = async (message: string) => {
      await waitSafe(); const receipt = await services!.runtime.delivery.submit(message, randomUUID());
      const until = Date.now() + 120_000;
      while (Date.now() < until) {
        await services!.instructions.flush(receipt.targetSessionId);
        const current = (await services!.instructions.list()).find(r => r.id === receipt.id)!;
        if (current.status === "completed") return current;
        await delay(500);
      }
      throw new Error("Normal input lacks completed native receipt; not retyped");
    };
    const renew = async (reason: string) => {
      const state = await inspect(), t = await services!.runtime.succession!.renew(state.incarnation, reason, randomUUID());
      const end = Date.now() + 600_000;
      while (Date.now() < end) {
        const s = (await services!.runtime.succession!.advance(t.id)).state;
        if (s.hold) throw new Error(`Renewal held: ${s.hold.code}`);
        if (s.transition?.phase === "complete") { stages.push({ stage: reason, transition: s.transition, packet: s.latestPacket }); await save(); return { transition: s.transition, packet: s.latestPacket }; }
        await delay(500);
      }
      throw new Error("Renewal deadline exceeded");
    };
    if (selectedCase) {
      const baseline = await services.manager.ensure({ ...o.selection, scope: "fleet" });
      result.noHandoffSessionId = baseline.session.id;
      result.semanticPair = await runSemanticPair(selectedCase, {
        submit: async (arm, message) => {
          let receipt;
          if (arm === "resident") receipt = await input(message);
          else {
            const accepted = await services!.instructions.enqueue({ actorSessionId: baseline.session.id, targetSessionId: baseline.session.id, message });
            const deadline = Date.now() + 120_000;
            for (;;) {
              await services!.instructions.flush(baseline.session.id);
              receipt = (await services!.instructions.list()).find(r => r.id === accepted.id)!;
              if (receipt.status === "completed") break;
              if (Date.now() >= deadline) throw new Error("Semantic baseline receipt unavailable; pair incomplete");
              await delay(500);
            }
          }
          if (!receipt.expectedTurn) throw new Error("Semantic completion lacks exact native turn ordinal");
          const output = await registry!.waitForWorkerResults([{ sessionId: receipt.targetSessionId, completionTarget: receipt.expectedTurn }], 5000);
          if (output.timedOut || output.results[0]?.provenance !== "provider-transcript") throw new Error("Semantic output lacks native evidence");
          return { receipt, output };
        },
        renew: async reason => { await waitSafe(); return renew(reason); },
        save: async evidence => { await writeFile(join(o.stateDirectory, "semantic-pair.json"), JSON.stringify({ selection: o.selection, versions: result.versions, evidence }, null, 2), { mode: 0o600 }); },
      });
      result.status = "PAIR_CAPTURED_HUMAN_REVIEW_REQUIRED";
      return;
    }
    await waitSafe();
    const idleStart = Date.now(); await save();
    while (Date.now() - idleStart < 600_000) { await inspect(); await delay(1000); }
    const passive = await inspect(), passiveLedger = await transcripts.readCompletionLedger(passive.activeBinding!.sessionId);
    stages.push({ stage: "passive", elapsedMs: Date.now() - idleStart, encodedInstructionRequests: submissions.length,
      canonicalTurns: passiveLedger.canonicalTurns, inferenceRequests: null, status: "UNQUALIFIED" });
    await save();
    if (submissions.length || passiveLedger.canonicalTurns) throw new Error("Passive inference activity observed");
    const recoverySeed = "Alfred: original recovery constraint is review only; publication awaits approval. Use no external tools or actions.";
    const conversationSeed = "Isolated Strigoi acceptance. Alfred, review only; never publish. Approval is outstanding. Preserve that constraint and its rationale. Use no external tools or actions. Reply briefly.";
    const question = "What is the original constraint, why does it apply, and what is the next safe action? Use no external tools or actions.";
    // Exercise abrupt loss before any model checkpoint exists, then wake adoption with input.
    await registry.stopResidentProcess(passive.activeBinding!.sessionId);
    await services.close(); evidence = composeStrigoiEvidence(o.stateDirectory); await evidence.startup(transcripts, sessions);
    services = await compose(); await services.start(true); await services.runtime.lifecycle.reconcile();
    const firstRecovery = (await inspect()).transition!;
    await services.runtime.delivery.submit(recoverySeed, randomUUID());
    const recoveryDeadline = Date.now() + 600_000;
    for (;;) {
      const s = (await services.runtime.succession!.advance(firstRecovery.id)).state;
      if (s.hold) throw new Error(`No-checkpoint recovery held: ${s.hold.code}`);
      if (s.transition?.phase === "complete") break;
      if (Date.now() > recoveryDeadline) throw new Error("No-checkpoint recovery deadline exceeded");
      await delay(500);
    }
    stages.push({ stage: "no-checkpoint process-exit recovery", inspection: await inspect() });
    await input(conversationSeed);
    const owner = (await inspect()).activeBinding!, controller = orchestratorController(owner);
    const worker = await registry.start({ provider: "codex", model: o.selection.model, ...(o.selection.effort ? { effort: o.selection.effort } : {}), cwd: o.selection.cwd,
      detached: true, sandbox: "workspace-write" }, "Isolated acceptance: no tools or external actions. Reply exactly WORKER_REVIEW_ONLY.");
    const registered = await services.coordination.registerSubject({ mutationId: randomUUID(), actor: controller, subjectId: worker.id, controller, lifecycle: "working", reason: "isolated acceptance",
      origin: { creatorControllerId: controller.controllerId, creatorSessionId: owner.sessionId, taskId: worker.id, threadId: worker.id, createdAt: worker.createdAt }, resources: { sessionId: worker.id, eventStreamId: worker.id } });
    const lease = registered.outcomes[0]!; services.credentials.set(controller.controllerId, worker.id, { leaseVersion: lease.leaseVersion!, leaseToken: lease.leaseToken! });
    await services.attention.arm({ actorSessionId: owner.sessionId, mutationId: randomUUID(), objective: "Review isolated worker", nextAction: "Inspect result", targets: [{ sessionId: worker.id, completionTarget: 1 }] });
    const workerResult = await registry.waitForWorkerResults([{ sessionId: worker.id, completionTarget: 1 }], 120_000);
    if (workerResult.timedOut || workerResult.results[0]?.provenance !== "provider-transcript") throw new Error("Worker lacks native result");
    const workerEvidence = "Original entrusted worker evidence: " + JSON.stringify(workerResult.results);
    await input(workerEvidence);
    for (let n = 1; n <= 3; n++) {
      await waitSafe(); await renew(`planned-${n}`);
      await input(question);
    }
    // Confirmed process exit, then reopen durable collaborators; this does not pretend that
    // an unknown orphan is safe to replace, or that service reopen proves a broker SIGKILL.
    const prior = await inspect(); await registry.stopResidentProcess(prior.activeBinding!.sessionId);
    await services.close(); evidence = composeStrigoiEvidence(o.stateDirectory); await evidence.startup(transcripts, sessions);
    services = await compose(); await services.start(true); await services.runtime.lifecycle.reconcile();
    const recovery = (await inspect()).transition!;
    for (let n = 0; n < 1200; n++) {
      const s = (await services.runtime.succession!.advance(recovery.id)).state;
      if (s.hold) throw new Error(`Recovery held: ${s.hold.code}`);
      if (s.transition?.phase === "complete") break;
      if (n === 1199) throw new Error("Recovery did not complete");
      await delay(500);
    }
    stages.push({ stage: "process-exit/service-reopen", inspection: await inspect() });
    result.status = "MECHANICS_OBSERVED_SEMANTICS_UNQUALIFIED";
    result.noCheckpointRecovery = "Observed confirmed process exit and service reopen; not a physical broker crash";
    // Independent ordinary Orc baseline under the same selected provider/model/effort/cwd.
    const baseline = await services.manager.ensure({ ...o.selection, scope: "fleet" });
    for (const message of [recoverySeed, conversationSeed, workerEvidence, ...Array.from({ length: 3 }, () => question)]) {
      const receipt = await services.instructions.enqueue({ actorSessionId: baseline.session.id, targetSessionId: baseline.session.id, message });
      const until = Date.now() + 120_000;
      for (;;) {
        await services.instructions.flush(baseline.session.id);
        if ((await services.instructions.list()).find(r => r.id === receipt.id)?.status === "completed") break;
        if (Date.now() >= until) throw new Error("No-handoff baseline receipt unavailable");
        await delay(500);
      }
    }
    result.noHandoffSessionId = baseline.session.id;
    result.comparison = { matchedInputPrompts: [recoverySeed, conversationSeed, workerEvidence, question, question, question],
      limitation: "Matched synthetic conversation prompts; handoff adds mechanical source inventories. Human review remains required." };
    result.humanReview = "NOT RUN: compare private continuations against no-handoff baseline using semantic-cases.json";
  } catch (error) {
    result.status = "FAILED_OR_UNAVAILABLE"; result.error = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    const cleanup: Record<string, unknown> = {};
    try { await services?.close(); await registry?.stopAll(); cleanup.sessions = "stopAll completed"; } catch (error) { cleanup.sessions = String(error); }
    try { await activity?.close(); } catch (error) { cleanup.activity = String(error); }
    // Stop only the native daemon in the newly created home, never discover a primary PID.
    if (daemonPrepared) {
      try { await command("codex", ["app-server", "daemon", "stop"], { env: { ...process.env, CODEX_HOME: home.directory }, timeout: 30_000 }); cleanup.daemon = "isolated stop completed"; }
      catch { cleanup.daemon = "UNQUALIFIED: isolated daemon stop unavailable; retained owned home needs operator inspection"; }
    }
    cleanup.processes = processes; cleanup.nativeEntries = await readdir(home.directory).catch(() => []);
    if (registry) result.canonicalTurns = await Promise.all(registry.list().map(async session => ({ sessionId: session.id,
      canonicalTurns: await new ThreadTranscriptStore(o.stateDirectory).readCompletionLedger(session.id).then(ledger => ledger.canonicalTurns).catch(() => null) })));
    result.cleanup = cleanup; result.endedAt = new Date().toISOString(); await save(); await lock.close();
    process.stdout.write(JSON.stringify({ status: result.status, evidence: join(o.stateDirectory, "gate-result.json"), liveSemanticAcceptance: "NOT RUN", inferenceRequestQualification: "UNQUALIFIED" }) + "\n");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runStrigoiGate(parseStrigoiGate(process.argv.slice(2)));
