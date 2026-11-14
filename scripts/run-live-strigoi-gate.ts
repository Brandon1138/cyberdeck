import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, readdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appStateDirectory, brokerSocketPath } from "../src/broker/app-paths.js";
import { StrigoiSelectionSchema, type StrigoiSelection } from "../src/domain/strigoi.js";
import { SessionRegistry } from "../src/broker/session-registry.js";
import { composeStrigoiRuntime } from "../src/broker/strigoi-runtime.js";
import { BrokerRuntimeConfigSchema } from "../src/config.js";
import { OrchestratorManager } from "../src/orchestration/orchestrator-manager.js";
import { StrigoiAdmission } from "../src/orchestration/strigoi-admission.js";
import { StrigoiContinuity } from "../src/orchestration/strigoi-continuity.js";
import { StrigoiTurns } from "../src/orchestration/strigoi-turns.js";
import { composeStrigoiEvidence } from "../src/persistence/strigoi-evidence-runtime.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { ThreadTranscriptStore } from "../src/persistence/thread-transcript-store.js";
import { AgentActivityStore } from "../src/persistence/agent-activity-store.js";
import { CodexProviderAdapter } from "../src/providers/codex.js";
import { CodexOrchestratorHome } from "../src/providers/codex/orchestrator-home.js";
import { createSessionRuntime } from "../src/runtime/session-runtime-adapter.js";
import { WorkerTurnObservationAdapter } from "../src/runtime/worker-turn-observation-adapter.js";

export interface StrigoiGateOptions { mode: "lifecycle"; stateDirectory: string; selection: StrigoiSelection; allowInference: boolean; validateOnly: boolean }
export function parseStrigoiGate(args: string[]): StrigoiGateOptions {
  const { values: v } = parseArgs({ args, strict: true, options: { mode: { type: "string" }, "state-directory": { type: "string" },
    cwd: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, "allow-inference": { type: "boolean" }, "validate-only": { type: "boolean" } } });
  if (v.mode !== "lifecycle" || !v["state-directory"] || !v.cwd || !v.model) throw new Error("Required: --mode lifecycle --state-directory ABSOLUTE --cwd ABSOLUTE --model MODEL [--effort EFFORT] --allow-inference (or --validate-only)");
  if (!isAbsolute(v["state-directory"]) || !isAbsolute(v.cwd)) throw new Error("State directory and cwd must be explicit absolute paths");
  if (!v["allow-inference"] && !v["validate-only"]) throw new Error("Live inference requires explicit --allow-inference");
  return { mode: "lifecycle", stateDirectory: resolve(v["state-directory"]), selection: StrigoiSelectionSchema.parse({ provider: "codex", model: v.model, cwd: v.cwd, effort: v.effort }),
    allowInference: v["allow-inference"] === true, validateOnly: v["validate-only"] === true };
}
const exists = async (path: string) => lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
const inside = (parent: string, child: string) => { const r = relative(parent, child); return r === "" || !r.startsWith("..") && !isAbsolute(r); };
export async function validateStrigoiGate(o: StrigoiGateOptions, protectedPaths = { state: appStateDirectory, socket: brokerSocketPath }): Promise<void> {
  const state = await exists(o.stateDirectory);
  if (state?.isSymbolicLink()) throw new Error("State directory must not be a symlink");
  const canonical = state ? await realpath(o.stateDirectory) : join(await realpath(dirname(o.stateDirectory)), o.stateDirectory.split("/").at(-1)!);
  const active = await realpath(protectedPaths.state).catch(() => resolve(protectedPaths.state));
  if (inside(active, canonical) || inside(canonical, active)) throw new Error("Refusing active broker state or an overlapping state directory");
  if (await exists(protectedPaths.socket)) throw new Error("Refusing while the active broker socket exists; this runner never contacts or restarts it");
  if (state && (!state.isDirectory() || (await readdir(o.stateDirectory)).length !== 0)) throw new Error("Use a new empty isolated state directory; existing evidence is preserved");
  if (!(await lstat(o.selection.cwd)).isDirectory()) throw new Error("cwd must be a directory");
  // Native RC adds its own Unix control socket suffix. Fail before launching an unusable home.
  if (Buffer.byteLength(join(canonical, "native", "cyberdeck-orchestrator")) > 65) throw new Error("Use a shorter isolated state path for the native Unix socket (for example a new directory under /tmp)");
}

/** Deliberately conversation-only. Task 10 extends this runner; no Fleet/nvim/broker socket is created. */
export async function runStrigoiGate(o: StrigoiGateOptions): Promise<void> {
  await validateStrigoiGate(o);
  if (o.validateOnly) { process.stdout.write(JSON.stringify({ status: "VALIDATED", live: "NOT RUN", ...o }) + "\n"); return; }
  if (!o.allowInference) throw new Error("Live inference is not authorized");
  await mkdir(o.stateDirectory, { recursive: true, mode: 0o700 });
  const lock = await open(join(o.stateDirectory, "strigoi-gate.lock"), "wx", 0o600);
  let registry: SessionRegistry | undefined, composition: Awaited<ReturnType<typeof composeStrigoiRuntime>> | undefined;
  const evidence = composeStrigoiEvidence(o.stateDirectory), sessions = new SessionStore(o.stateDirectory);
  const activity = await AgentActivityStore.open(join(o.stateDirectory, "activity"));
  try {
    const nativeRoot = join(o.stateDirectory, "native");
    await mkdir(nativeRoot, { mode: 0o700 });
    // Only the existing login is shared. Config, hooks, plugins, transcripts, daemon and sockets
    // stay inside this explicit isolated home; the user's orchestrator home is never prepared.
    await symlink(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), join(nativeRoot, "auth.json"));
    await writeFile(join(nativeRoot, "config.toml"), "model_provider = \"openai\"\n", { mode: 0o600 });
    const home = new CodexOrchestratorHome(nativeRoot);
    const transcripts = new ThreadTranscriptStore(o.stateDirectory, { codexSessionsDirectory: join(nativeRoot, "sessions"), continuity: evidence.transcriptContinuity });
    await evidence.startup(transcripts, sessions);
    const provider = new CodexProviderAdapter({ orchestratorHome: home, sourceEnvironment: { ...process.env, CODEX_HOME: home.directory }, sessionsDirectory: join(nativeRoot, "sessions") });
    registry = new SessionRegistry({ config: BrokerRuntimeConfigSchema.parse({}), adapters: { codex: provider }, store: sessions, transcripts,
      journal: { append: async (event) => { await writeFile(join(o.stateDirectory, "events.jsonl"), JSON.stringify(event) + "\n", { flag: "a", mode: 0o600 }); } },
      sessionRuntimeFactory: createSessionRuntime, workerTurnObservation: new WorkerTurnObservationAdapter() });
    await registry.ready();
    const bindings = evidence.orchestratorStore, admission = new StrigoiAdmission(bindings.strigoi, bindings, registry);
    const continuity = new StrigoiContinuity({ repository: bindings.strigoi, bindings, admission, packets: evidence.packets, sources: evidence.sources });
    const turns = new StrigoiTurns(registry, transcripts, async (kind, identity, packet) => {
      if (kind === "checkpoint") return 'Conversation-only lifecycle gate. Use no tools. Preserve the question "What is the next safe step?" and reply ONLY JSON {"checkpoint":"your concise understanding, uncertainty, and next step"}.';
      const page = await evidence.packets.read(packet!);
      if (page.nextCursor) throw new Error("Minimal lifecycle gate only supports one packet page; Task 10 expands the runner");
      const tail = await continuity.pending(identity);
      const prompt = `Conversation-only lifecycle gate. Use no tools or external actions. Read this original evidence and retain unresolved questions.\n${JSON.stringify({ packet: page, uncoveredTail: tail })}\nReply ONLY JSON ${JSON.stringify({ identity, packetHash: packet!.sha256, coverageId: packet!.coverageId, handledSourceIds: [], account: "Replace this with your intent, uncertainty and next safe step" })}. Do not claim pending inputs handled.`;
      if (Buffer.byteLength(prompt) > 32 * 1024) throw new Error("Minimal gate prompt exceeds page bound; no truncation");
      return prompt;
    });
    // Explicit Task 7/8 fixtures, safe only because this runner starts with empty private state
    // and exposes no normal input/worker API. This is never production participant wiring.
    const noWorkers = { reconcile: async () => registry!.list().some((s) => s.kind !== "orchestrator")
      ? [{ code: "unexpected-worker", detail: "Conversation-only fixture cannot reconcile workers", sourceIds: [] }] : [] };
    composition = await composeStrigoiRuntime({ repository: bindings.strigoi, bindings, admission, registry, continuity,
      manager: new OrchestratorManager(registry, bindings, undefined, undefined, async () => []),
      beforeDelete: evidence.beforeDelete, withDeletion: evidence.withDeletion, verifyContinuity: evidence.verify,
      succession: { turns, packets: evidence.packets, sources: evidence.sources, activity, workers: noWorkers, delivery: { hold: async () => {}, reconcile: async () => [] } } });
    await composition.lifecycle.configure(o.selection, "gate-configure");
    await composition.lifecycle.reconcile();
    const initial = await composition.lifecycle.inspect();
    if (!initial.state.activeBinding || initial.state.hold) throw new Error(`Passive launch held: ${initial.state.hold?.code ?? "not active"}`);
    const id = initial.state.activeBinding.sessionId;
    const deadline = Date.now() + 120_000;
    while (await turns.boundary({ sessionId: id, incarnation: 1, generation: initial.state.activeGeneration! }) !== "safe") {
      if (Date.now() >= deadline) throw new Error("Passive start has no safe boundary");
      await new Promise((r) => setTimeout(r, 250));
    }
    if ((await transcripts.readCompletionLedger(id)).canonicalTurns !== 0) throw new Error("Passive startup performed inference");
    const seedId = randomUUID();
    const message = 'Conversation-only lifecycle gate. Use no tools. Retain the exact unresolved question "What is the next safe step?" and the marker STRIGOI_CONTINUITY_GATE. Reply briefly that you recorded both; do not answer the question yet.';
    await transcripts.append({ sessionId: id, kind: "prompt", source: "human", text: message, data: { instructionId: seedId } });
    const delivered = await registry.submitInstruction(id, message, "broker", {}, seedId,
      (apply) => admission.run(id, "mutate", () => bindings.withAuthority(async () => apply())));
    if (delivered.state !== "rendered" || !delivered.expectedTurn) throw new Error("Conversation seed was not rendered; no blind retry");
    const seed = await registry.waitForWorkerResults([{ sessionId: id, completionTarget: delivered.expectedTurn }], 120_000, 32 * 1024);
    if (seed.timedOut || seed.results[0]?.provenance !== "provider-transcript" || seed.results[0]?.status !== "completed") throw new Error("Conversation seed did not produce a native completed turn");
    const transition = await composition.succession!.renew(1, "explicit-conversation-gate", "gate-renew");
    const until = Date.now() + 600_000;
    while (Date.now() < until) {
      const inspection = await composition.succession!.advance(transition.id);
      if (inspection.state.hold) throw new Error(`Succession held: ${inspection.state.hold.code}`);
      if (inspection.state.transition?.phase === "complete") {
        const result = { status: "MECHANICS_PASS", productionReady: false, participants: "Task 7/8 conversation-only fixtures", providerUsage: null,
          liveSemanticAcceptance: "requires independent evaluation", inspection };
        await writeFile(join(o.stateDirectory, "lifecycle-result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
        process.stdout.write(JSON.stringify(result) + "\n"); return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("Lifecycle gate deadline exceeded; evidence retained");
  } finally {
    composition?.dispose(); await registry?.stopAll(); await activity.close(); await lock.close();
    // Keep all evidence and the lock marker. Never delete state or guess at daemon ownership.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runStrigoiGate(parseStrigoiGate(process.argv.slice(2)));
}
