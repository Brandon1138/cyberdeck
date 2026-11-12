import { z } from "zod";
import { ProviderIdSchema } from "./provider-registration.js";
import { ReasoningEffortSchema } from "./session.js";

export const FleetLaunchProfileSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  effort: ReasoningEffortSchema.optional(),
  /**
   * Whether workers started in this folder get a worktree Cyberdeck cuts for them. Optional so
   * every profile written before the choice existed replays as what it meant: run in the folder.
   */
  isolation: z.enum(["shared", "worktree"]).optional(),
});

export const FleetFolderDispositionSchema = z.object({
  collapsed: z.boolean(),
  expanded: z.boolean(),
  historyExpanded: z.boolean().optional(),
  /** Live's explicit disclosure, independent of visits to the History tab. */
  liveHistoryExpanded: z.boolean().optional(),
});

export const FleetListViewSchema = z.enum(["live", "workers", "unread", "history"]);
/** Content watermarks, never timestamps of process activity. Null is an honest empty baseline. */
export const FleetReplyWatermarkSchema = z.object({
  seen: z.string().max(600).nullable(),
  latest: z.string().max(600).nullable(),
  canonicalTurns: z.number().int().nonnegative(),
  generation: z.number().int().positive().optional(),
  seenCanonicalTurns: z.number().int().nonnegative().optional(),
  seenGeneration: z.number().int().positive().optional(),
  updatedAt: z.iso.datetime().optional(),
});
export const FleetVisitPreferencesSchema = z.object({
  view: FleetListViewSchema.optional(),
  replies: z.record(z.string(), FleetReplyWatermarkSchema).default({}),
  lifecycle: z.record(z.string(), z.object({
    generation: z.number().int().positive(),
    acknowledgedGeneration: z.number().int().nonnegative(),
    baselineGeneration: z.number().int().nonnegative().optional(),
    presence: z.enum(["present", "absent", "unknown"]).optional(),
    notice: z.object({
      generation: z.number().int().positive(),
      kind: z.enum(["interrupted", "failed", "provider-limit"]),
      occurredAt: z.string().max(64),
    }).optional(),
  })).optional(),
  lifecycleInitialized: z.boolean().optional(),
});
export type FleetListView = z.infer<typeof FleetListViewSchema>;
export type FleetReplyWatermark = z.infer<typeof FleetReplyWatermarkSchema>;
export type FleetVisitPreferences = z.infer<typeof FleetVisitPreferencesSchema>;
export type FleetLifecycleWatermark = NonNullable<FleetVisitPreferences["lifecycle"]>[string];

/**
 * Who detached, as the wire and the durable log both spell it.
 *
 * One declaration because the server validates an incoming identity and the store writes it: two
 * bounds would let a value the RPC accepted be refused on the way to disk.
 */
export const FleetDetachIdentitySchema = z.string().trim().min(1).max(200);

export type FleetLaunchProfile = z.infer<typeof FleetLaunchProfileSchema>;
export type FleetFolderDisposition = z.infer<typeof FleetFolderDispositionSchema>;
