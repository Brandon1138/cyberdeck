const GUIDANCE_MARKER = "CYBERDECK WORKER REPORTING";

/** Compact launch guidance shared by every interactive provider worker. */
export function addWorkerReportingGuidance(prompt: string, workerId: string, container = false): string {
  if (prompt.includes(GUIDANCE_MARKER)) return prompt;
  return [
    prompt,
    "",
    GUIDANCE_MARKER,
    container
      ? `Report with the available Cyberdeck MCP tools, or send JSON on stdin to node /opt/cyberdeck/report.mjs with workerId=${workerId}, kind=PROGRESS, summary, and a stable eventId. The host cyberdeck CLI is not installed in this guest.`
      : `Report with: cyberdeck event submit --worker ${workerId} --kind PROGRESS --summary <text> --event-id <stable-id>.`,
    container
      ? "Use DECISION_REQUEST with interventionRequired=true and continuation=awaiting-response for operator boundaries. Answer delivered checkpoints with kind=CHECKPOINT and checkpointCorrelationId."
      : "Use DECISION_REQUEST with --intervention --continuation awaiting-response. Answer delivered checkpoints with kind CHECKPOINT plus --checkpoint-correlation-id.",
    "Codex/Claude workers may use cyberdeck_report_progress, cyberdeck_signal_exception, cyberdeck_signal_risk, cyberdeck_request_decision, and cyberdeck_respond_checkpoint.",
  ].join("\n");
}
