import { readFile } from "node:fs/promises";
import { z } from "zod";
/**
 * A live run spends money and runs a real model inside real containers. Nothing here has a
 * default that could do that by accident: every value is the operator's, read from one file
 * named by `CYBERDECK_LIVE_EVAL_CONFIG`, and the ceiling is recorded in every evidence row.
 */
export const LiveEvalConfigSchema = z.object({
  provider: z.enum(["claude", "codex"]), model: z.string().min(1), effort: z.string().min(1).optional(),
  credentialFile: z.string().startsWith("/"), authorizedCeilingUsd: z.number().positive(),
  repetitions: z.number().int().min(1).max(10).default(3),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  cpus: z.number().positive().default(2), memoryBytes: z.number().int().positive().default(4 * 1024 ** 3),
  attemptTimeoutMinutes: z.number().int().min(1).max(1440).default(30),
  scenarioTimeoutMs: z.number().int().min(10_000).max(3_600_000).default(600_000),
}).strict();
export type LiveEvalConfig = z.infer<typeof LiveEvalConfigSchema>;
export async function loadLiveEvalConfig(path = process.env.CYBERDECK_LIVE_EVAL_CONFIG): Promise<LiveEvalConfig> {
  if (!path) throw new Error("LIVE_EVAL_REQUIRES_AUTHORIZED_CONFIG_AND_NATIVE_CAPTURE");
  return LiveEvalConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
