import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentActivitySchema, type AgentActivity } from "../domain/agent-activity.js";
const operationNames = ["gen_ai.invoke_agent", "gen_ai.execute_tool", "cyberdeck.instruction", "cyberdeck.lifecycle", "cyberdeck.control", "cyberdeck.capture", "cyberdeck.snapshot", "cyberdeck.evaluation"] as const;
export const RemoteActivitySchema = z.object({
  eventId: z.uuid(), runId: z.uuid(), workerId: z.uuid(), sessionId: z.uuid(), instructionId: z.uuid().optional(), executionId: z.uuid().optional(),
  parentEventId: z.uuid().optional(), causationId: z.uuid().optional(),
  toolCallId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  operation: z.enum(operationNames), provenance: AgentActivitySchema.shape.provenance, coverage: AgentActivitySchema.shape.coverage,
  outcome: AgentActivitySchema.shape.outcome, generation: z.number().int().positive().optional(),
  provider: z.enum(["claude", "codex", "cursor", "antigravity", "scripted", "unknown"]),
}).strict();
export type RemoteActivity = z.infer<typeof RemoteActivitySchema>;
export function projectActivity(event: AgentActivity): RemoteActivity {
  return RemoteActivitySchema.parse({
    eventId: event.eventId, runId: event.runId, workerId: event.workerId, sessionId: event.sessionId,
    ...(event.instructionId === undefined ? {} : { instructionId: event.instructionId }),
    ...(event.parentEventId === undefined ? {} : { parentEventId: event.parentEventId }),
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    ...(event.toolCallId === undefined ? {} : { toolCallId: createHash("sha256").update(`${event.provider}:${event.sessionId}:${event.toolCallId}`).digest("hex") }),
    ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
    ...(event.generation === undefined ? {} : { generation: event.generation }),
    operation: event.operation === "agent" ? "gen_ai.invoke_agent" : event.operation === "tool" ? "gen_ai.execute_tool" : `cyberdeck.${event.operation}`,
    provenance: event.provenance, coverage: event.coverage, outcome: event.outcome,
    provider: ["claude", "codex", "cursor", "antigravity", "scripted"].includes(event.provider ?? "") ? event.provider : "unknown",
  });
}
export function correlationIds(event: RemoteActivity): { traceId: string; spanId: string } {
  // Short event segments, durably reproducible IDs. The run ID links segments across restarts.
  return { traceId: createHash("sha256").update(event.instructionId ?? event.eventId).digest("hex").slice(0, 32),
    spanId: createHash("sha256").update(`span:${event.eventId}`).digest("hex").slice(0, 16) };
}
/** Closed serialization boundary: raw SDK scopes/envelopes are never forwarded. */
export function serializeActivityEnvelope(event: RemoteActivity, timestamps: { start: number; end: number }): string {
  const projection = RemoteActivitySchema.parse(event), ids = correlationIds(projection);
  if (!Number.isFinite(timestamps.start) || !Number.isFinite(timestamps.end) || timestamps.end < timestamps.start) throw new Error("TELEMETRY_TIMING_INVALID");
  const tags = Object.fromEntries(Object.entries(projection).filter(([key]) => !["operation", "eventId"].includes(key)).map(([key, value]) => [`cyberdeck.${key}`, String(value)]));
  return [JSON.stringify({ event_id: projection.eventId.replaceAll("-", "") }),
    JSON.stringify({ type: "transaction", content_type: "application/json" }),
    JSON.stringify({ event_id: projection.eventId.replaceAll("-", ""), type: "transaction", platform: "node", transaction: projection.operation,
      start_timestamp: timestamps.start, timestamp: timestamps.end, contexts: { trace: { trace_id: ids.traceId, span_id: ids.spanId, op: projection.operation,
        ...(projection.parentEventId === undefined ? {} : { parent_span_id: createHash("sha256").update(`span:${projection.parentEventId}`).digest("hex").slice(0, 16) }) } },
      tags: { ...tags, "cyberdeck.timing": "observation-marker" }, spans: [], measurements: {} })].join("\n");
}

/** Scrub the SDK's complete envelope, including ambient scope data, before transport serialization. */
export function sanitizeSentryEnvelope(raw: unknown): string | undefined {
  if (!Array.isArray(raw) || !Array.isArray(raw[1])) return undefined;
  for (const item of raw[1]) {
    if (!Array.isArray(item) || item[0]?.type !== "transaction") continue;
    const payload = item[1];
    const encoded = payload?.contexts?.trace?.data?.["cyberdeck.projection"];
    if (typeof encoded !== "string") continue;
    let event: RemoteActivity;
    try { event = RemoteActivitySchema.parse(JSON.parse(encoded)); } catch { continue; }
    const observed = Number(payload.start_timestamp);
    if (!Number.isFinite(observed)) continue;
    // These are observation markers, not invented provider HTTP/tool duration spans.
    return serializeActivityEnvelope(event, { start: observed, end: observed });
  }
  return undefined;
}
