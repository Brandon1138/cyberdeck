import { z } from "zod";

export const PhaseOneConfigSchema = z.object({
  maxConcurrentSessions: z.number().int().positive().default(4),
  maxDelegationDepth: z.literal(1).default(1),
  replayBytes: z.number().int().positive().default(128 * 1024),
});

export type PhaseOneConfig = z.infer<typeof PhaseOneConfigSchema>;
