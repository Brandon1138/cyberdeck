import { z } from "zod";
import { SessionRecordSchema, type SessionRecord } from "./session.js";

/** Private broker input, never a public runtime, launch spec, or serialized authority callback. */
export const SessionLaunchIntentSchema = z.object({
  record: SessionRecordSchema,
  requestId: z.uuid(),
  initialPrompt: z.string().max(1024 * 1024).optional(),
  phase: z.enum(["preparing", "ready", "launching", "terminal"]),
  terminalAt: z.iso.datetime().optional(),
  terminalFromPhase: z.enum(["preparing", "ready", "launching"]).optional(),
  outcome: z.enum(["launched", "cancelled", "interrupted", "failed"]).optional(),
}).strict().superRefine((intent, ctx) => {
  if ((intent.phase === "terminal") !== (intent.terminalAt !== undefined && intent.terminalFromPhase !== undefined && intent.outcome !== undefined))
    ctx.addIssue({ code: "custom", message: "Terminal launch requires immutable disposition provenance" });
});
export type SessionLaunchIntent = Omit<z.infer<typeof SessionLaunchIntentSchema>, "record"> & { record: SessionRecord };
export interface SessionLaunchIntentPort {
  version(): number;
  list(): SessionLaunchIntent[];
  get(sessionId: string): SessionLaunchIntent | undefined;
  ackTerminal(sessionId: string, requestId: string, terminalAt: string): Promise<void>;
  put(intent: SessionLaunchIntent, expectedPhase?: SessionLaunchIntent["phase"]): Promise<void>;
}
