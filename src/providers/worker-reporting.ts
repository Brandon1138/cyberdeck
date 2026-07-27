const GUIDANCE_MARKER = "CYBERDECK WORKER REPORTING";

/** Compact launch guidance shared by every interactive provider worker. */
export function addWorkerReportingGuidance(prompt: string, workerId: string): string {
  if (prompt.includes(GUIDANCE_MARKER)) return prompt;
  return [
    prompt,
    "",
    GUIDANCE_MARKER,
    `Report with: cyberdeck event submit --worker ${workerId} --kind PROGRESS --summary <text> --event-id <stable-id>.`,
    "Use DECISION_REQUEST with --intervention --continuation awaiting-response. Answer delivered checkpoints with kind CHECKPOINT plus --checkpoint-correlation-id.",
    "Codex/Claude workers may use cyberdeck_report_progress, cyberdeck_signal_exception, cyberdeck_signal_risk, cyberdeck_request_decision, and cyberdeck_respond_checkpoint.",
  ].join("\n");
}
