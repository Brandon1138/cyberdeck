// Isolated controller process using production lifecycle/stores and a real host PTY.
// No socket, provider CLI, credentials or shared state. Model output is deliberately absent.
import { SessionRegistry } from "../../../src/broker/session-registry.js";
import { BrokerRuntimeConfigSchema } from "../../../src/config.js";
import { composeStrigoiRuntime } from "../../../src/broker/strigoi-runtime.js";
import { composeStrigoiEvidence } from "../../../src/persistence/strigoi-evidence-runtime.js";
import { SessionStore } from "../../../src/persistence/session-store.js";
import { ThreadTranscriptStore } from "../../../src/persistence/thread-transcript-store.js";
import { StrigoiAdmission } from "../../../src/orchestration/strigoi-admission.js";
import { StrigoiContinuity } from "../../../src/orchestration/strigoi-continuity.js";
import { WorkerTurnObservationAdapter } from "../../../src/runtime/worker-turn-observation-adapter.js";
import { PtyProcess } from "../../../src/runtime/pty-process.js";
import type { StartSessionRequest } from "../../../src/domain/session.js";
const root = process.argv[2]!;
const evidence = composeStrigoiEvidence(root), store = new SessionStore(root);
const transcripts = new ThreadTranscriptStore(root, { continuity: evidence.transcriptContinuity });
await evidence.startup(transcripts, store);
let launches = 0, submissions = 0, clock = Date.now();
const registry = new SessionRegistry({ config: BrokerRuntimeConfigSchema.parse({}), store, transcripts,
  recoveredSessions: await store.load(), journal: { append: async () => {} },
  workerTurnObservation: new WorkerTurnObservationAdapter(),
  adapters: { codex: { id: "codex", buildLaunchSpec: () => ({ executable: process.execPath,
    args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], cwd: root, env: {}, transport: "pty" }),
    buildResumeSpec: () => { throw new Error("in-place resume forbidden"); },
    initializeSession: async () => {}, submitInput: () => { submissions++; throw new Error("unsolicited inference"); } } },
  sessionRuntimeFactory: (spec, bytes) => { launches++; return new PtyProcess(spec, bytes); },
});
await registry.ready();
const bindings = evidence.orchestratorStore, admission = new StrigoiAdmission(bindings.strigoi, bindings, registry);
const continuity = new StrigoiContinuity({ repository: bindings.strigoi, bindings, admission, packets: evidence.packets, sources: evidence.sources });
const runtime = await composeStrigoiRuntime({ repository: bindings.strigoi, bindings, admission, registry, continuity,
  manager: { prepareResident: async selection => ({ request: { ...selection, kind: "orchestrator", role: "orchestrator",
    orchestratorScope: "fleet", sandbox: "read-only", detached: true, providerInstructions: "" } as StartSessionRequest, warnings: [] }), observeResident: async () => {} },
  verifyContinuity: evidence.verify,
  succession: { packets: evidence.packets, sources: evidence.sources, now: () => clock,
    turns: { boundary: async () => "safe", observe: async () => ({ outcome: "unknown" }), submit: async () => { submissions++; throw new Error("unsolicited adoption"); } },
    workers: { reconcile: async () => [] }, delivery: { hold: async () => {}, needsAdoption: async () => false, reconcile: async () => [] } },
});
// A private test command drives each tick; no production timer is installed.
runtime.lifecycle.wakeSuccession = () => {};
if (!(await bindings.strigoi.read()).selection) await runtime.lifecycle.configure({ provider: "codex", model: "fixture", cwd: root }, "configure");
async function observe(id: number) {
  process.send?.({ id, state: await bindings.strigoi.read(), records: registry.list(), launches, submissions,
    owned: registry.list().filter(r => registry.ownsProcess(r.id) && r.exitCode === null).map(r => r.id) });
}
async function waitRetired(id: string) {
  for (let n = 0; n < 100; n++) {
    if (await registry.residentRetirement(id, registry.get(id).generation!) === "confirmed") return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error("owned process did not retire");
}
let tail = Promise.resolve();
process.on("message", (m: { id: number; op: string; milliseconds?: number }) => {
  tail = tail.then(async () => {
    if (m.op === "stop-provider") {
      const id = (await bindings.strigoi.read()).activeBinding!.sessionId;
      await registry.stopResidentProcess(id); await waitRetired(id);
    } else if (m.op === "close") {
      runtime.dispose();
      const owned = registry.list().filter(r => registry.ownsProcess(r.id) && r.exitCode === null);
      await registry.stopAll(); for (const r of owned) await waitRetired(r.id);
      await observe(m.id); process.disconnect?.(); process.exit(0);
    } else if (m.op === "suspend") await runtime.lifecycle.setDesired("suspended", `suspend:${m.id}`);
    else if (m.op === "tick") { clock += m.milliseconds ?? 0; await runtime.lifecycle.reconcile(); }
    await observe(m.id);
  }).catch(error => { process.send?.({ id: m.id, error: String(error) }); });
});
await runtime.lifecycle.reconcile(); await observe(0);
