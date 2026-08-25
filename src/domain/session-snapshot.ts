import { z } from "zod";

/**
 * One full replay snapshot, requested by session alone.
 *
 * There is deliberately no cursor and no not-modified answer here. A cursor-shaped protocol
 * existed to let Fleet poll every thread's replay cheaply, and it could not: any session with a
 * working provider invalidated on every output chunk, so each 100ms poll re-shipped the entire
 * replay buffer anyway. The thread list now renders from session records, and a snapshot is
 * requested only when something actually wants the raw bytes — attaching, or the CLI's one-shot
 * snapshot command — which is always a full read.
 */
export const SessionSnapshotParamsSchema = z.strictObject({
  sessionId: z.uuid(),
});

export const SessionSnapshotResultSchema = z.object({
  data: z.string(),
});

export type SessionSnapshotParams = z.infer<typeof SessionSnapshotParamsSchema>;
export type SessionSnapshotResult = z.infer<typeof SessionSnapshotResultSchema>;
