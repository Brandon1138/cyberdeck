import { z } from "zod";
import { StrigoiAdoptionSchema, StrigoiArtifactRefSchema, type StrigoiArtifactRef } from "./strigoi.js";

export const RECOVERY_SOURCE_MAP = "STRIGOI_RECOVERY_SOURCE_IDS ";
/** Oversized inventories retain the original paged/full-ID receipt contract. */
export function compactRecoverySourceMap(ids: string[]): string | undefined {
  const text = JSON.stringify(ids);
  return Buffer.byteLength(text) <= 64 * 1024 ? text : undefined;
}
const indices = z.array(z.number().int().nonnegative()).refine(ids => new Set(ids).size === ids.length);
const CompactAdoptionSchema = StrigoiAdoptionSchema.omit({ handledSourceIds: true }).extend({ handledSourceIndices: indices }).strict();
const SourceMapSchema = z.array(z.string().regex(/^[a-f0-9]{64}$/)).refine(ids => new Set(ids).size === ids.length);

/** Resolve only against the broker's durable original intent, never a model-supplied map.
 * The normal identity/hash/coverage validation still runs on the expanded receipt. */
export async function parseRecoveryAdoption(value: unknown, intent: string, resolveMap?: (ref: StrigoiArtifactRef) => Promise<unknown>) {
  const legacy = StrigoiAdoptionSchema.safeParse(value);
  if (legacy.success) return legacy.data;
  const compact = CompactAdoptionSchema.safeParse(value);
  if (!compact.success || !compact.data.recovery) return undefined;
  const maps = intent.split("\n").filter(line => line.startsWith(RECOVERY_SOURCE_MAP));
  if (maps.length !== 1) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(maps[0]!.slice(RECOVERY_SOURCE_MAP.length)); } catch { return undefined; }
  const ref = StrigoiArtifactRefSchema.safeParse(parsed);
  if (ref.success) {
    if (!resolveMap) return undefined;
    parsed = await resolveMap(ref.data);
  }
  const mapping = SourceMapSchema.safeParse(parsed);
  if (!mapping.success || compact.data.handledSourceIndices.some(i => i >= mapping.data.length)) return undefined;
  const { handledSourceIndices, ...receipt } = compact.data;
  return StrigoiAdoptionSchema.parse({ ...receipt, handledSourceIds: handledSourceIndices.map(i => mapping.data[i]!) });
}
