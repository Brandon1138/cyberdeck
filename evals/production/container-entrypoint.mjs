import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

// Fixed guest-only paths: no host credentials, dynamic provider, shell, judge or network.
const inputPath = "/run/input.json", work = "/run/evaluation";
const reportPath = `${work}/report.json`, configPath = `${work}/config.json`;
async function boundedRead(path, cap) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > cap) throw new Error("FILE_CAP");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
try {
  const raw = await boundedRead(inputPath, 256 * 1024), input = JSON.parse(raw);
  if (input.version !== 1 || !input.manifest || !Array.isArray(input.requiredChecks)
    || input.requiredChecks.length > 100 || input.requiredChecks.some(id => typeof id !== "string" || !/^[a-z0-9-]{1,128}$/.test(id))) throw new Error("INPUT_INVALID");
  await mkdir("/tmp/home", { recursive: true, mode: 0o700 });
  const config = { description: "cyberdeck-offline-evaluator-v1", prompts: ["{{evidence}}"],
    providers: ["file:///opt/evaluator/production/echo-provider.cjs"], evaluateOptions: { maxConcurrency: 1, cache: false },
    tests: [{ vars: { evidence: JSON.stringify(input.manifest) }, assert: [{ type: "javascript", value:
      `const m=JSON.parse(output);const required=${JSON.stringify(input.requiredChecks)};return m.complete && required.length>0 && required.every(id=>m.checks.filter(c=>c.id===id&&c.source==='host-verified'&&c.passed===true).length===1);` }] }] };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
  const completed = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["/opt/evaluator/node_modules/promptfoo/dist/src/entrypoint.js", "eval", "--config", configPath,
      "--no-cache", "--max-concurrency", "1", "--output", reportPath], { cwd: work, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/home", NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=460",
        PROMPTFOO_DISABLE_TELEMETRY: "1", PROMPTFOO_DISABLE_UPDATE: "1", PROMPTFOO_DISABLE_PROGRESS_BAR: "1" } });
    let bytes = 0, overflow = false, timedOut = false;
    const collect = chunk => { bytes += chunk.length; if (bytes > 64 * 1024) { overflow = true; child.kill("SIGKILL"); } };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 45000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve(code !== null && !signal && !overflow && !timedOut); });
  });
  if (!completed) throw new Error("PROCESS_FAILED");
  // Assertion failures exit nonzero; only complete structured evidence is returned to the host.
  const report = JSON.parse(await boundedRead(reportPath, 512 * 1024));
  if (!Array.isArray(report?.results?.results) || report.results.results.length !== 1) throw new Error("REPORT_INVALID");
  const envelope = JSON.stringify({ version: 1, inputHash: createHash("sha256").update(raw).digest("hex"), report });
  if (Buffer.byteLength(envelope) > 768 * 1024) throw new Error("REPORT_CAP");
  process.stdout.write(envelope);
} catch {
  // Raw Promptfoo output stays private and bounded; host records infrastructure failure.
  process.exitCode = 1;
}
