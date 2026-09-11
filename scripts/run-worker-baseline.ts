import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLiveEvalConfig } from "../evals/harness/live-config.js";
import { ScenarioEvidenceSchema } from "../evals/assertions/evidence.js";
import { hardFailures, suiteFailures } from "../evals/assertions/invariants.js";

// Explicit configs only. Each provider runs sequentially, in its own disposable brokers.
if (process.versions.node.split(".")[0] !== "24") throw new Error("BASELINE_REQUIRES_NODE_24");
const paths = process.argv.slice(2);
if (!paths.length) throw new Error("Usage: run-worker-baseline.ts <private-live-config.json> [...]");
const root = fileURLToPath(new URL("../evals/", import.meta.url));
const configs = await Promise.all(paths.map(async (path) => ({ path: resolve(path), config: await loadLiveEvalConfig(resolve(path)) })));
if (configs.some(({ config }) => config.repetitions !== 3)) throw new Error("BASELINE_REQUIRES_THREE_REPETITIONS");
const output = join(root, "results", `baseline-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(output, { recursive: true, mode: 0o700 });
let failed = false;
for (const [index, { path, config }] of configs.entries()) {
  const destination = join(output, `${index}-${config.provider}.json`);
  console.log(JSON.stringify({ provider: config.provider, model: config.model, destination }));
  const code = await new Promise<number>((done, reject) => {
    const child = spawn(process.execPath, [join(root, "node_modules/promptfoo/dist/src/entrypoint.js"), "eval", "--config", "promptfooconfig.live.yaml", "--no-cache", "--max-concurrency", "1", "--output", destination],
      { cwd: root, stdio: "inherit", env: { ...process.env, CYBERDECK_LIVE_EVAL_CONFIG: path, PROMPTFOO_DISABLE_TELEMETRY: "1", PROMPTFOO_DISABLE_UPDATE: "1" } });
    child.once("error", reject); child.once("exit", (code) => done(code ?? 1));
  });
  const report = JSON.parse(await readFile(destination, "utf8"));
  const rows = (report.results?.results ?? []).map((row: { response?: { output?: string } }) => {
    try { return ScenarioEvidenceSchema.parse(JSON.parse(row.response?.output ?? "")); } catch { return undefined; }
  });
  const valid = rows.filter((row: unknown) => row !== undefined);
  const failures = suiteFailures(valid, "live-container", 3);
  const summary = { provider: config.provider, model: config.model, processExitCode: code, total: rows.length,
    passed: valid.filter((row: unknown) => hardFailures(row).length === 0).length, failures,
    scenarios: valid.map((row: ReturnType<typeof ScenarioEvidenceSchema.parse>) => ({ runId: row.runId, scenario: row.scenarioId,
      failures: hardFailures(row), metrics: row.metrics, commandCoverage: row.commandCoverage, artifacts: row.artifacts })) };
  await writeFile(destination.replace(/\.json$/, ".summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ provider: config.provider, total: summary.total, passed: summary.passed, failures }));
  failed ||= code !== 0 || failures.length > 0 || valid.length !== rows.length;
}
console.log(JSON.stringify({ output, passed: !failed }));
if (failed) process.exitCode = 1;
