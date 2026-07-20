import { describe, expect, it } from "vitest";
import { probeCommand } from "../../scripts/probe-runtimes.js";

describe("probeCommand", () => {
  it("captures stdout and the executable path without invoking a model", async () => {
    const result = await probeCommand(process.execPath, ["--version"]);
    expect(result.available).toBe(true);
    expect(result.executable).toBe(process.execPath);
    expect(result.output).toMatch(/^v\d+/);
  });

  it("reports a missing executable without throwing", async () => {
    const result = await probeCommand("cyberdeck-command-that-does-not-exist", ["--version"]);
    expect(result.available).toBe(false);
    expect(result.output).toBe("");
  });
});
