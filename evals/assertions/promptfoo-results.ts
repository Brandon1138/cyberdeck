import { z } from "zod";
import { suiteFailures } from "./invariants.js";
import { EvalModeSchema, type EvalMode } from "./evidence.js";
export function validatePromptfooResults(raw: unknown, mode: EvalMode = "offline-scripted", repetitions = 1): string[] {
  if (!EvalModeSchema.safeParse(mode).success) return ["promptfoo-mode-invalid"];
  const parsed = z.object({ results: z.object({ stats: z.object({ successes: z.number().int(), failures: z.literal(0), errors: z.literal(0) }),
    results: z.array(z.object({ success: z.literal(true), response: z.object({ output: z.string(), error: z.never().optional() }) })).min(1) }) }).safeParse(raw);
  if (!parsed.success) return ["promptfoo-results-invalid"];
  if (parsed.data.results.stats.successes !== parsed.data.results.results.length) return ["promptfoo-count-mismatch"];
  try { return suiteFailures(parsed.data.results.results.map((row) => JSON.parse(row.response.output)), mode, repetitions); }
  catch { return ["promptfoo-evidence-invalid"]; }
}
