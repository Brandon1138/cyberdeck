// Drive an interactive Cursor `agent` through node-pty to test the stop hook's followup_message.
// usage: node pty-cursor.mjs <runId> <workspace> <prompt> [watchSeconds] [extra agent args...]
import { createRequire } from "node:module";
import { appendFileSync, writeFileSync } from "node:fs";

const require = createRequire("/Users/brandon/code/personal/cyberdeck-worktrees/onf-task-s/package.json");
const pty = require("node-pty");
const SCRATCH = "/private/tmp/cyberdeck-hook-spike";
const [runId, workspace, prompt, watch = "60", ...extra] = process.argv.slice(2);
const rawLog = `${SCRATCH}/${runId}.pty.raw`;
writeFileSync(rawLog, "");
const ev = (m) => console.log(`${new Date().toISOString()} ${m}`);
const env = { ...process.env, CURSOR_CONFIG_DIR: `${SCRATCH}/cursor-config`, CURSOR_DATA_DIR: `${SCRATCH}/cursor-data` };
const term = pty.spawn("agent", ["--workspace", workspace, "--model", "composer-2.5", ...extra],
  { name: "xterm-256color", cols: 160, rows: 50, cwd: workspace, env });
ev(`spawned pid=${term.pid}`);
let screen = "";
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const ack = new RegExp(`ACK CYBERDECK-SPIKE-NOTICE-${runId}`);
let acked = false;
term.onData((d) => {
  appendFileSync(rawLog, d);
  screen = (screen + strip(d)).slice(-100_000);
  if (!acked && ack.test(screen)) { acked = true; ev("first-seen ack"); }
});
term.onExit(({ exitCode }) => { ev(`exited ${exitCode}`); process.exit(0); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(10_000);
  term.write(prompt);
  await sleep(800);
  term.write("\r");
  ev("prompt submitted");
  await sleep(Number(watch) * 1000);
  ev(`watch over acked=${acked}`);
  try { term.kill(); } catch {}
  process.exit(0);
})();
