import { createHash, randomUUID } from "node:crypto";
import type { ActivityInput } from "../../domain/agent-activity.js";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";

export interface ActivityAttribution {
  runId: string; workerId: string; sessionId: string; generation: number;
  instructionId: string; providerTurnId: string; executionId?: string;
}
export interface NativeActivityFrame {
  kind: "tool.invocation" | "tool.result" | "provider.response" | "capture.gap";
  toolCallId?: string; providerTurnId?: string; occurredAt?: string;
  usage?: ActivityInput["usage"]; gap?: ActivityInput["gap"];
}
export type NativeActivityParser = (frame: unknown) => NativeActivityFrame[];
/** Caller must supply a committed turn binding. No cwd/timestamp-based attribution. */
export async function collectNativeActivity(input: {
  provider: string; sourceId: string; lines: Array<{ offset: number; text: string }>;
  attribution: ActivityAttribution; parse: NativeActivityParser; recorder: AgentActivityPort;
}): Promise<number> {
  let count = 0;
  for (const line of input.lines) {
    if (Buffer.byteLength(line.text) > 1024 * 1024) throw new Error("ACTIVITY_SOURCE_FRAME_LIMIT");
    const sourceHash = createHash("sha256").update(line.text).digest("hex");
    let frames: NativeActivityFrame[];
    try { frames = input.parse(JSON.parse(line.text)); }
    catch { frames = [{ kind: "capture.gap", gap: "unknown-frame" }]; }
    for (const [index, frame] of frames.entries()) {
      const conflict = frame.providerTurnId !== undefined && frame.providerTurnId !== input.attribution.providerTurnId;
      const { occurredAt, providerTurnId: _turn, usage, gap, kind, toolCallId } = frame;
      await input.recorder.append({
        schemaVersion: 1, eventId: randomUUID(),
        sourceKey: `${input.sourceId}:${line.offset}:${index}:${sourceHash}`,
        ...input.attribution, provider: input.provider,
        observedAt: new Date().toISOString(), ...(occurredAt === undefined ? {} : { occurredAt }),
        kind: conflict ? "capture.gap" : kind, provenance: "provider-native", coverage: conflict || kind === "capture.gap" ? "partial" : "complete-for-source",
        operation: kind === "provider.response" ? "agent" : kind === "capture.gap" || conflict ? "capture" : "tool",
        outcome: "observed", payloadRef: `${input.sourceId}#byte=${line.offset}`, sourceHash,
        ...(toolCallId === undefined || conflict ? {} : { toolCallId }),
        ...(usage === undefined || conflict ? {} : { usage }),
        ...(conflict ? { gap: "attribution-conflict" as const } : gap === undefined ? {} : { gap }),
      });
      count += 1;
    }
  }
  return count;
}
export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function nativeTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}
