import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FleetPreferenceStore } from "../../src/persistence/fleet-preference-store.js";
import { fleetMethods } from "../../src/broker/server/fleet-methods.js";
import type { BrokerMethodHandler } from "../../src/broker/server/method-context.js";

describe("Fleet visit preference RPC handlers", () => {
  it("reads, validates and persists view/read state through the existing preference store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fleet-visit-rpc-"));
    try {
      const store = new FleetPreferenceStore(directory);
      const server = { options: { fleetPreferences: store } } as unknown as Parameters<BrokerMethodHandler>[0];
      const invoke = (name: string, params: unknown) => fleetMethods[name]!(server, {} as Parameters<BrokerMethodHandler>[1], { params } as Parameters<BrokerMethodHandler>[2]);
      expect(await invoke("fleet.visit", {})).toEqual({ replies: {} });
      const preferences = { view: "unread", replies: { thread: { seen: "Earlier reply", latest: "New reply", canonicalTurns: 2 } } };
      expect(await invoke("fleet.visit.set", preferences)).toEqual({ saved: true });
      expect(await invoke("fleet.visit", {})).toEqual(preferences);
      await expect(invoke("fleet.visit.set", { view: "invented" })).rejects.toThrow();
      await expect(invoke("fleet.visit.set", { replies: { thread: { seen: null, latest: "Bytes", canonicalTurns: -1 } } })).rejects.toThrow();
      expect(await new FleetPreferenceStore(directory).visitPreferences()).toEqual(preferences);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
