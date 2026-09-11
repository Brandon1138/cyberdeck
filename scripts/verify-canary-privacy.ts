import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as Sentry from "@sentry/node";
import { SentrySink } from "../src/observability/sentry-sink.js";
import { AgentActivitySchema } from "../src/domain/agent-activity.js";

// Exercise the existing SDK + serializer with actual canary records, intercepted locally.
// This is privacy evidence, not a claim of remote delivery or indexing.
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: verify-canary-privacy.ts <events.json> <evidence.json>");
const events = AgentActivitySchema.array().parse(JSON.parse(await readFile(input, "utf8")));
assert.ok(events.length > 0);
const bodies: string[] = [];
const sink = new SentrySink({ enabled: true, dsn: "https://abcdef@localhost/1", dailyCap: events.length, sampleRate: 1,
  send: async body => { bodies.push(body); return { status: 200 }; } });
try {
  Sentry.setUser({ email: "PRIVATE_SCOPE_MARKER@example.invalid" });
  Sentry.setExtra("prompt", "PRIVATE_SCOPE_MARKER");
  for (const event of events) sink.record(event);
  await sink.flush();
  const deadline = Date.now() + 2000;
  while (sink.health().queued && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); await sink.flush(); }
  assert.equal(bodies.length, events.length);
  const ids = new Set(events.map(event => event.eventId.replaceAll("-", "")));
  for (const body of bodies) {
    assert.doesNotMatch(body, /PRIVATE_SCOPE_MARKER|SUBSCRIPTION_CANARY_OK|WRITABLE_SUBSCRIPTION_OK|\/Users\/|\/private\/|access_token|refresh_token|oauthToken|apiKey/);
    const [, item, payload] = body.split("\n").map(line => JSON.parse(line));
    assert.equal(item.type, "transaction"); assert.ok(ids.has(payload.event_id));
    assert.deepEqual(Object.keys(payload).sort(), ["contexts", "event_id", "measurements", "platform", "spans", "start_timestamp", "tags", "timestamp", "transaction", "type", "user"].sort());
    assert.deepEqual(payload.user, { ip_address: "0.0.0.0" });
    assert.equal(payload.tags["cyberdeck.sessionId"], events[0]!.sessionId);
    assert.equal(payload.tags["cyberdeck.workerId"], events[0]!.workerId);
    const source = events.find(event => event.eventId.replaceAll("-", "") === payload.event_id)!;
    assert.equal(payload.tags["cyberdeck.executionId"], source.executionId);
    assert.deepEqual(payload.spans, []);
  }
  const result = { passed: true, remoteDeliveryProved: false, envelopes: bodies.length,
    sessionId: events[0]!.sessionId, lifecycle: events.filter(event => event.kind === "execution.lifecycle").map(event => event.executionPhase),
    hashes: bodies.map(body => createHash("sha256").update(body).digest("hex")) };
  await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, envelopes: bodies.length, output }));
} finally { await sink.close(); }
