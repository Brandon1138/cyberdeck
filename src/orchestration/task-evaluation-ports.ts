import { createHash } from "node:crypto";
import type { TaskEvaluationIntent } from "../domain/task-evaluation.js";
export interface EvaluationEvidenceManifest {
  schemaVersion: 1;
  terminalEvent: unknown;
  checks: { id: string; passed: boolean; source: "host-verified"; artifactHash: string }[];
  complete: boolean;
  versions?: { inputHash: string; codeRevision: string; toolVersions: Record<string, string> };
  metadata: { provider?: string; model?: string; effort?: string; image?: string; cli?: string; modelSource: "observed" | "launch" | "unknown" };
}
export const evidenceHash = (manifest: EvaluationEvidenceManifest): string => createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
export interface TaskEvaluationOutboxPort {
  enqueue(intent: TaskEvaluationIntent, manifest: EvaluationEvidenceManifest): string;
  findIntent?(attemptId: string, rubricId: string, rubricVersion: string): TaskEvaluationIntent | undefined;
}
export interface EvaluationReplayCheckpoint { sourceId: string; sequence: number }
export interface EvaluationReplayStorePort extends TaskEvaluationOutboxPort {
  checkpoint(consumer: string): EvaluationReplayCheckpoint | undefined;
  advanceCheckpoint(consumer: string, sourceId: string, expectedSequence: number, sequence: number): void;
  hasTerminalSource(sourceKey: string): boolean;
}
