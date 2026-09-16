import { z } from "zod";
import { ResourceDemandSchema } from "./resource-budget.js";

/** The worker selects a broker-installed capability; commands, paths and images are absent. */
export const AuxiliaryProfileRequestSchema = z.object({
  requestId: z.uuid(), attemptId: z.uuid(),
  profile: z.enum(["native", "integration"]),
  recipeId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
}).strict();
export type AuxiliaryProfileRequest = z.infer<typeof AuxiliaryProfileRequestSchema>;

export const NativeToolRecipeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), inputManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  project: z.string().min(1), scheme: z.string().regex(/^[\w.-]+$/), developerDirectory: z.string().startsWith("/"),
  simulatorRuntime: z.string().regex(/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[\d-]+$/),
  simulatorDeviceType: z.string().regex(/^com\.apple\.CoreSimulator\.SimDeviceType\.[\w-]+$/),
  action: z.enum(["build", "test"]), timeoutMs: z.number().int().min(1).max(3600000),
  maxInputBytes: z.number().int().positive().max(1024 ** 3), maxArtifactBytes: z.number().int().positive().max(8 * 1024 ** 3),
  demand: ResourceDemandSchema,
}).strict();
