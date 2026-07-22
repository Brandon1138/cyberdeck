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
  "session.stopped",
  "session.deleted",
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
