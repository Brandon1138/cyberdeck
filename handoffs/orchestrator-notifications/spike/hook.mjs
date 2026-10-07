#!/usr/bin/env node
// Spike hook: log the payload shape, then answer in the provider's hook-output dialect.
// usage: hook.mjs <provider> <event> <runId> [--shape context|block|followup|none]
//                 [--print-nothing] [--exit <code>] [--sleep-ms <n>] [--stderr] [--once] [--once-file <path>]
import { appendFileSync } from "node:fs";

const LOG = "/private/tmp/cyberdeck-hook-spike/hooks.log";
const [provider, event, runId, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const value = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const shape = value("--shape") ?? "context";
const exitCode = Number(value("--exit") ?? 0);
const sleepMs = Number(value("--sleep-ms") ?? 0);
const marker = `CYBERDECK-SPIKE-NOTICE-${runId}`;
const startedAt = new Date().toISOString();

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", async () => {
  let payload = {};
  try { payload = JSON.parse(raw); } catch { payload = { unparseable: raw.slice(0, 200) }; }
  const short = (v) => (v === undefined ? undefined : JSON.stringify(v).slice(0, 240));
  appendFileSync(LOG, JSON.stringify({
    ts: startedAt,
    provider, event, runId, shape,
    hookEventName: payload.hook_event_name ?? payload.hookEventName,
    toolName: payload.tool_name ?? payload.toolName ?? payload.tool?.name,
    stopHookActive: payload.stop_hook_active,
    status: payload.status,
    loopCount: payload.loop_count,
    toolInput: short(payload.tool_input),
    toolResponse: short(payload.tool_response ?? payload.tool_output ?? payload.error),
    transcriptPath: payload.transcript_path,
    rawKeys: Object.keys(payload),
  }) + "\n");

  // --once-file <path>: fire the real behaviour only the first time (async loop guard)
  const onceFile = value("--once-file");
  if (onceFile) {
    const { existsSync, writeFileSync } = await import("node:fs");
    if (existsSync(onceFile)) process.exit(0);
    writeFileSync(onceFile, startedAt);
  }
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  if (flag("--stderr")) process.stderr.write(`${marker}\n`);
  // --once: stay silent on a re-entered Stop (loop guard)
  const suppressed = flag("--once") && (payload.stop_hook_active === true || (payload.loop_count ?? 0) > 0);
  if (!flag("--print-nothing") && shape !== "none" && !suppressed) {
    process.stdout.write(JSON.stringify(response()) + "\n");
  }
  appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), provider, event, runId, phase: "exit", exitCode }) + "\n");
  process.exit(exitCode);
});

function response() {
  const text = `${marker} (cyberdeck notice: 1 pending; drain with cyberdeck_notifications_read)`;
  if (provider === "cursor") {
    return shape === "followup" ? { followup_message: text } : { additional_context: text };
  }
  if (shape === "block") return { decision: "block", reason: text };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}
