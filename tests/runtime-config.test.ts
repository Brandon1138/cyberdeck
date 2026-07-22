import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBrokerRuntimeConfig } from "../src/runtime-config.js";

describe("loadBrokerRuntimeConfig", () => {
  it("uses defaults when the persistent config is absent", () => {
    expect(loadBrokerRuntimeConfig("/definitely/missing/cyberdeck-config.json").maxConcurrentWorkers)
      .toBe(64);
  });

  it("loads an explicit unlimited worker setting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-config-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ maxConcurrentWorkers: null }));

    expect(loadBrokerRuntimeConfig(path).maxConcurrentWorkers).toBeNull();
  });

  it("fails closed on invalid persistent config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-config-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ maxConcurrentWorkers: 0 }));

    expect(() => loadBrokerRuntimeConfig(path)).toThrow(`Invalid Cyberdeck broker config at ${path}`);
  });
});
