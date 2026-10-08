// Drive an interactive `claude` through node-pty to test asyncRewake on a truly idle session.
// usage: node pty-claude.mjs <runId> <settings.json> <prompt> [watchSeconds]
// cwd is the worktree because it inherits trust from /Users/brandon; accepting trust for a new
// directory would write ~/.claude.json, which this spike must not do.
import { createRequire } from "node:module";
import { appendFileSync, writeFileSync } from "node:fs";

const WORKTREE = "/Users/brandon/code/personal/cyberdeck-worktrees/onf-task-s";
const require = createRequire(`${WORKTREE}/package.json`);
const pty = require("node-pty");

const [runId, settings, prompt, watch = "75"] = process.argv.slice(2);
const SCRATCH = "/private/tmp/cyberdeck-hook-spike";
const rawLog = `${SCRATCH}/${runId}.pty.raw`;
const eventLog = `${SCRATCH}/${runId}.pty.events`;
writeFileSync(rawLog, "");
writeFileSync(eventLog, "");
const ev = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  appendFileSync(eventLog, line + "\n");
  console.log(line);
};

const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;
delete env.CLAUDE_CODE_CHILD_SESSION;
env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = "1";
const args = [
  "--settings", settings, "--setting-sources", "local",
  "--mcp-config", `${SCRATCH}/mcp.json`, "--strict-mcp-config",
  "--allowedTools", "Bash(echo spike)", "mcp__echo__echo",
  "--model", "haiku",
];
const term = pty.spawn("claude", args, { name: "xterm-256color", cols: 160, rows: 50, cwd: WORKTREE, env });
ev(`spawned pid=${term.pid}`);

let screen = "";
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b[()][0-9A-B]/g, "");
const seen = new Set();
const watchFor = {
  trust: /trust this folder|Do you trust/i,
  promptReady: /for shortcuts|❯/,
  marker: new RegExp(`CYBERDECK-SPIKE-NOTICE-${runId}`),
  ack: new RegExp(`ACK CYBERDECK-SPIKE-NOTICE-${runId}`),
};
term.onData((d) => {
  appendFileSync(rawLog, d);
  screen += strip(d);
  if (screen.length > 200_000) screen = screen.slice(-100_000);
  for (const [name, re] of Object.entries(watchFor)) {
    if (!seen.has(name) && re.test(screen)) { seen.add(name); ev(`first-seen ${name}`); }
  }
});
term.onExit(({ exitCode }) => { ev(`exited ${exitCode}`); finish(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let done = false;
function finish() {
  if (done) return;
  done = true;
  const ackCount = (screen.match(watchFor.ack) ?? []).length;
  ev(`summary seen=${[...seen].join(",")} ackOccurrences=${ackCount}`);
  try { term.kill(); } catch {}
  process.exit(0);
}

(async () => {
  for (let i = 0; i < 40 && !seen.has("promptReady") && !seen.has("trust"); i++) await sleep(500);
  if (seen.has("trust")) { ev("trust dialog shown; refusing to accept it (would write ~/.claude.json)"); return finish(); }
  await sleep(1500);
  term.write(prompt);
  await sleep(700);
  term.write("\r");
  ev("prompt submitted");
  const deadline = Date.now() + Number(watch) * 1000;
  while (Date.now() < deadline) await sleep(500);
  ev("watch window over");
  finish();
})();
