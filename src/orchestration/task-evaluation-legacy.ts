import { createHash } from "node:crypto";
import type { AgentActivity } from "../domain/agent-activity.js";

export interface LegacyInstructionSnapshot {
  id: string; status: string; updatedAt: string;
  attemptGeneration?: number | undefined; terminalActivity?: unknown;
  targetSessionId?: string;
}
/** A snapshot disposition is not an attempt: historical attempt multiplicity and generation
 * are unknown. It must never enter evaluator claims or model-quality comparisons. */
export interface LegacyEvaluationDisposition {
  sourceKey: string; snapshotHash: string; disposition: "unverified";
  reason: "legacy-terminal-attempt-identity-unavailable";
}
export interface LegacyEvaluationMigration {
  schemaVersion: 1; sourceId: string; snapshotHash: string; snapshots: number;
  activity?: { sourceId: string; throughSequence: number; events: number; snapshotHash: string };
}
export interface LegacyActivitySnapshot { sourceId: string; throughSequence: number; events: Iterable<AgentActivity> }
export interface LegacyActivityCoveragePort { hasLegacyTerminalActivity(sourceId: string, event: AgentActivity): boolean }
export interface LegacyEvaluationCoveragePort {
  hasLegacyTerminalSnapshot(record: LegacyInstructionSnapshot): boolean;
}
export function terminalInstructionSource(record: LegacyInstructionSnapshot): string {
  return `instruction:${record.id}:${record.status}:${record.updatedAt}`;
}
/** Hash all canonical snapshot fields without persisting instruction text or inventing metadata.
 * Object order is irrelevant; adding/changing any recorded value removes the exemption. */
export function legacySnapshotHash(record: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(record))).digest("hex");
}
