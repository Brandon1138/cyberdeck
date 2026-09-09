import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ContainerProviderAdapter } from "../../../src/runtime/execution/container-provider-adapter.js";
import { ClaudeProviderAdapter } from "../../../src/providers/claude.js";
import { CodexProviderAdapter } from "../../../src/providers/codex.js";
import type { SessionRecord } from "../../../src/domain/session.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function record(provider: string): SessionRecord {
  return { id: randomUUID(), provider, model: provider === "claude" ? "opus" : "gpt-6-astra", executor: "orbstack-container", kind: "worker", cwd: "/host/workspace", sandbox: "read-only", approvalMode: "prompt", detached: true,
    generation: 1, executionState: "starting", attachmentState: "detached", pid: 0, exitCode: null, childIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
it.each(["claude", "codex"])("constructs guest-valid %s reporting paths and preserves explicit host launch policy", async (provider) => {
  const root = await mkdtemp(join(tmpdir(), "container-provider-")); directories.push(root);
  const host = provider === "claude" ? new ClaudeProviderAdapter({ sourceEnvironment: {} }) : new CodexProviderAdapter({ sourceEnvironment: {} });
  const adapter = new ContainerProviderAdapter(host, root), session = record(provider);
  const spec = adapter.buildLaunchSpec(session, "fixture instruction");
  expect(spec.cwd).toBe("/workspace");
  expect(JSON.stringify(spec)).not.toContain("/host/workspace");
  expect(JSON.stringify(spec)).not.toContain(root);
  if (provider === "codex") expect(JSON.stringify(spec.args)).toContain("/opt/cyberdeck/mcp.mjs");
  expect(spec.args).not.toContain("--dangerously-skip-permissions");
  expect(spec.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  await adapter.prepareLaunch(session, spec);
  if (provider === "claude") {
    const index = spec.args.indexOf("--mcp-config"), guestFile = spec.args[index + 1]!;
    const hostFile = join(root, "credentials", session.id, guestFile.slice("/run/credentials/".length));
    expect(JSON.parse(await readFile(hostFile, "utf8")).mcpServers.cyberdeck.command).toBe("node");
  }
  const hostSession = { ...session, executor: "host" as const };
  expect(adapter.buildLaunchSpec(hostSession, "fixture instruction")).toEqual(host.buildLaunchSpec(hostSession, "fixture instruction"));
});
it("refuses unsupported native provider modes and extra host roots explicitly", () => {
  const adapter = new ContainerProviderAdapter(new ClaudeProviderAdapter(), "/private/broker");
  expect(() => adapter.buildLaunchSpec({ ...record("claude"), workspace: { provisioning: "worker-provisioned", worktreePath: "/host/new", branch: "work", baseRef: "main", writableRoots: ["/host/.git"] } })).toThrow("CONTAINER_WORKSPACE_POLICY_UNSUPPORTED");
});
