import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { projectActivity, sanitizeSentryEnvelope, correlationIds, serializeActivityEnvelope } from "../../src/observability/activity-projection.js";
import { AgentActivitySchema } from "../../src/domain/agent-activity.js";
it("drops every excluded field at the final serialized envelope boundary", () => {
  const id = randomUUID(), secret = "SYNTHETIC_SECRET_SENTINEL";
  const event = AgentActivitySchema.parse({ schemaVersion: 1, eventId: randomUUID(), sequence: 1, sourceKey: secret,
    runId: id, workerId: id, sessionId: id, observedAt: new Date().toISOString(), kind: "tool.invocation", operation: "tool",
    provenance: "provider-native", coverage: "partial", provider: secret, model: secret, payloadRef: `/private/${secret}`, toolCallId: secret,
  });
  const projection = projectActivity(event);
  const raw = [{ dsn: secret, sent_at: secret }, [[{ type: "transaction", arbitrary: secret }, {
    transaction: secret, exception: { values: [secret] }, request: { url: secret, headers: { authorization: secret } },
    breadcrumbs: [{ message: secret }], tags: { injected: secret }, extra: { prompt: secret, transcript: secret, source: secret, diff: secret },
    spans: [{ description: secret, data: { arguments: secret, output: secret, command: secret } }],
    start_timestamp: 100, timestamp: 999,
    contexts: { trace: { data: { "cyberdeck.projection": JSON.stringify(projection), "gen_ai.input.messages": secret } }, arbitrary: secret },
  }]]];
  const serialized = sanitizeSentryEnvelope(raw)!;
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("/private/");
  expect(serialized).toContain("gen_ai.execute_tool");
  const payload = JSON.parse(serialized.split("\n")[2]!);
  expect(payload.timestamp).toBe(payload.start_timestamp);
  expect(payload.tags["cyberdeck.timing"]).toBe("observation-marker");
  expect(payload.spans).toEqual([]);
  expect(sanitizeSentryEnvelope([{}, [[{ type: "event" }, { message: secret }]]])).toBeUndefined();
  expect(sanitizeSentryEnvelope([{}, [[{ type: "transaction" }, { contexts: { trace: { data: { "cyberdeck.projection": JSON.stringify({ ...projection, injected: secret }) } } } }]]])).toBeUndefined();
});
it("keeps an instruction's event segments causally linked without exporting native call IDs", () => {
  const id = randomUUID(), instructionId = randomUUID();
  const parent = projectActivity(AgentActivitySchema.parse({ schemaVersion: 1, eventId: randomUUID(), sequence: 1, sourceKey: "fixture", runId: id,
    workerId: id, sessionId: id, instructionId, observedAt: new Date().toISOString(), kind: "tool.invocation", operation: "tool", provenance: "provider-native", coverage: "partial", toolCallId: "sensitive-native-id" }));
  const child = { ...parent, eventId: randomUUID(), parentEventId: parent.eventId };
  expect(correlationIds(parent).traceId).toBe(correlationIds(child).traceId);
  const payload = JSON.parse(serializeActivityEnvelope(child, { start: 1, end: 1 }).split("\n")[2]!);
  expect(payload.contexts.trace.parent_span_id).toBe(correlationIds(parent).spanId);
  expect(JSON.stringify(payload)).not.toContain("sensitive-native-id");
});
