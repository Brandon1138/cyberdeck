import { z } from "zod";

export const SessionSnapshotParamsSchema = z.object({
  sessionId: z.uuid(),
  /**
   * Last replay revision observed by the caller. Omission preserves the legacy full-snapshot
   * response, while zero asks a cursor-aware broker for its first full snapshot.
   */
  cursor: z.number().int().nonnegative().optional(),
});

export const SessionSnapshotResultSchema = z.union([
  z.object({
    data: z.string(),
    cursor: z.number().int().positive().optional(),
  }),
  z.object({
    cursor: z.number().int().positive(),
    notModified: z.literal(true),
  }),
]);

export type SessionSnapshotParams = z.infer<typeof SessionSnapshotParamsSchema>;
export type SessionSnapshotResult = z.infer<typeof SessionSnapshotResultSchema>;
