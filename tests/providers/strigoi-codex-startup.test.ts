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
});
