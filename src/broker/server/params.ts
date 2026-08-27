import { z } from "zod";
import { FleetDetachIdentitySchema } from "../../domain/fleet-preferences.js";
import { CANONICAL_PROVIDER_IDS } from "../../domain/provider-registration.js";
import { StartSessionRequestSchema } from "../../domain/session.js";

/**
 * Wire parameter shapes owned by the RPC surface itself.
 *
 * They sit beside the handlers rather than in a domain module because each one describes exactly
 * one method's params and nothing durable is written from them unvalidated.
 */
export const SessionIdParamsSchema = z.object({ sessionId: z.uuid() });
export const SendParamsSchema = SessionIdParamsSchema.extend({ data: z.string() });
export const SubmitParamsSchema = SessionIdParamsSchema.extend({ message: z.string().min(1) });
export const RenameSessionParamsSchema = SessionIdParamsSchema.extend({ name: z.string().trim().min(1).max(120) });
export const ReorderSessionParamsSchema = SessionIdParamsSchema.extend({ direction: z.enum(["up", "down"]) });
export const StartSessionWithPromptParamsSchema = StartSessionRequestSchema.extend({
  initialPrompt: z.string().trim().min(1),
});
export const AttachParamsSchema = SessionIdParamsSchema.extend({
  detachIdentity: FleetDetachIdentitySchema.optional(),
});
export const FleetReattachParamsSchema = z.object({
  detachIdentity: FleetDetachIdentitySchema,
});
export const ThreadReadParamsSchema = SessionIdParamsSchema.extend({
  afterCursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(1_000).default(200),
});
export const ThreadChangesParamsSchema = z.object({
  afterCursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(2_000).default(500),
});
export const WorkerCapabilitiesParamsSchema = z.object({
  provider: z.enum(CANONICAL_PROVIDER_IDS).optional(),
});
