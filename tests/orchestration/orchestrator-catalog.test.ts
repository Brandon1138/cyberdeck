import { describe, expect, it } from "vitest";
import { orchestratorCatalog } from "../../src/orchestration/orchestrator-catalog.js";
import { fallbackWorkerCapabilities, type ResolvedWorkerCapability } from "../../src/orchestration/worker-capabilities.js";

const STORED_CURSOR = [
  "claude-fable-5-thinking-high",
  "gpt-5.6-sol-high",
  "claude-opus-5-thinking-high",
  "kimi-k3-max",
];

function cursorQuery(models: readonly string[], modelLabels?: Record<string, string>): ResolvedWorkerCapability {
  return {
    ...fallbackWorkerCapabilities("unused", "cursor")[0]!,
    source: "provider-query",
    models: [...models],
    ...(modelLabels === undefined ? {} : { modelLabels }),
    observedAt: "2026-11-24T00:00:00.000Z",
  };
}

describe("orchestrator catalog cursor discovery", () => {
  it("replaces the stored Cursor slugs from a provider query and keeps native-default only", () => {
    const cursor = orchestratorCatalog([
      cursorQuery(["cursor-grok-4.7-xhigh"], { "cursor-grok-4.7-xhigh": "Grok 4.7 Extra High" }),
    ]).find((entry) => entry.provider === "cursor");
    expect(cursor).toMatchObject({
      models: ["cursor-grok-4.7-xhigh"],
      modelLabels: { "cursor-grok-4.7-xhigh": "Grok 4.7 Extra High" },
      efforts: ["native-default"],
    });
    expect(cursor?.modelEfforts).toBeUndefined();
    expect(cursor?.fallbackReason).toBeUndefined();
  });

  it("keeps the four stored slugs when Cursor discovery falls back, ignoring the worker snapshot", () => {
    const fallback = fallbackWorkerCapabilities("agent models failed: timeout", "cursor")[0]!;
    expect(fallback.models).toContain("composer-2.5");
    const cursor = orchestratorCatalog([fallback]).find((entry) => entry.provider === "cursor");
    expect(cursor?.models).toEqual(STORED_CURSOR);
    expect(cursor?.fallbackReason).toBe("agent models failed: timeout");
    expect(cursor?.efforts).toEqual(["native-default"]);
  });

  it("leaves the stored Cursor slugs unlabeled when no Cursor capability was supplied", () => {
    const cursor = orchestratorCatalog([]).find((entry) => entry.provider === "cursor");
    expect(cursor?.models).toEqual(STORED_CURSOR);
    expect(cursor?.fallbackReason).toBeUndefined();
  });
});
