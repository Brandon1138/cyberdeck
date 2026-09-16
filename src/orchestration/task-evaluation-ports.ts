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
}
