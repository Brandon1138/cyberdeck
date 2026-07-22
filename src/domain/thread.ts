import { z } from "zod";

export const ThreadEventKindSchema = z.enum([
  "prompt",
  "output",
  "instruction",
  "lifecycle",
]);

export const ThreadEventSourceSchema = z.enum([
  "human",
  "provider",
  "orchestrator",
  "worker",
  "broker",
]);

export const ThreadEventSchema = z.object({
  id: z.uuid(),
  cursor: z.number().int().positive(),
  sessionId: z.uuid(),
  occurredAt: z.iso.datetime(),
  kind: ThreadEventKindSchema,
  source: ThreadEventSourceSchema,
  text: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const ThreadReadResultSchema = z.object({
  events: z.array(ThreadEventSchema),
  nextCursor: z.number().int().nonnegative(),
});

export type ThreadEvent = z.infer<typeof ThreadEventSchema>;
export type ThreadEventKind = z.infer<typeof ThreadEventKindSchema>;
export type ThreadEventSource = z.infer<typeof ThreadEventSourceSchema>;
export type ThreadReadResult = z.infer<typeof ThreadReadResultSchema>;

