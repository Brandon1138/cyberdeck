import { describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITY_ROWS,
  PROVIDER_EXECUTABLES,
  capabilityRowsFor,
  renderCapabilityMatrix,
} from "../../src/client/provider-capability-view.js";
import { ANTIGRAVITY_CAPABILITIES } from "../../src/providers/antigravity/capabilities.js";

describe("provider capability view", () => {
  it("covers exactly the three adapter providers B2-B4 delivered", () => {
    const providers = [...new Set(PROVIDER_CAPABILITY_ROWS.map((row) => row.provider))].sort();
    expect(providers).toEqual(["antigravity", "claude", "cursor"]);
  });

  it("maps each provider to the executable B1 actually observed", () => {
    expect(PROVIDER_EXECUTABLES).toEqual({
      claude: "claude",
      cursor: "agent",
      antigravity: "agy",
    });
  });

  it("derives the antigravity rows from the adapter register rather than copying them", () => {
    const derived = capabilityRowsFor("antigravity");
    expect(derived).toHaveLength(ANTIGRAVITY_CAPABILITIES.length);
    for (const capability of ANTIGRAVITY_CAPABILITIES) {
      const row = derived.find((candidate) => candidate.capability === capability.capability);
      expect(row, `missing row for ${capability.capability}`).toBeDefined();
      expect(row?.reason).toBe(capability.reason);
    }
  });

  it("never promotes an unsupported or live-unverified capability into a proven one", () => {
    for (const capability of ANTIGRAVITY_CAPABILITIES) {
      const row = capabilityRowsFor("antigravity")
        .find((candidate) => candidate.capability === capability.capability);
      if (capability.support === "unsupported") expect(row?.evidence).toBe("unsupported");
      if (capability.support === "live-unverified") expect(row?.evidence).toBe("live-unverified");
    }
  });

  it("records that no provider has a live-proven capability without paid authorization", () => {
    expect(PROVIDER_CAPABILITY_ROWS.some((row) => row.evidence === "live-proven")).toBe(false);
  });

  it("marks automatic model selection and fallback unsupported for every provider", () => {
    for (const provider of ["claude", "cursor", "antigravity"] as const) {
      const rows = capabilityRowsFor(provider);
      const automatic = rows.find((row) => row.capability === "automatic-model-or-agent-selection");
      const fallback = rows.find((row) => row.capability === "routing-fallback-retry");
      expect(automatic?.evidence, `${provider} automatic selection`).toBe("unsupported");
      expect(fallback?.evidence, `${provider} fallback`).toBe("unsupported");
    }
  });

  it("carries no rank, score, priority, or recommendation field", () => {
    for (const row of PROVIDER_CAPABILITY_ROWS) {
      expect(Object.keys(row).sort()).toEqual([
        "capability",
        "evidence",
        "provider",
        "reason",
      ]);
    }
  });

  it("uses no ranking or recommendation language in any reason", () => {
    for (const row of PROVIDER_CAPABILITY_ROWS) {
      expect(row.reason).not.toMatch(/recommend|best|preferred|superior|fastest|rank|instead use/i);
    }
  });

  it("renders a matrix that names every evidence kind it uses", () => {
    const rendered = renderCapabilityMatrix(PROVIDER_CAPABILITY_ROWS);
    const used = new Set(PROVIDER_CAPABILITY_ROWS.map((row) => row.evidence));
    for (const evidence of used) expect(rendered).toContain(evidence);
    expect(rendered).toMatch(/no capability below was proven by a live model call/i);
  });

  it("never renders Fable as an option", () => {
    expect(renderCapabilityMatrix(PROVIDER_CAPABILITY_ROWS)).not.toMatch(/fable/i);
  });
});
