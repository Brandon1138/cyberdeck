import { homedir } from "node:os";
import { join } from "node:path";
import { readCodexRemoteIdle } from "../providers/codex/remote-thread-readiness.js";
import type { CaptureWorkerTurns, WorkerTurnObservation } from "../orchestration/session/worker-turn-ports.js";
import type { CodexConversationBindingStore } from "./codex-conversation-bindings.js";

/** A runtime idle read cannot replace transcript identity or newer native work. */
export async function refreshCodexNativeReadiness(
  input: CaptureWorkerTurns, prior: WorkerTurnObservation, bindings: CodexConversationBindingStore,
  observe: (input: CaptureWorkerTurns) => Promise<WorkerTurnObservation>, homeDirectory?: string,
): Promise<WorkerTurnObservation | undefined> {
  if (input.provider !== "codex" || !input.codexMarkerRequired || !prior.nativeSourceAvailable
    || prior.nativeSourceStatus !== "available" || prior.nativeSourceReason !== undefined
    || prior.nativeActivity !== "idle" || !prior.nativeSessionId || !prior.nativeActivityEvidence) return;
  const binding = await bindings.read(input.sessionId);
  if (!binding || binding.nativeSessionId !== prior.nativeSessionId || binding.cwd !== input.cwd) return;
  const idle = await readCodexRemoteIdle({
    homeDirectory: homeDirectory ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "cyberdeck-orchestrator"),
    nativeSessionId: binding.nativeSessionId, cwd: binding.cwd, transcriptPath: binding.transcriptPath,
  });
  if (!idle) return;
  const observedAt = new Date().toISOString();
  const current = await observe(input);
  const rebound = await bindings.read(input.sessionId);
  if (!rebound || JSON.stringify(rebound) !== JSON.stringify(binding) || current.nativeSourceStatus !== "available"
    || !current.nativeSourceAvailable || current.nativeSourceReason !== undefined || current.nativeActivity !== "idle"
    || current.nativeSessionId !== prior.nativeSessionId || current.activityVersion !== prior.activityVersion
    || current.nativeActivityEvidence?.id !== prior.nativeActivityEvidence.id) return;
  return { ...current, nativeReadiness: { nativeSessionId: current.nativeSessionId, observedAt } };
}
