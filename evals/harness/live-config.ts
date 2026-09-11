import { ReasoningEffortSchema } from "../../src/domain/session.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ContainerAuthenticationSchema, authenticationMatchesProvider } from "../../src/domain/container-authentication.js";
/**
 * A live run consumes API credits or subscription allowance inside real containers. Nothing has a
 * default that could do that by accident: every value is the operator's, read from one file
 * named by `CYBERDECK_LIVE_EVAL_CONFIG`. API mode records a ceiling; subscription mode has none.
 */
export const LiveEvalConfigSchema = z.object({
  provider: z.enum(["claude", "codex"]), model: z.string().min(1), effort: ReasoningEffortSchema.optional(),
  credentialFile: z.string().startsWith("/").optional(), authorizedCeilingUsd: z.number().positive().optional(),
  authentication: ContainerAuthenticationSchema.optional(),
  codexWorkspaceIsolation: z.enum(["native", "container"]).default("native"),
  repetitions: z.number().int().min(1).max(10).default(3),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  cpus: z.number().positive().default(2), memoryBytes: z.number().int().positive().default(4 * 1024 ** 3),
  attemptTimeoutMinutes: z.number().int().min(1).max(1440).default(30),
  scenarioTimeoutMs: z.number().int().min(10_000).max(3_600_000).default(600_000),
}).strict().refine((value) => {
  if (value.authentication) return value.credentialFile === undefined && authenticationMatchesProvider(value.provider, value.authentication)
    && (value.authentication.kind === "api-key" ? value.authorizedCeilingUsd !== undefined : value.authorizedCeilingUsd === undefined);
  return value.credentialFile !== undefined && value.authorizedCeilingUsd !== undefined;
}, "select subscription authentication without an API spend ceiling, or an explicit API credential and ceiling");
export type LiveEvalConfig = z.infer<typeof LiveEvalConfigSchema>;
export async function loadLiveEvalConfig(path = process.env.CYBERDECK_LIVE_EVAL_CONFIG): Promise<LiveEvalConfig> {
  if (!path) throw new Error("LIVE_EVAL_REQUIRES_AUTHORIZED_CONFIG_AND_NATIVE_CAPTURE");
  return LiveEvalConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
