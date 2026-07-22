import { describe, expect, it } from "vitest";
import { BrokerRuntimeConfigSchema } from "../src/config.js";

describe("broker runtime config", () => {
  it("defaults to 64 workers while excluding orchestrators from that policy", () => {
    const config = BrokerRuntimeConfigSchema.parse({});
    expect(config.maxConcurrentWorkers).toBe(64);
    expect(config.maxDelegationDepth).toBe(1);
    expect(config.replayBytes).toBe(128 * 1024);
  });

  it("allows an explicit unlimited worker setting", () => {
    expect(BrokerRuntimeConfigSchema.parse({ maxConcurrentWorkers: null }).maxConcurrentWorkers)
      .toBeNull();
  });

  it("carries neutral concurrency and budget declarations for the job plane", () => {
    const config = BrokerRuntimeConfigSchema.parse({
      concurrency: { maxConcurrentJobs: 2, maxConcurrentPerProvider: { codex: 1 } },
      budget: { maxJobs: 5, maxWallClockMs: 60_000 },
    });
    expect(config.concurrency.maxConcurrentJobs).toBe(2);
    expect(config.concurrency.maxConcurrentPerProvider?.codex).toBe(1);
    expect(config.budget.maxJobs).toBe(5);
  });

  it("defaults to declaring no job limits at all rather than inventing one", () => {
    const config = BrokerRuntimeConfigSchema.parse({});
    expect(config.concurrency.maxConcurrentJobs).toBeUndefined();
    expect(config.budget.maxJobs).toBeUndefined();
    expect(config.budget.maxTotalTokens).toBeUndefined();
  });
});
