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
});

/**
 * Who detached, as the wire and the durable log both spell it.
 *
 * One declaration because the server validates an incoming identity and the store writes it: two
 * bounds would let a value the RPC accepted be refused on the way to disk.
 */
export const FleetDetachIdentitySchema = z.string().trim().min(1).max(200);

export type FleetLaunchProfile = z.infer<typeof FleetLaunchProfileSchema>;
export type FleetFolderDisposition = z.infer<typeof FleetFolderDispositionSchema>;
