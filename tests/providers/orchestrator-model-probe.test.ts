import { describe, expect, it, vi } from "vitest";
import { WorkerCapabilityCatalog } from "../../src/orchestration/worker-capability-catalog.js";
import { OrchestratorModelProbe } from "../../src/providers/orchestrator-model-probe.js";
import type { ProviderModelProbe } from "../../src/orchestration/worker-capability-catalog.js";

function probes(): { codex: ProviderModelProbe; cursor: ProviderModelProbe; probe: OrchestratorModelProbe } {
  const codex = { list: vi.fn(async () => ({ models: [{ id: "gpt-6-astra", efforts: ["high" as const] }] })) };
  const cursor = { list: vi.fn(async () => ({ unavailable: "agent models failed: timeout" })) };
  return { codex, cursor, probe: new OrchestratorModelProbe(codex, cursor) };
}

describe("orchestrator model probe", () => {
  it("does not spawn a listing for Claude or Antigravity", async () => {
    const { codex, cursor, probe } = probes();
    await expect(probe.list("claude")).resolves.toEqual({ unavailable: "claude has no orchestrator model discovery" });
    await expect(probe.list("antigravity")).resolves.toEqual({
      unavailable: "antigravity has no orchestrator model discovery",
    });
    expect(codex.list).not.toHaveBeenCalled();
    expect(cursor.list).not.toHaveBeenCalled();
  });

  it("reads Cursor from its own probe and still returns the Codex listing when Cursor fails", async () => {
    const { codex, cursor, probe } = probes();
    const resolved = await new WorkerCapabilityCatalog({ probe }).resolve();
    expect(codex.list).toHaveBeenCalledExactlyOnceWith("codex");
    expect(cursor.list).toHaveBeenCalledExactlyOnceWith("cursor");
    expect(resolved.find((entry) => entry.provider === "codex")).toMatchObject({
      source: "provider-query",
      models: ["gpt-6-astra"],
    });
    expect(resolved.find((entry) => entry.provider === "cursor")).toMatchObject({
      source: "fallback-catalog",
      fallbackReason: "agent models failed: timeout",
    });
  });

  it("passes a Cursor listing through without asking Codex", async () => {
    const codex = { list: vi.fn() };
    const cursor = {
      list: vi.fn(async () => ({ models: [{ id: "cursor-grok-4.7-xhigh", label: "Grok 4.7 Extra High" }] })),
    };
    const probe = new OrchestratorModelProbe(codex, cursor);
    await expect(probe.list("cursor")).resolves.toEqual({
      models: [{ id: "cursor-grok-4.7-xhigh", label: "Grok 4.7 Extra High" }],
    });
    expect(codex.list).not.toHaveBeenCalled();
  });
});
