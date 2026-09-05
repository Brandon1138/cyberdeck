import { randomUUID } from "node:crypto";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentActivityStore } from "../../src/persistence/agent-activity-store.js";
import type { ActivityInput } from "../../src/domain/agent-activity.js";
import { collectNativeActivity } from "../../src/runtime/activity/provider-activity-collector.js";
import { codexActivity } from "../../src/runtime/activity/codex-activity.js";
import { claudeActivity } from "../../src/runtime/activity/claude-activity.js";
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "cyberdeck-activity-")); directories.push(path); return path; }
function input(): ActivityInput {
  const id = randomUUID(); return { schemaVersion: 1, eventId: randomUUID(), sourceKey: id, runId: id, workerId: id, sessionId: id,
    observedAt: new Date().toISOString(), kind: "instruction.queued", operation: "instruction", provenance: "broker", coverage: "complete-for-source", outcome: "observed" };
}
it("orders concurrent writes durably and deduplicates source frames through restart", async () => {
  const path = await directory(), store = await AgentActivityStore.open(path), event = input();
  const result = await Promise.all([store.append(event), store.append(event), store.append({ ...event, eventId: randomUUID(), sourceKey: "second" })]);
  expect(result.map((e) => e.sequence)).toEqual([1, 1, 2]);
  const recovered = await AgentActivityStore.open(path);
  expect((await recovered.append(event)).sequence).toBe(1);
  expect(await recovered.read(event.runId, 0, 100)).toHaveLength(2);
  await expect(recovered.append({ ...event, instructionId: randomUUID() })).rejects.toThrow("ACTIVITY_ATTRIBUTION_CONFLICT");
});
it("exposes byte retention loss through restart and rejects unbounded pages", async () => {
  const path = await directory(), store = await AgentActivityStore.open(path, { maxBytes: 1200, maxAgeMs: 86400000 });
  for (let i = 0; i < 5; i++) await store.append(input());
  expect(store.health().degraded).toBe(true);
  const recovered = await AgentActivityStore.open(path);
  expect(recovered.health().dropped).toBeGreaterThan(0);
  await expect(recovered.read(randomUUID(), 0, 1001)).rejects.toThrow("ACTIVITY_READ_LIMIT");
});
it("preserves torn tails and reports recording degradation", async () => {
  const path = await directory(), store = await AgentActivityStore.open(path);
  await store.append(input()); await appendFile(join(path, "activity.jsonl"), '{"torn":');
  const recovered = await AgentActivityStore.open(path);
  expect(recovered.health()).toMatchObject({ degraded: true, dropped: 1, retained: 1 });
  await recovered.append(input());
  expect((await AgentActivityStore.open(path)).health().retained).toBe(2);
});
it("retains tool call IDs with source provenance and detects conflicting turn attribution", async () => {
  const store = await AgentActivityStore.open(await directory()), base = input();
  const attribution = { runId: base.runId, workerId: base.workerId, sessionId: base.sessionId, generation: 2, instructionId: randomUUID(), providerTurnId: "turn-a" };
  const frames = [
    { type: "response_item", payload: { type: "function_call", call_id: "call-a", arguments: "SENSITIVE_ARGUMENT" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-a", output: "SENSITIVE_RESULT", turn_id: "turn-b" } },
  ];
  await collectNativeActivity({ provider: "codex", sourceId: "fixture", attribution, recorder: store, parse: codexActivity,
    lines: frames.map((frame, offset) => ({ offset, text: JSON.stringify(frame) })) });
  const events = await store.read(base.runId, 0, 100);
  expect(events[0]).toMatchObject({ kind: "tool.invocation", toolCallId: "call-a", instructionId: attribution.instructionId });
  expect(events[1]).toMatchObject({ kind: "capture.gap", gap: "attribution-conflict" });
  expect(JSON.stringify(events)).not.toContain("SENSITIVE_");
  expect(claudeActivity({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hidden" }, { type: "tool_use", id: "call-b", input: { secret: true } }] } })).toEqual([{ kind: "tool.invocation", toolCallId: "call-b" }]);
});
