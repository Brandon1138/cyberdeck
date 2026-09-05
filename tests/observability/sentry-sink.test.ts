import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { SentrySink } from "../../src/observability/sentry-sink.js";
import { AgentActivitySchema } from "../../src/domain/agent-activity.js";
it("uses the real SDK/OTel pipeline while a failing metadata transport cannot throw into activity", async () => {
  const bodies: string[] = [];
  const sink = new SentrySink({ enabled: true, dsn: "https://abcdef@localhost/1", dailyCap: 10, sampleRate: 1,
    send: async (body) => { bodies.push(body); throw new Error("sink offline"); } });
  try {
    const id = randomUUID();
    const event = AgentActivitySchema.parse({ schemaVersion: 1, eventId: randomUUID(), sequence: 1, sourceKey: "fixture",
      runId: id, workerId: id, sessionId: id, observedAt: new Date().toISOString(), kind: "instruction.queued", operation: "instruction",
      provenance: "broker", coverage: "partial" });
    expect(() => sink.record(event)).not.toThrow();
    await sink.flush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(event.eventId.replaceAll("-", ""));
    expect(sink.health().queued).toBe(1);
  } finally { await sink.close(); }
});
