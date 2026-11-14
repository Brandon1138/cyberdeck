import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCrashGate } from "../../scripts/strigoi-gate-supervisor.js";
import type { StrigoiGateOptions } from "../../scripts/strigoi-gate-options.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each(["passive", "reserved-launch"])("actual isolated child crash/restart: %s, no provider", async caseId => {
  const root = await mkdtemp("/tmp/sc-"); roots.push(root);
  const sentinel = join(root, "primary.sock"); await writeFile(sentinel, "PRIMARY MUST REMAIN UNTOUCHED");
  const options: StrigoiGateOptions = { mode: "crash", caseId, stateDirectory: join(root, "gate"),
    selection: { provider: "codex", model: "gpt-5.6-sol", cwd: root }, allowInference: false, validateOnly: false };
  const result = await runCrashGate(options, true);
  expect(result).toMatchObject({ status: "EXPECTED_HOLD_NO_DUPLICATE", synthetic: true, death: { code: null, signal: "SIGKILL" },
    after: { launches: 0, submissions: 0, state: { hold: { code: caseId === "passive" ? "retirement-unconfirmed" : "launch-ownership-unresolved" } } },
    restartedControllerExit: { code: 0, signal: null } });
  const records = (await readFile(join(options.stateDirectory, "supervisor.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).entry);
  const children = records.filter(r => r.resource === "controller-child");
  expect(children).toHaveLength(2); expect(children[0].pid).not.toBe(children[1].pid);
  expect(children.every(c => c.pid !== process.pid)).toBe(true);
  expect(await readFile(sentinel, "utf8")).toBe("PRIMARY MUST REMAIN UNTOUCHED");
  if (caseId === "passive") expect(await readFile(join(options.stateDirectory, "synthetic-exit.txt"), "utf8")).toBe("pipe EOF observed");
  if (process.env.STRIGOI_CRASH_EVIDENCE_DIRECTORY) {
    await writeFile(join(process.env.STRIGOI_CRASH_EVIDENCE_DIRECTORY, `completion-crash-${caseId}.json`), JSON.stringify({ result, supervisor: records,
      resources: (await readFile(join(options.stateDirectory, "child-resources.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) }, null, 2));
  }
  await expect(runCrashGate(options, true)).rejects.toThrow("existing evidence is preserved");
}, 30000);
it("refuses live crash without authorization before creating state", async () => {
  const root = await mkdtemp("/tmp/sc-"); roots.push(root);
  await expect(runCrashGate({ mode: "crash", caseId: "passive", stateDirectory: join(root, "gate"),
    selection: { provider: "codex", model: "fixture", cwd: root }, allowInference: false, validateOnly: false })).rejects.toThrow("not authorized");
});
