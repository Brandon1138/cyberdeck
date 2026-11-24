import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
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

const cursorListed: ResolvedWorkerCapability = {
  ...fallbackWorkerCapabilities("test", "cursor")[0]!,
  source: "provider-query",
  models: ["cursor-grok-4.7-xhigh", "composer-2.5", "gpt-5.6-sol-high"],
  modelLabels: { "cursor-grok-4.7-xhigh": "Grok 4.7 Extra High" },
  efforts: [],
};
const cursorModels = () => workerModelCatalog([], [capability, cursorListed]);
const keptOrc = {
  id: "22222222-2222-4222-8222-222222222222",
  provider: "codex",
  cwd: "/repo",
  model: "gpt-5.6-sol",
  name: "Kept Orc",
  kind: "orchestrator",
  role: "orchestrator",
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  executionState: "active",
  attachmentState: "detached",
  detached: true,
  sandbox: "workspace-write",
  pid: 1,
  exitCode: null,
  childIds: [],
} as SessionRecord;

describe("Cursor orchestrator discovery in Fleet", () => {
  const open = (fleetSnapshot: FleetSnapshot = snapshot, projects?: readonly string[]) => {
    const base = projects === undefined ? fleetSnapshot : { ...fleetSnapshot, projects };
    return {
      snapshot: base,
      state: {
        ...createFleetState(base, "/repo"),
        workerModels: cursorModels(),
      },
    };
  };
  const type = (fleetSnapshot: FleetSnapshot, state: FleetState, text: string) =>
    [...text].reduce((current, char) => transitionFleet(current, fleetSnapshot, char, 0).state, state);

  it("filters new models by what was typed and leaves an existing Orc in place", () => {
    const fleetSnapshot: FleetSnapshot = { threads: [{ record: keptOrc }] };
    const opened = transitionFleet(open(fleetSnapshot).state, fleetSnapshot, "ctrl+o", 0).state;
    const expanded = transitionFleet(
      transitionFleet(opened, fleetSnapshot, "up", 0).state,
      fleetSnapshot,
      "right",
      0,
    ).state;
    const filtered = type(fleetSnapshot, expanded, "grok");
    const rendered = renderFleet(fleetSnapshot, filtered, { color: false, width: 120, height: 30 });
    expect(rendered).toContain("Kept Orc");
    expect(rendered).toContain("Grok 4.7 Extra High");
    expect(rendered).toContain("New orchestrator · grok");
    expect(rendered).toContain("type to filter");
    expect(rendered).not.toContain("Composer 2.5");
    expect(rendered).not.toContain("GPT-6-Astra");
    expect(filtered.orchestratorPicker).toMatchObject({ focus: { kind: "existing-group" } });
  });

  it("creates the filtered Cursor slug with no effort, and an empty match creates nothing", () => {
    const { snapshot: fleetSnapshot, state } = open();
    const filtered = type(fleetSnapshot, transitionFleet(state, fleetSnapshot, "ctrl+o", 0).state, "grok");
    const created = transitionFleet(filtered, fleetSnapshot, "enter", 0);
    expect(created.action).toMatchObject({
      type: "create-orchestrator",
      request: { provider: "cursor", model: "cursor-grok-4.7-xhigh" },
    });
    if (created.action?.type !== "create-orchestrator") throw new Error("Expected creation");
    expect(created.action.request).not.toHaveProperty("effort");

    const missed = type(fleetSnapshot, transitionFleet(state, fleetSnapshot, "ctrl+o", 0).state, "zzzz");
    const refused = transitionFleet(missed, fleetSnapshot, "enter", 0);
    expect(refused.action).toBeUndefined();
    expect(refused.state.notice).toContain("No model matches zzzz");
  });

  it("skips the one-row effort screen and returns to the model list from the project step", () => {
    const { snapshot: fleetSnapshot, state } = open(snapshot, ["/repo"]);
    const filtered = type(fleetSnapshot, transitionFleet(state, fleetSnapshot, "ctrl+o", 0).state, "grok");
    const project = transitionFleet(filtered, fleetSnapshot, "enter", 0);
    expect(project.state.orchestratorPicker?.step).toBe("project");
    expect(transitionFleet(project.state, fleetSnapshot, "escape", 0).state.orchestratorPicker?.step).toBe("target");
    const created = transitionFleet(project.state, fleetSnapshot, "enter", 0);
    expect(created.action).toMatchObject({
      request: { provider: "cursor", model: "cursor-grok-4.7-xhigh", cwd: "/repo" },
    });
    if (created.action?.type !== "create-orchestrator") throw new Error("Expected creation");
    expect(created.action.request).not.toHaveProperty("effort");
  });

  it("says when Cursor models are a stored list and does not offer the worker snapshot", () => {
    const fallback = fallbackWorkerCapabilities("agent models failed: timeout", "cursor")[0]!;
    const state: FleetState = {
      ...createFleetState(snapshot, "/repo"),
      workerModels: workerModelCatalog([], [capability, fallback]),
      orchestratorPicker: { step: "target", focus: { kind: "profile", modelIndex: 0 }, filter: "" },
    };
    const rendered = renderFleet(snapshot, state, { color: false, width: 140, height: 40 });
    expect(rendered).toContain("Cursor models are a stored list — agent models failed: timeout");
    expect(rendered).toContain("Kimi K3 Max");
    expect(rendered).not.toContain("Composer 2.5");
  });

  it("keeps the selected Cursor slug when discovery reorders the list", () => {
    const { snapshot: fleetSnapshot, state } = open();
    const filtered = type(fleetSnapshot, transitionFleet(state, fleetSnapshot, "ctrl+o", 0).state, "grok");
    const updated = adoptWorkerModels(filtered, workerModelCatalog([], [capability, {
      ...cursorListed,
      models: ["composer-2.5", "cursor-grok-4.7-xhigh"],
    }]));
    expect(updated.orchestratorPicker).toMatchObject({ step: "target", filter: "grok" });
    const focus = updated.orchestratorPicker?.step === "target" ? updated.orchestratorPicker.focus : undefined;
    const modelIndex = focus?.kind === "profile" ? focus.modelIndex : -1;
    expect(updated.workerModels.orchestratorChoices[modelIndex]?.model).toBe("cursor-grok-4.7-xhigh");
    expect(transitionFleet(updated, fleetSnapshot, "enter", 0).action).toMatchObject({
      request: { model: "cursor-grok-4.7-xhigh" },
    });
  });

  it("windows a long model list and reports the visible range", () => {
    const many: ResolvedWorkerCapability = {
      ...cursorListed,
      models: Array.from({ length: 40 }, (_, index) => `cursor-model-${index}`),
      modelLabels: {},
    };
    const state: FleetState = {
      ...createFleetState(snapshot, "/repo"),
      workerModels: workerModelCatalog([], [many]),
      orchestratorPicker: { step: "target", focus: { kind: "profile", modelIndex: 20 }, filter: "" },
    };
    const rendered = renderFleet(snapshot, state, { color: false, width: 80, height: 16 });
    expect(rendered).toMatch(/of 4[0-9]/);
    expect(rendered).toContain("type to filter");
  });
});
