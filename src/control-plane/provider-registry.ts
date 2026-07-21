import {
  BUILTIN_PROVIDER_IDS,
  ProviderDescriptorSchema,
  type ProviderDescriptor,
  type ProviderRegistry,
} from "../domain/provider-registration.js";

/**
 * A minimal concrete {@link ProviderRegistry} the control plane can run against. A1 froze the
 * registration contract but deliberately left the concrete registry (and the canonical Cursor /
 * Antigravity identifiers) to Agent B. This Phase 2 default seeds only the Phase 1 built-ins so the
 * control plane can enforce unsupported-until-registered behavior today; Agent B registers further
 * providers through {@link register} without changing the control plane.
 */
export class InMemoryProviderRegistry implements ProviderRegistry {
  private readonly byId = new Map<string, ProviderDescriptor>();

  constructor(seed: readonly ProviderDescriptor[] = []) {
    for (const descriptor of seed) this.register(descriptor);
  }

  register(descriptor: ProviderDescriptor): void {
    const parsed = ProviderDescriptorSchema.parse(descriptor);
    this.byId.set(parsed.id, parsed);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): ProviderDescriptor | undefined {
    return this.byId.get(id);
  }

  list(): ProviderDescriptor[] {
    return [...this.byId.values()];
  }
}

/** A registry seeded with the Phase 1 built-in providers (`codex`, `claude`). */
export function defaultProviderRegistry(): InMemoryProviderRegistry {
  return new InMemoryProviderRegistry(
    BUILTIN_PROVIDER_IDS.map((id) => ({ id, displayName: id })),
  );
}
