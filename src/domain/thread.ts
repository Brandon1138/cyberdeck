import { z } from "zod";

export const ThreadEventKindSchema = z.enum([
  "prompt",
  "output",
  "turn",
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
  fragment: z.object({
    eventId: z.uuid(), cursor: z.number().int().positive(),
    byteOffset: z.number().int().nonnegative(), nextByteOffset: z.number().int().positive(),
    totalBytes: z.number().int().positive(), json: z.string(),
  }).optional(),
  continuation: z.object({
    eventId: z.uuid(), cursor: z.number().int().positive(),
    byteOffset: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  }).optional(),
});

export const ThreadPageOptionsSchema = z.object({
  maxBytes: z.number().int().min(1_024).max(64 * 1024).optional(),
  continuation: ThreadReadResultSchema.shape.continuation,
});
export type ThreadPageOptions = z.input<typeof ThreadPageOptionsSchema>;

export type ThreadEvent = z.infer<typeof ThreadEventSchema>;
export type ThreadEventKind = z.infer<typeof ThreadEventKindSchema>;
export type ThreadEventSource = z.infer<typeof ThreadEventSourceSchema>;
export type ThreadReadResult = z.infer<typeof ThreadReadResultSchema>;
