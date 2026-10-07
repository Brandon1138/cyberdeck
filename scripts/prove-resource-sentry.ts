import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AgentActivitySchema } from "../src/domain/agent-activity.js";
import { projectActivity } from "../src/observability/activity-projection.js";
import { SentrySink } from "../src/observability/sentry-sink.js";

const [configPath, output, authorization] = process.argv.slice(2);
if (!configPath || !output?.startsWith("/private/tmp/cyberdeck-resource-") || authorization !== "--send-one") throw new Error("EXPLICIT_RESOURCE_PROBE_ARGUMENTS_REQUIRED");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.sentry?.enabled !== true) throw new Error("SENTRY_NOT_ENABLED");
await mkdir(output, { recursive: true, mode: 0o700 });
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
const sink = new SentrySink({ enabled: true, dsn: config.sentry.dsn, dailyCap: 1,
  sampleRate: config.sentry.sampleRate, budgetStateFile: join(output, "probe-budget.json") });
const sessionId = randomUUID();
let sent: ReturnType<typeof AgentActivitySchema.parse> | undefined;
try {
  for (let sequence = 1; sequence <= 100; sequence++) {
    const event = AgentActivitySchema.parse({ schemaVersion: 1, eventId: randomUUID(), sequence,
      sourceKey: "resource-synthetic-privacy-probe-v1", runId: randomUUID(), workerId: sessionId, sessionId,
      observedAt: new Date().toISOString(), kind: "resource.summary", provenance: "host-verified", coverage: "partial",
      operation: "resource", outcome: "observed", resource: { observedBytes: null, reservedBytes: 0,
        limitBytes: 8 * 1024 ** 3, peakBytes: null, uncertainBytes: 0, active: 0, parked: 0, queued: 0,
        queueDelayMs: 0, eventLoopP99Ms: 0, sampleDurationMs: 0, enforcement: "operational", reason: "metrics-unavailable" } });
    const projection = JSON.stringify(projectActivity(event));
    if (/\/Users\/|\/private\/|access_token|refresh_token|oauthToken|apiKey|dsn/.test(projection)) throw new Error("PROBE_PRIVACY_FAILURE");
    const before = sink.health().budget.used; sink.record(event);
    if (sink.health().budget.used > before) { sent = event; break; }
  }
  await sink.flush();
  const deadline = Date.now() + 5000;
  while (sink.health().queued && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20)); await sink.flush();
  }
  const evidence = { schemaVersion: 1, sourceSha, dirty, testMode: "synthetic-resource-sentry-probe",
    measuredWorkload: false, remoteReceiptVerified: false, node: process.version,
    eventId: sent?.eventId.replaceAll("-", ""), runId: sent?.runId, sessionId, observedAt: sent?.observedAt,
    eventHash: sent ? createHash("sha256").update(JSON.stringify(sent)).digest("hex") : null, health: sink.health() };
  await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  if (sent) await writeFile(join(output, "event.json"), JSON.stringify(sent, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence));
} finally { await sink.close(); }
