import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerFixture, eventually } from "../evals/harness/broker-fixture.js";
import { loadLiveEvalConfig } from "../evals/harness/live-config.js";
import { trustedGit } from "../src/runtime/execution/trusted-git.js";
import { contentHash } from "../src/runtime/execution/workspace-manifest.js";
import type { SessionRecord } from "../src/domain/session.js";
import type { AgentActivity } from "../src/domain/agent-activity.js";

/**
 * The canary that turns a provider's container cell from unproved into supported. It runs one
 * real provider CLI, with the operator's model and credential file, inside one real container
 * through the production execution runtime, and records what actually happened:
 * an authenticated native turn, a native tool invocation captured by the recorder, a report that
 * arrived through the guest MCP gateway, the observed model, and a generation-2 resume that reuses
 * the same execution and native conversation. Nothing here runs without CYBERDECK_LIVE_EVAL_CONFIG.
 */
const live = await loadLiveEvalConfig();
const evidence = await mkdtemp(join(tmpdir(), "cyberdeck-provider-canary-"));
console.log(JSON.stringify({ evidence, provider: live.provider, model: live.model, authorizedCeilingUsd: live.authorizedCeilingUsd }));
const sourceCommit = (await trustedGit(process.cwd(), ["rev-parse", "HEAD"])).toString().trim();
const sourceDirty = Boolean((await trustedGit(process.cwd(), ["status", "--porcelain"])).toString().trim());
const REPORT = "Then call cyberdeck_report_progress once with structuredFacts.changedPaths listing every path you changed.";
const checks: Record<string, boolean> = {};
let broker: Awaited<ReturnType<typeof brokerFixture>> | undefined, resumed: SessionRecord | undefined, activity: AgentActivity[] = [];
try {
  broker = await brokerFixture(evidence, { mode: "live-container", live });
  const guestVersion = (await broker.container!.client.command(["run", "--rm", "--entrypoint", live.provider, broker.container!.image, "--version"])).trim();
  const first = broker.registry.get(broker.worker.id).execution!;
  const instruction = await broker.instruct(`Create a file named canary.txt containing exactly the word CANARY using your file tools. ${REPORT}`);
  await eventually(async () => (await broker!.queue.list(broker!.worker.id)).some((record) => record.id === instruction.id && record.status === "completed"), "CANARY_TURN_NOT_COMPLETED", broker.timeout);
  const thread = await broker.rpc.request<{ events: Array<{ kind: string; data: Record<string, unknown> }> }>("thread.read", { sessionId: broker.worker.id, afterCursor: 0, limit: 1000 });
  const nativeTurns = thread.events.filter((event) => event.kind === "turn" && event.data.transport === "provider-native");
  checks["authenticated-native-turn"] = nativeTurns.length >= 1;
  await eventually(async () => { activity = await broker!.activity.readSession!(broker!.worker.id, 0, 1000); return activity.some((event) => event.kind === "tool.invocation" && event.provenance === "provider-native"); }, "NATIVE_TOOL_NOT_CAPTURED", broker.timeout);
  checks["native-tool-captured"] = activity.some((event) => event.kind === "tool.invocation" && event.provenance === "provider-native" && event.instructionId === instruction.id);
  checks["report-through-guest-mcp"] = broker.reports.some((report) => report.workerId === broker!.worker.id && report.code === "accepted");
  const observed = broker.registry.get(broker.worker.id).observedModel;
  checks["observed-model-matches"] = observed?.model !== undefined && observed.model.includes(live.model);
  await broker.rpc.request("session.stopOne", { sessionId: broker.worker.id });
  await eventually(() => broker!.registry.get(broker!.worker.id).exitCode !== null, "CANARY_STOP_NOT_CONFIRMED", broker.timeout);
  resumed = await broker.rpc.request<SessionRecord>("session.resume", { sessionId: broker.worker.id });
  checks["resume-preserves-execution"] = resumed.generation === 2 && resumed.execution?.executionId === first.executionId && resumed.execution.backendId === first.backendId;
  const second = await broker.instruct(`Reply with the single word RESUMED. ${REPORT}`);
  await eventually(async () => (await broker!.queue.list(broker!.worker.id)).some((record) => record.id === second.id && record.status === "completed"), "RESUMED_TURN_NOT_COMPLETED", broker.timeout);
  const after = await broker.rpc.request<{ events: Array<{ kind: string; data: Record<string, unknown> }> }>("thread.read", { sessionId: broker.worker.id, afterCursor: 0, limit: 1000 });
  checks["resumed-native-turn"] = after.events.filter((event) => event.kind === "turn" && event.data.transport === "provider-native").length > nativeTurns.length;
  activity = await broker.activity.readSession!(broker.worker.id, 0, 1000);
  const body = JSON.stringify({ sourceCommit, sourceDirty, image: broker.container!.image, guestVersion, provider: live.provider, model: live.model, observed, first, resumed, checks,
    reports: broker.reports, thread: after.events, activity, spend: { measuredUsd: null, authorizedCeilingUsd: live.authorizedCeilingUsd } }, null, 2);
  await writeFile(join(evidence, "canary.json"), body, { mode: 0o600 });
  console.log(JSON.stringify({ evidence, sha256: contentHash(body), checks, guestVersion }));
  if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
} finally {
  await broker?.close().catch((error) => { console.error(String(error)); process.exitCode = 1; });
}
