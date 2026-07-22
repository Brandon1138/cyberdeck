import { z } from "zod";
import { BrokerEventSchema } from "../domain/events.js";

export const RequestFrameSchema = z.object({
  type: z.literal("request"),
  id: z.number().int().nonnegative(),
  method: z.string().min(1),
  params: z.unknown(),
});

export const InputFrameSchema = z.object({
  type: z.literal("input"),
  sessionId: z.uuid(),
  data: z.string(),
});

export const ResizeFrameSchema = z.object({
  type: z.literal("resize"),
  sessionId: z.uuid(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const DetachFrameSchema = z.object({
  type: z.literal("detach"),
  sessionId: z.uuid(),
});

export const ClientFrameSchema = z.discriminatedUnion("type", [
  RequestFrameSchema,
  InputFrameSchema,
  ResizeFrameSchema,
  DetachFrameSchema,
]);

const ResponseSuccessFrameSchema = z.object({
  type: z.literal("response"),
  id: z.number().int().nonnegative(),
  ok: z.literal(true),
  result: z.unknown(),
});

const ResponseErrorFrameSchema = z.object({
  type: z.literal("response"),
  id: z.number().int().nonnegative(),
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
  }),
});

export const ResponseFrameSchema = z.union([
  ResponseSuccessFrameSchema,
  ResponseErrorFrameSchema,
]);

export const OutputFrameSchema = z.object({
  type: z.literal("output"),
  sessionId: z.uuid(),
  data: z.string(),
});

export const SessionEndedFrameSchema = z.object({
  type: z.literal("session-ended"),
  sessionId: z.uuid(),
  exitCode: z.number().int(),
});

export const EventFrameSchema = z.object({
  type: z.literal("event"),
  event: BrokerEventSchema,
});

export const ProtocolErrorFrameSchema = z.object({
  type: z.literal("protocol-error"),
  code: z.literal("INVALID_FRAME"),
  message: z.string(),
});

export const ServerFrameSchema = z.union([
  ResponseFrameSchema,
  OutputFrameSchema,
  SessionEndedFrameSchema,
  EventFrameSchema,
  ProtocolErrorFrameSchema,
]);

export const WireFrameSchema = z.union([ClientFrameSchema, ServerFrameSchema]);

export type RequestFrame = z.infer<typeof RequestFrameSchema>;
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ResponseFrame = z.infer<typeof ResponseFrameSchema>;
export type OutputFrame = z.infer<typeof OutputFrameSchema>;
export type SessionEndedFrame = z.infer<typeof SessionEndedFrameSchema>;
export type ProtocolErrorFrame = z.infer<typeof ProtocolErrorFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type WireFrame = z.infer<typeof WireFrameSchema>;
