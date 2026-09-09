import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ContainerProviderAdapter } from "../../../src/runtime/execution/container-provider-adapter.js";
import { ClaudeProviderAdapter } from "../../../src/providers/claude.js";
import { CodexProviderAdapter } from "../../../src/providers/codex.js";
import type { SessionRecord } from "../../../src/domain/session.js";
import { BrokerRuntimeConfigSchema } from "../../../src/config.js";

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
  if (provider === "codex") {
    expect(JSON.stringify(spec.args)).toContain("/opt/cyberdeck/mcp.mjs");
    expect(spec.args[spec.args.indexOf("-s") + 1]).toBe("read-only");
    expect(spec.args[spec.args.indexOf("-a") + 1]).toBe("on-request");
    expect(spec.args).toContain("use_legacy_landlock");
    expect(host.buildLaunchSpec({ ...session, executor: "host" }).args).not.toContain("danger-full-access");
  }
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
it("defaults to native isolation and requires an explicit configuration value", () => {
  const containerRuntime = { endpoint: "unix:///tmp/docker.sock", image: `sha256:${"a".repeat(64)}` };
  expect(BrokerRuntimeConfigSchema.parse({ containerRuntime }).containerRuntime?.codexWorkspaceIsolation).toBe("native");
  expect(BrokerRuntimeConfigSchema.parse({ containerRuntime: { ...containerRuntime, codexWorkspaceIsolation: "container" } }).containerRuntime?.codexWorkspaceIsolation).toBe("container");
  expect(BrokerRuntimeConfigSchema.safeParse({ containerRuntime: { ...containerRuntime, codexWorkspaceIsolation: true } }).success).toBe(false);
});
it("applies semi-autonomous container isolation only to opted-in writable Codex launch and resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "container-opt-in-")); directories.push(root);
  const host = new CodexProviderAdapter({ sourceEnvironment: {}, nativeSessionId: randomUUID() });
  const adapter = new ContainerProviderAdapter(host, root, "container");
  const session = { ...record("codex"), sandbox: "workspace-write" as const };
  await mkdir(join(root, "native-bindings"));
  await writeFile(join(root, "native-bindings", `${session.id}.json`), JSON.stringify({ sessionId: session.id,
    nativeSessionId: randomUUID(), provider: "codex", relativePath: ".codex/sessions/fixture.jsonl" }));
  for (const spec of [adapter.buildLaunchSpec(session), adapter.buildResumeSpec(session)]) {
    expect(spec.args[spec.args.indexOf("-s") + 1]).toBe("danger-full-access");
    expect(spec.args[spec.args.indexOf("-a") + 1]).toBe("never");
    expect(spec.args).not.toContain("use_legacy_landlock");
  }
  const native = new ContainerProviderAdapter(host, root).buildLaunchSpec(session);
  expect(native.args[native.args.indexOf("-s") + 1]).toBe("workspace-write");
  expect(native.args[native.args.indexOf("-a") + 1]).toBe("on-request");
  const readOnly = adapter.buildLaunchSpec(record("codex"));
  expect(readOnly.args[readOnly.args.indexOf("-s") + 1]).toBe("read-only");
  expect(readOnly.args[readOnly.args.indexOf("-a") + 1]).toBe("on-request");
  const hostSession = { ...session, executor: "host" as const };
  expect(adapter.buildLaunchSpec(hostSession)).toEqual(host.buildLaunchSpec(hostSession));
  expect(adapter.buildResumeSpec(hostSession)).toEqual(host.buildResumeSpec(hostSession));
  const claude = new ClaudeProviderAdapter({ sourceEnvironment: {} });
  const claudeSession = record("claude");
  expect(new ContainerProviderAdapter(claude, root, "container").buildLaunchSpec(claudeSession))
    .toEqual(new ContainerProviderAdapter(claude, root).buildLaunchSpec(claudeSession));
});
