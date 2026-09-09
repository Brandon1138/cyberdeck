import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareContainerWorkspaceTrust } from "../../../src/runtime/execution/container-workspace-trust.js";
import { containerLaunchContext } from "../../../src/runtime/execution/container-launch-context.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "container-trust-")); roots.push(root);
  const hostState = join(root, "home"); await mkdir(hostState);
  return containerLaunchContext({ hostState, hostCredentials: join(root, "credentials"),
    reportingUrl: "http://host.docker.internal:1234/v1/report",
    workspace: { mode: "independent-clone", executionId: "fixture", hostPath: join(root, "clone"),
      guestPath: "/workspace", source: "/granted/source", baseCommit: "a".repeat(40), branch: "worker/test", manifestHash: "b".repeat(64) } });
}
it.each(["claude", "codex"])("prepares only the private %s trust entry with a source grant", async (provider) => {
  const context = await fixture(), allows = vi.fn(async () => false);
  await prepareContainerWorkspaceTrust(context, provider, allows);
  const path = provider === "claude" ? join(context.hostState, ".claude.json") : join(context.hostState, ".codex/config.toml");
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  allows.mockResolvedValue(true);
  await prepareContainerWorkspaceTrust(context, provider, allows);
  const first = await readFile(path, "utf8");
  expect(first).toContain("/workspace");
  expect(first).not.toContain(context.workspace.source);
  expect(first).not.toContain(context.workspace.hostPath);
  await prepareContainerWorkspaceTrust(context, provider, allows);
  expect(await readFile(path, "utf8")).toBe(first);
  expect(allows).toHaveBeenLastCalledWith("/granted/source");
});
it("preserves Codex's existing untrusted choice on resume", async () => {
  const context = await fixture(); await mkdir(join(context.hostState, ".codex"));
  const path = join(context.hostState, ".codex/config.toml"), original = '[projects."/workspace"]\ntrust_level = "untrusted"\n';
  await writeFile(path, original);
  await prepareContainerWorkspaceTrust(context, "codex", async () => true);
  expect(await readFile(path, "utf8")).toBe(original);
});
it.each(["claude", "codex"])("refuses provider-controlled %s symlinks before host writes", async (provider) => {
  const context = await fixture(), outside = join(context.hostCredentials, "outside");
  await mkdir(context.hostCredentials); await writeFile(outside, "preserved");
  if (provider === "codex") await mkdir(join(context.hostState, ".codex"));
  await symlink(outside, provider === "claude" ? join(context.hostState, ".claude.json") : join(context.hostState, ".codex/config.toml"));
  await expect(prepareContainerWorkspaceTrust(context, provider, async () => true)).rejects.toThrow("CONTAINER_TRUST_PATH_REFUSED");
  expect(await readFile(outside, "utf8")).toBe("preserved");
});
