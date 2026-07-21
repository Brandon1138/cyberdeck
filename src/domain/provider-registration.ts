import { z } from "zod";

/**
 * Extensible provider-registration contract.
 *
 * The provider id is an open, runtime-validated lowercase slug rather than a closed union, so the
 * shared control-plane type is never permanently limited to `codex | claude`. Explicit selection is
 * still enforced: an id is only usable once its descriptor has been registered (see
 * {@link validateRegisteredProvider}). The provider identifiers below are canonical product ids,
 * while executable names remain adapter details. The contract carries neutral identity metadata
 * only: no rank, priority, or capability field.
 */
export const ProviderIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "provider id must be a lowercase slug");

export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** Providers Phase 1 already ships. The type stays open; this is a known-good seed, not a ceiling. */
export const BUILTIN_PROVIDER_IDS = ["codex", "claude"] as const;

/**
 * Canonical ids for the adapters planned from B1's observed executables: Cursor Agent (`agent`)
 * and Antigravity (`agy`). They remain unsupported until a concrete adapter registers them.
 */
export const PLANNED_PROVIDER_IDS = ["cursor", "antigravity"] as const;

export const CANONICAL_PROVIDER_IDS = [
  ...BUILTIN_PROVIDER_IDS,
  ...PLANNED_PROVIDER_IDS,
] as const;

export const ProviderDescriptorSchema = z.object({
  id: ProviderIdSchema,
  displayName: z.string().min(1),
});
export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;

/**
 * Registration port frozen by A1 and implemented by A2's control-plane registry. Provider adapters
 * register through this seam; planned ids remain unsupported until that registration occurs.
 */
export interface ProviderRegistry {
  register(descriptor: ProviderDescriptor): void;
  has(id: string): boolean;
  get(id: string): ProviderDescriptor | undefined;
  list(): ProviderDescriptor[];
}

export type ProviderValidation =
  | { ok: true; id: ProviderId }
  | { ok: false; code: "PROVIDER_NOT_REGISTERED" };

/**
 * Preserves explicit selection: an id must be a valid slug and must appear in the set of registered
 * providers. Arbitrary syntactically-valid slugs are rejected until explicitly registered.
 */
export function validateRegisteredProvider(
  id: string,
  registered: Iterable<string>,
): ProviderValidation {
  const parsed = ProviderIdSchema.safeParse(id);
  if (!parsed.success) return { ok: false, code: "PROVIDER_NOT_REGISTERED" };
  for (const known of registered) {
    if (known === parsed.data) return { ok: true, id: parsed.data };
  }
  return { ok: false, code: "PROVIDER_NOT_REGISTERED" };
}
