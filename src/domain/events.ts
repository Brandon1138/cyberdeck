import { z } from "zod";

export const BrokerEventTypeSchema = z.enum([
  "broker.started",
  "broker.shutdown",
  "session.created",
  "session.attached",
  "session.detached",
  "session.input",
  "session.exited",
  "session.stopped",
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
