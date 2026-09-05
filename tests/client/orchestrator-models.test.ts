import { describe, expect, it, vi } from "vitest";
import {
  adoptWorkerModels, createFleetState, renderFleet, transitionFleet, workerModelCatalog,
  type FleetSnapshot, type FleetState,
} from "../../src/client/fleet.js";
import { fleetFrameLayout, readWorkerModels } from "../../src/client/fleet/runtime-frame.js";
import { fallbackWorkerCapabilities, type ResolvedWorkerCapability } from "../../src/orchestration/worker-capabilities.js";

const snapshot: FleetSnapshot = { threads: [] };
const capability: ResolvedWorkerCapability = {
  ...fallbackWorkerCapabilities("test", "codex")[0]!,
  source: "provider-query",
  models: ["gpt-6-astra", "future-codex-model"],
  modelLabels: { "gpt-6-astra": "GPT-6-Astra" },
  modelEfforts: { "gpt-6-astra": ["low", "high"], "future-codex-model": ["medium"] },
};
const models = (overrides: Partial<ResolvedWorkerCapability> = {}) => workerModelCatalog([], [{ ...capability, ...overrides }]);
const key = (state: FleetState, input: string) => transitionFleet(state, snapshot, input, 0);
const initial = () => ({ ...createFleetState(snapshot, "/repo"), workerModels: models() });

describe("Codex orchestrator discovery in Fleet", () => {
  it("reads separate worker and first-party orchestrator catalogs", async () => {
    const request = vi.fn(async (method: string) => method === "worker.capabilities"
      ? [{ ...capability, models: ["custom-provider-model"] }]
      : [capability]);
    const catalog = await readWorkerModels({ request } as never);
    expect(request).toHaveBeenCalledWith("orchestrator.capabilities", {});
    expect(catalog.choices.map(({ model }) => model)).toEqual(["custom-provider-model"]);
    expect(catalog.orchestratorChoices.map(({ model }) => model)).toContain("gpt-6-astra");
    expect(catalog.orchestratorChoices.map(({ model }) => model)).not.toContain("custom-provider-model");
  });

  it("never substitutes worker-context models when orchestrator discovery fails", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "orchestrator.capabilities") throw new Error("orchestrator catalog unavailable");
      return [{ ...capability, models: ["custom-provider-model"] }];
    });
    const catalog = await readWorkerModels({ request } as never);
    expect(catalog.choices.map(({ model }) => model)).toEqual(["custom-provider-model"]);
    expect(catalog.orchestratorChoices.map(({ model }) => model)).not.toContain("custom-provider-model");
    expect(catalog.orchestratorChoices[0]!.provider.fallbackReason).toContain("orchestrator catalog unavailable");
  });

  it("refreshes on open and offers provider labels and only the selected model's efforts", () => {
    const opened = key(initial(), "ctrl+o");
    expect(opened.action).toEqual({ type: "worker-capabilities" });
    const rendered = renderFleet(snapshot, opened.state, { color: false, width: 120, height: 40 });
    expect(rendered).toContain("GPT-6-Astra");
    expect(rendered).not.toContain("Codex Sol");
    expect(rendered).not.toContain("stored list");
    const effort = key(opened.state, "enter").state;
    const efforts = renderFleet(snapshot, effort, { color: false, width: 120, height: 30 });
    expect(efforts).toContain("Provider managed");
    expect(efforts).toContain("low");
    expect(efforts).toContain("high");
    expect(efforts).not.toContain("ultra");
    const high = key(key(effort, "down").state, "down").state;
    expect(key(high, "enter").action).toMatchObject({
      type: "create-orchestrator", request: { provider: "codex", model: "gpt-6-astra", effort: "high" },
    });
  });

  it("launches a future model verbatim with provider-managed effort", () => {
    const opened = key(initial(), "ctrl+o").state;
    const selected = key(opened, "down").state;
    const action = key(key(selected, "enter").state, "enter").action;
    expect(action).toMatchObject({ type: "create-orchestrator", request: { model: "future-codex-model" } });
    if (action?.type !== "create-orchestrator") throw new Error("Expected creation");
    expect(action.request).not.toHaveProperty("effort");
  });

  it("offers only provider-managed effort when the discovered range is empty", () => {
    const state = { ...initial(), workerModels: models({ modelEfforts: { "gpt-6-astra": [] } }) };
    expect(state.workerModels.orchestratorChoices[0]!.provider.efforts).toEqual(["native-default"]);
    const effort = key(key(state, "ctrl+o").state, "enter").state;
    const action = key(key(effort, "down").state, "enter").action;
    expect(action).toMatchObject({ type: "create-orchestrator", request: { model: "gpt-6-astra" } });
    if (action?.type !== "create-orchestrator") throw new Error("Expected creation");
    expect(action.request).not.toHaveProperty("effort");
  });

  it("retains model and effort identity when discovery reorders both", () => {
    const opened = key(initial(), "ctrl+o").state;
    const selected = key(key(key(opened, "enter").state, "down").state, "down").state;
    const updated = adoptWorkerModels(selected, models({
      models: ["future-codex-model", "gpt-6-astra"],
      modelEfforts: { "gpt-6-astra": ["high"] },
    }));
    expect(updated.orchestratorPicker).toEqual({ step: "effort", modelIndex: 1, effortIndex: 1 });
    expect(key(updated, "enter").action).toMatchObject({ request: { model: "gpt-6-astra", effort: "high" } });
    const target = adoptWorkerModels(opened, models({ models: ["future-codex-model", "gpt-6-astra"] }));
    expect(target.orchestratorPicker).toMatchObject({ focus: { kind: "profile", modelIndex: 1 } });
  });

  it("requires selection again when a model or effort disappears", () => {
    const opened = key(initial(), "ctrl+o").state;
    const selected = key(key(opened, "enter").state, "down").state;
    for (const refreshed of [models({ models: ["future-codex-model"] }), models({ modelEfforts: { "gpt-6-astra": ["high"] } })]) {
      const updated = adoptWorkerModels(selected, refreshed);
      expect(updated.orchestratorPicker?.step).toBe("target");
      expect(updated.notice).toContain("no longer listed");
      expect(key(updated, "enter").action).toBeUndefined();
    }
  });

  it("labels unavailable discovery and keeps existing sessions focused during refresh", () => {
    const opened = key(initial(), "ctrl+o").state;
    const fallback = adoptWorkerModels(opened, workerModelCatalog([], fallbackWorkerCapabilities("CLI timed out")));
    expect(renderFleet(snapshot, fallback, { color: false, width: 140, height: 40 }))
      .toContain("Codex models are a stored list — CLI timed out");
    const existing: FleetState = { ...opened, orchestratorPicker: { step: "target", focus: { kind: "existing", sessionId: "existing-orc" } } };
    expect(adoptWorkerModels(existing, models({ models: ["future-codex-model"] })).orchestratorPicker)
      .toEqual(existing.orchestratorPicker);
  });

  it("updates frame topology when the discovered choices change", () => {
    const opened = key(initial(), "ctrl+o").state;
    const options = { color: false, width: 100, height: 30, now: 0, home: "/", pullRequests: new Map(), background: undefined };
    const before = fleetFrameLayout(snapshot, opened, options);
    const after = fleetFrameLayout(snapshot, adoptWorkerModels(opened, models({ models: ["future-codex-model"] })), options);
    expect(after.topology).not.toBe(before.topology);
  });
});
