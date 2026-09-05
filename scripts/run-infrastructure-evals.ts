import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runScenario } from "../evals/harness/scenario-runner.js";
import { scenarioIds } from "../evals/scenarios/catalog.js";
import { suiteFailures } from "../evals/assertions/invariants.js";
if (process.argv.slice(2).join(" ") !== "--offline") throw new Error("Use --offline; live runs require explicit provider/model/spend configuration and native evidence support");
const evidence = [];
for (const id of scenarioIds) {
  const result = await runScenario(id); evidence.push(result);
  console.log(JSON.stringify({ scenario: id, status: result.status, evidence: result.artifacts[0]?.path, errors: result.harnessErrors }));
}
const failures = suiteFailures(evidence, "offline-scripted", 1);
const directory = join(import.meta.dirname, "../evals/results"); await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(join(directory, "offline-broker.json"), JSON.stringify({ evidence, failures }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ scenarios: evidence.length, failures }));
if (failures.length) process.exitCode = 1;
