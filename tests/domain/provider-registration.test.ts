import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDER_IDS,
  ProviderDescriptorSchema,
  ProviderIdSchema,
  validateRegisteredProvider,
} from "../../src/domain/provider-registration.js";

describe("provider registration contract", () => {
  it("keeps the provider id open beyond the built-ins", () => {
    expect(BUILTIN_PROVIDER_IDS).toEqual(["codex", "claude"]);
    // A future provider id is syntactically valid without reopening this shared type.
    expect(ProviderIdSchema.parse("cursor")).toBe("cursor");
    expect(ProviderIdSchema.parse("antigravity")).toBe("antigravity");
  });

  it("rejects ids that are not lowercase slugs", () => {
    expect(() => ProviderIdSchema.parse("Codex")).toThrow();
    expect(() => ProviderIdSchema.parse("")).toThrow();
    expect(() => ProviderIdSchema.parse("has space")).toThrow();
  });

  it("preserves explicit selection: an unregistered provider is rejected at runtime", () => {
    const registered = ["codex", "claude"];
    expect(validateRegisteredProvider("codex", registered)).toEqual({ ok: true, id: "codex" });
    expect(validateRegisteredProvider("cursor", registered)).toEqual({
      ok: false,
      code: "PROVIDER_NOT_REGISTERED",
    });
  });

  it("describes a provider with neutral metadata only", () => {
    // Neutrality: the schema defines no rank/priority/capability field, so any such key is dropped.
    const parsed = ProviderDescriptorSchema.parse({ id: "codex", displayName: "Codex", rank: 1 });
    expect(parsed).toEqual({ id: "codex", displayName: "Codex" });
    expect("rank" in parsed).toBe(false);
  });
});
