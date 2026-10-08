import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import {
  cursorMcpHostPaths,
  writeCursorMcpHost,
  writeCursorNoticeHooks,
} from "../../src/providers/cursor/mcp-hosting.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const MCP = { nodePath: "/usr/bin/node", cliPath: "/opt/cyberdeck/cli.js" };
const SESSION: SessionRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "cursor",
  kind: "orchestrator",
  cwd: "/repo",
  detached: true,
  sandbox: "read-only",
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T00:00:00.000Z",
  executionState: "active",
  attachmentState: "detached",
  pid: 12,
  exitCode: null,
  childIds: [],
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-cursor-notice-"));
  directories.push(directory);
  const options = { directory };
  const plugin = cursorMcpHostPaths(SESSION.id, options).pluginDirectory;
  return { options, plugin, hooksPath: join(plugin, "hooks", "hooks.json") };
}

describe("Cursor session plugin notice hooks", () => {
  it("writes the exact orchestrator JSON beside MCP with private mode and trailing newline", async () => {
    const { options, plugin, hooksPath } = await fixture();
    await writeCursorMcpHost(SESSION, MCP, options);
    const mcpBefore = await readFile(join(plugin, ".mcp.json"), "utf8");
    await writeCursorNoticeHooks(SESSION, MCP, "/state/dir", options);
    const expected = {
      version: 1,
      hooks: {
        postToolUse: [{
          command: "/usr/bin/node /opt/cyberdeck/cli/notice-hook-entry.js"
            + ` --actor-session ${SESSION.id} --state-directory /state/dir --format cursor --event postToolUse`,
          timeout: 2,
        }],
        postToolUseFailure: [{
          command: "/usr/bin/node /opt/cyberdeck/cli/notice-hook-entry.js"
            + ` --actor-session ${SESSION.id} --state-directory /state/dir --format cursor --event postToolUseFailure`,
          timeout: 2,
        }],
      },
    };
    const contents = await readFile(hooksPath, "utf8");
    expect(JSON.parse(contents)).toEqual(expected);
    expect(contents).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect((await stat(hooksPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(plugin, ".mcp.json"), "utf8")).toBe(mcpBefore);
  });

  it.each(["worker", undefined] as const)("writes nothing for session kind %s", async (kind) => {
    const { options, plugin, hooksPath } = await fixture();
    const session = { ...SESSION };
    if (kind === undefined) delete session.kind;
    else session.kind = kind;
    await writeCursorNoticeHooks(session, MCP, "/state/dir", options);
    await expect(stat(hooksPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(plugin)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a stale orchestrator hook on a worker launch without removing MCP", async () => {
    const { options, plugin, hooksPath } = await fixture();
    await writeCursorMcpHost(SESSION, MCP, options);
    await writeCursorNoticeHooks(SESSION, MCP, "/state/dir", options);
    const worker = { ...SESSION, kind: "worker" } as const;
    await writeCursorNoticeHooks(worker, MCP, "/state/dir", options);
    await writeCursorNoticeHooks(worker, MCP, "/state/dir", options);
    await expect(stat(hooksPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(plugin, ".mcp.json"), "utf8")).toContain("cyberdeck");
  });

  it("removes stale hooks when the broker state directory is absent", async () => {
    const { options, hooksPath } = await fixture();
    await writeCursorNoticeHooks(SESSION, MCP, "/state/dir", options);
    await writeCursorNoticeHooks(SESSION, MCP, undefined, options);
    await expect(stat(hooksPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes stale hooks when MCP is absent", async () => {
    const { options, hooksPath } = await fixture();
    await writeCursorNoticeHooks(SESSION, MCP, "/state/dir", options);
    await writeCursorNoticeHooks(SESSION, undefined, "/state/dir", options);
    await expect(stat(hooksPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
