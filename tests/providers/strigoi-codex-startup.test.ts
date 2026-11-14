import { describe, expect, it, vi } from "vitest";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import { strigoiPrompt } from "../../src/orchestration/strigoi-prompt.js";
import type { SessionRecord } from "../../src/domain/session.js";

describe("Strigoi native Codex instructions", () => {
  it("carries resident guidance and exact recovery pointers without a positional prompt or submission", () => {
    const runCommand = vi.fn();
    const adapter = new CodexProviderAdapter({ runCommand });
    const instructions = strigoiPrompt({ latestPacket: { artifactId: "packet-1", sha256: "a".repeat(64), coverageId: "coverage-1" } });
    const spec = adapter.buildLaunchSpec({ id: "resident", provider: "codex", kind: "orchestrator", cwd: "/repo", sandbox: "workspace-write", approvalMode: "auto", providerInstructions: instructions } as SessionRecord);
    expect(spec.args).not.toContain("--"); expect(runCommand).not.toHaveBeenCalled();
    const native = spec.args.find((s) => s.startsWith("developer_instructions="))!;
    for (const text of ["Strigoi", "Alfred", "packet-1", "coverage-1", "uncertainty", "No startup greeting", "authority"]) expect(native).toContain(text);
    expect(spec.args).toContain("--approve-for-me");
  });

  it("uses the identity bridge without MCP, preserving passive launch and idempotent preparation", async () => {
    const adapter = new CodexProviderAdapter({ runCommand: async () => JSON.stringify({ status: "connected" }) });
    const record = { id: "resident", provider: "codex", kind: "orchestrator", cwd: "/repo",
      sandbox: "workspace-write", approvalMode: "auto", providerInstructions: strigoiPrompt({}) } as SessionRecord;
    const spec = adapter.buildLaunchSpec(record);
    await adapter.prepareLaunch(record, spec);
    const args = [...spec.args];
    expect(args.some(arg => /remote-mcp-launch\.[jt]s$/u.test(arg))).toBe(true);
    expect(args).not.toContain("--mcp-node");
    // Only the wrapper separator exists; no native positional prompt was introduced.
    expect(args.filter(arg => arg === "--")).toHaveLength(1);
    expect(args.find(arg => arg.startsWith("developer_instructions="))).toContain("Strigoi");
    await adapter.prepareLaunch(record, spec);
    expect(spec.args).toEqual(args);
  });
});
