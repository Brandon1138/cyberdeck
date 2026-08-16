import { z } from "zod";

export const BrokerEventTypeSchema = z.enum([
  "broker.started",
  "broker.shutdown",
  "session.created",
  "session.resumed",
  "session.attached",
  "session.detached",
  "session.input",
  "session.exited",
  /** The provider session took an unrecoverable fault while its OS process kept running. */
  "session.errored",
  /**
   * A completed turn was recorded from a terminal scrape because the provider's own transcript did
   * not land within the retry budget. The turn is real; its text is a degraded reading of it.
   */
  "session.turn_scraped",
  /**
   * A completed turn the screen never reported was recovered from the provider's own transcript.
   *
   * The screen path banks a turn when the provider returns to its prompt. A provider that finished
   * and then painted a dialog over the result, or whose last spinner frame was never redrawn, never
   * makes that transition — so the turn happened, the ledger did not know, and every wait on it
   * hung. This says the ledger was corrected and how many turns it was behind.
   */
  "session.turn_reconciled",
  "session.stopped",
  "session.deleted",
  /** Cyberdeck created a worktree for a worker. `data` names the path, branch, base, and repository. */
  "workspace.provisioned",
  "scout.report.captured",
  "scout.budget.exhausted",
  "scout.launch.failed",
  "scout.run.failed",
  "scout.canary.verified",
  "scout.canary.failed",
  "orchestrator.stop.requested",
  "orchestrator.stop.result",
  // Control-plane job/delegation/result/report events. Event `data` carries neutral identifiers and
  // outcome metadata only — never the instruction (prompt) body or any secret.
  "job.submitted",
  "job.dispatched",
  "job.interrupted",
  "job.settled",
  "delegation.created",
  "job.reported",
  "job.report.acknowledged",
  "job.report.failed",
]);

export const BrokerEventSchema = z.object({
  id: z.uuid(),
  type: BrokerEventTypeSchema,
  sessionId: z.uuid().optional(),
  occurredAt: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});

export type BrokerEventType = z.infer<typeof BrokerEventTypeSchema>;
export type BrokerEvent = z.infer<typeof BrokerEventSchema>;
