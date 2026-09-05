import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import { CodexOrchestratorModelProbe } from "../../src/providers/codex-orchestrator-model-probe.js";
import { type runListingCommand } from "../../src/orchestration/worker-capability-catalog.js";

afterEach(() => vi.unstubAllEnvs());

describe("first-party Codex orchestrator discovery", () => {
  it("uses launch's provider override and environment even with inherited custom routing", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/custom-codex-config");
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:1234/custom-provider");
    const run = vi.fn<typeof runListingCommand>(async () => ({ stdout: JSON.stringify({ models: [
      { slug: "gpt-6-astra", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] },
    ] }) }));
    await expect(new CodexOrchestratorModelProbe(run).list("codex"))
      .resolves.toEqual({ models: [{ id: "gpt-6-astra", efforts: ["high"] }] });
    const [executable, args, options] = run.mock.calls[0]!;
    expect(executable).toBe("codex");
    expect(args).toEqual(["debug", "models", "-c", 'model_provider="openai"']);
    expect(options).toMatchObject({ cwd: "/", timeout: 10_000 });
    expect(options.env).toMatchObject({ CODEX_HOME: "/tmp/custom-codex-config", CYBERDECK_PROCESS_ROLE: "orchestrator" });
    expect(options.env).not.toHaveProperty("OPENAI_BASE_URL");
    const launch = new CodexProviderAdapter().buildLaunchSpec({
      id: "test", kind: "orchestrator", provider: "codex", cwd: "/repo",
      sandbox: "workspace-write", approvalMode: "auto", model: "gpt-6-astra",
    } as SessionRecord);
    expect(launch.args).toEqual(expect.arrayContaining(args.slice(2)));
    expect(launch.env?.CODEX_HOME).toBe(options.env?.CODEX_HOME);
    expect(launch.env).not.toHaveProperty("OPENAI_BASE_URL");
  });

  it("does not query other providers and reports malformed output or command failures", async () => {
    const run = vi.fn<typeof runListingCommand>().mockResolvedValue({ stdout: "invalid" });
    const probe = new CodexOrchestratorModelProbe(run);
    await expect(probe.list("cursor")).resolves.toHaveProperty("unavailable");
    expect(run).not.toHaveBeenCalled();
    await expect(probe.list("codex")).resolves.toHaveProperty("unavailable", "First-party Codex model discovery printed no recognizable model ids");
    run.mockRejectedValueOnce(new Error("timeout"));
    await expect(probe.list("codex")).resolves.toHaveProperty("unavailable", "First-party Codex model discovery failed: timeout");
  });
});
