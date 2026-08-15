import { describe, expect, it, vi } from "vitest";
import type { ProviderId } from "../../src/domain/session.js";
import {
  parseModelListing,
  runListingCommand,
  WorkerCapabilityCatalog,
  type ProviderModelListing,
  type ProviderModelProbe,
} from "../../src/orchestration/worker-capability-catalog.js";

function probe(
  listings: Partial<Record<ProviderId, ProviderModelListing>>,
): ProviderModelProbe & { list: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async (provider: ProviderId) =>
      listings[provider] ?? { unavailable: `${provider} was not asked` }),
  };
}

describe("provider model listings", () => {
  it("reads both formats the provider CLIs actually print", () => {
    // `agent models`: a header, ` - ` separated rows, and a trailing tip.
    expect(parseModelListing([
      "Available models:",
      "cursor-grok-4.6-high - Grok 4.6 (High)",
      "composer-2.5 - Composer 2.5",
      "Tip: run agent --model <id>",
    ].join("\n"))).toEqual([
      { id: "cursor-grok-4.6-high", label: "Grok 4.6 (High)" },
      { id: "composer-2.5", label: "Composer 2.5" },
    ]);
    // `agy models`: a progress line, then tab separated rows.
    expect(parseModelListing([
      "Fetching available models...",
      "gemini-3.6-flash-high\tGemini 3.6 Flash (High)",
      "gemini-3.6-flash-high\tduplicate",
      "",
    ].join("\n"))).toEqual([
      { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
    ]);
  });

  it("refuses to read prose as a launch identifier", () => {
    expect(parseModelListing([
      "-- not a model",
      "rm -rf /",
      "$(whoami)",
      "plain-id",
    ].join("\n"))).toEqual([{ id: "plain-id" }]);
  });
});

describe("listing commands", () => {
  it("closes stdin, so a CLI that waits to be typed at still prints its listing", async () => {
    // `agy models` prints its list and then blocks on an open stdin pipe. Left attached, the probe
    // times out and reports Antigravity unaskable — a stale list served as a confident answer.
    const waitsForStdin = [
      "process.stdout.write('gemini-3.7-flash-high\\tGemini 3.7 Flash (High)\\n');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => process.exit(0));",
    ].join("");

    await expect(runListingCommand(process.execPath, ["-e", waitsForStdin], { timeout: 5_000 }))
      .resolves.toEqual({ stdout: "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n" });
  });
});

describe("WorkerCapabilityCatalog", () => {
  it("serves what a provider listed, keeping Cyberdeck's own launch contract", async () => {
    const catalog = new WorkerCapabilityCatalog({
      probe: probe({ codex: { models: [{ id: "gpt-5.7-nova", label: "Codex Nova" }] } }),
      now: () => Date.parse("2026-08-16T00:00:00.000Z"),
    });

    const [codex] = await catalog.resolve("codex");
    expect(codex).toMatchObject({
      provider: "codex",
      models: ["gpt-5.7-nova"],
      modelLabels: { "gpt-5.7-nova": "Codex Nova" },
      source: "provider-query",
      observedAt: "2026-08-16T00:00:00.000Z",
    });
    // Efforts, approval modes, and grant notes are launch policy, not something a listing reports.
    expect(codex?.efforts).toContain("xhigh");
    expect(codex?.approvalModes).toEqual(["prompt", "auto"]);
  });

  it("names the reason a provider could not be asked instead of serving an empty list", async () => {
    const catalog = new WorkerCapabilityCatalog({
      probe: probe({ claude: { unavailable: "the claude CLI advertises no model-listing subcommand" } }),
    });

    const [claude] = await catalog.resolve("claude");
    expect(claude).toMatchObject({
      provider: "claude",
      models: ["haiku", "sonnet", "opus", "fable"],
      source: "fallback-catalog",
      fallbackReason: "the claude CLI advertises no model-listing subcommand",
    });
  });

  it("treats a probe that throws as an unanswered question, not a provider with no models", async () => {
    const catalog = new WorkerCapabilityCatalog({
      probe: { list: async () => { throw new Error("spawn EACCES"); } },
    });

    const [cursor] = await catalog.resolve("cursor");
    expect(cursor).toMatchObject({ source: "fallback-catalog", fallbackReason: "spawn EACCES" });
    expect(cursor?.models.length).toBeGreaterThan(0);
  });

  it("asks each provider once per TTL, and once for concurrent callers", async () => {
    let now = 0;
    const listing = probe({ codex: { models: [{ id: "gpt-5.6-luna" }] } });
    const catalog = new WorkerCapabilityCatalog({ probe: listing, ttlMs: 1_000, now: () => now });

    await Promise.all([catalog.resolve(), catalog.resolve()]);
    const afterConcurrent = listing.list.mock.calls.length;
    await catalog.resolve();
    expect(listing.list.mock.calls.length).toBe(afterConcurrent);

    now = 1_001;
    await catalog.resolve();
    expect(listing.list.mock.calls.length).toBe(afterConcurrent * 2);

    catalog.invalidate();
    await catalog.resolve();
    expect(listing.list.mock.calls.length).toBe(afterConcurrent * 3);
  });
});
