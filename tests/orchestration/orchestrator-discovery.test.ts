import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { OrchestratorManager } from "../../src/orchestration/orchestrator-manager.js";
import { WorkerCapabilityCatalog, parseCodexModelCatalog } from "../../src/orchestration/worker-capability-catalog.js";

function setup(unavailable = false) {
  const models = parseCodexModelCatalog(JSON.stringify({ models: [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] },
    { slug: "future-codex-model", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }] },
    { slug: "internal-model", visibility: "hide" },
  ] }));
  const list = vi.fn(async () => unavailable ? { unavailable: "CLI unavailable" } : { models });
  const catalog = new WorkerCapabilityCatalog({ probe: { list } });
  const start = vi.fn(async (request: Partial<SessionRecord>, _prompt: unknown, activate?: (session: SessionRecord) => Promise<void>) => {
    const session = {
      ...request, id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-09-04T12:00:00Z",
    } as SessionRecord;
    await activate?.(session);
    return session;
  });
  const manager = new OrchestratorManager(
    { start } as never, { put: vi.fn() } as never, undefined, undefined,
    (provider) => catalog.resolve(provider),
  );
  return { manager, start, catalog, list };
}

const request = { provider: "codex" as const, cwd: "/repo", scope: "fleet" as const };

describe("Codex orchestrator launch discovery", () => {
  it.each(["gpt-6-astra", "future-codex-model"])("accepts discovered %s without a static entry", async (model) => {
    const { manager, start, catalog, list } = setup();
    // Fleet and the worker boundary have already read this same catalog instance.
    await catalog.resolve("codex");
    const probes = list.mock.calls.length;
    const result = await manager.create({ ...request, model });
    expect(result.binding).toMatchObject({ provider: "codex", model });
    expect(start.mock.calls[0]![0]).toMatchObject({ provider: "codex", model, kind: "orchestrator" });
    expect(start.mock.calls[0]![0].effort).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(probes);
  });

  it("accepts listed effort and refuses unknown, hidden, removed, or unsupported selections before launch", async () => {
    const { manager, start } = setup();
    for (const selection of [
      { model: "gpt-6-astra", effort: "ultra" as const },
      { model: "future-codex-model", effort: "high" as const },
      { model: "internal-model" }, { model: "unknown" }, { model: "gpt-5.6-sol" },
    ]) {
      await expect(manager.create({ ...request, ...selection }))
        .rejects.toMatchObject({ code: "ORCHESTRATOR_SELECTION_UNSUPPORTED" });
    }
    expect(start).not.toHaveBeenCalled();
    await manager.create({ ...request, model: "gpt-6-astra", effort: "high" });
    expect(start.mock.calls[0]![0]).toMatchObject({ model: "gpt-6-astra", effort: "high" });
  });

  it("uses stored Codex selections on discovery failure and preserves other provider policy", async () => {
    const { manager, start } = setup(true);
    await manager.create({ ...request, model: "gpt-5.6-sol", effort: "high" });
    await expect(manager.create({ ...request, model: "gpt-6-astra" }))
      .rejects.toMatchObject({ code: "ORCHESTRATOR_SELECTION_UNSUPPORTED" });
    await expect(manager.create({ ...request, provider: "antigravity", model: "gpt-5.6-sol" }))
      .rejects.toMatchObject({ code: "ORCHESTRATOR_SELECTION_UNSUPPORTED" });
    expect(start).toHaveBeenCalledOnce();
  });
});
