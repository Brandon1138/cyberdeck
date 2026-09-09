import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runScenario } from "../evals/harness/scenario-runner.js";
import { scenarioIds } from "../evals/scenarios/catalog.js";
import { suiteFailures } from "../evals/assertions/invariants.js";
import { loadLiveEvalConfig } from "../evals/harness/live-config.js";
import type { EvalMode } from "../evals/assertions/evidence.js";
const flag = process.argv.slice(2).join(" ");
const mode: EvalMode = flag === "--offline" ? "offline-scripted" : flag === "--container" ? "container-scripted" : flag === "--live" ? "live-container" : (() => {
  throw new Error("Use --offline (scripted host), --container (real OrbStack, scripted guest, no model) or --live (CYBERDECK_LIVE_EVAL_CONFIG required)"); })();
const live = mode === "live-container" ? await loadLiveEvalConfig() : undefined;
const repetitions = live?.repetitions ?? 1, evidence = [];
for (let repetition = 0; repetition < repetitions; repetition++) {
  for (const id of scenarioIds) {
    const result = await runScenario(id, mode, live ? { live } : {}); evidence.push(result);
    console.log(JSON.stringify({ scenario: id, repetition, status: result.status, evidence: result.artifacts[0]?.path, errors: result.harnessErrors, image: result.image }));
  }
}
const failures = suiteFailures(evidence, mode, repetitions);
const directory = join(import.meta.dirname, "../evals/results"); await mkdir(directory, { recursive: true, mode: 0o700 });
const name = mode === "offline-scripted" ? "offline-broker.json" : mode === "container-scripted" ? "container-broker.json" : "live-broker.json";
await writeFile(join(directory, name), JSON.stringify({ mode, repetitions, evidence, failures }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ mode, scenarios: evidence.length, failures }));
if (failures.length) process.exitCode = 1;
