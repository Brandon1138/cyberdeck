import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { isolateCursorScoutMcp } from "../../src/providers/cursor/mcp-isolation.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Cursor Scout MCP isolation", () => {
  it("disables user and project MCP identifiers only inside Scout drop box", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-scout-mcp-"));
    directories.push(root);
    const home = join(root, "home");
    const repo = join(root, "repo");
    const dropBoxPath = join(root, "state", "scouts", "session");
    await Promise.all([
      mkdir(join(home, ".cursor"), { recursive: true }),
      mkdir(join(repo, ".cursor"), { recursive: true }),
      mkdir(dropBoxPath, { recursive: true }),
    ]);
    const userConfig = JSON.stringify({ mcpServers: { github: { command: "github" } } });
    const projectConfig = JSON.stringify({ mcpServers: { linear: { command: "linear" } } });
    await writeFile(join(home, ".cursor", "mcp.json"), userConfig);
    await writeFile(join(repo, ".cursor", "mcp.json"), projectConfig);

    const fakeAgent = join(root, "fake-agent.mjs");
    await writeFile(fakeAgent, [
      "#!/usr/bin/env node",
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      "const path = join(process.env.CURSOR_DATA_DIR, 'projects', 'fixture', 'mcp-disabled.json');",
      "await mkdir(join(process.env.CURSOR_DATA_DIR, 'projects', 'fixture'), { recursive: true });",
      "await writeFile(path, JSON.stringify([process.argv.at(-1)]));",
    ].join("\n"));
    await chmod(fakeAgent, 0o755);

    const session = {
      id: "11111111-1111-4111-8111-111111111111",
      provider: "cursor",
      model: "composer",
      cwd: repo,
      detached: true,
      sandbox: "read-only",
      approvalMode: "auto",
      profile: "scout",
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
      executionState: "active",
      attachmentState: "detached",
      pid: 12,
      exitCode: null,
      childIds: [],
      scout: {
        dropBoxPath,
        reportPath: join(dropBoxPath, "report.json"),
        canary: { status: "pending" },
        reportState: "missing",
      },
    } satisfies SessionRecord;

    await isolateCursorScoutMcp(session, {
      executable: fakeAgent,
      args: [],
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CURSOR_CONFIG_DIR: join(dropBoxPath, "cursor-config"),
        CURSOR_DATA_DIR: join(dropBoxPath, "cursor-data"),
        NODE_COMPILE_CACHE: join(dropBoxPath, "node-cache"),
        TMPDIR: join(dropBoxPath, "tmp"),
      },
    });

    const disabled = JSON.parse(await readFile(
      join(dropBoxPath, "cursor-data", "projects", "fixture", "mcp-disabled.json"),
      "utf8",
    ));
    expect(disabled).toEqual([
      "__cyberdeck_scout_isolation__",
      "github",
      "linear",
    ]);
    expect(await readFile(join(home, ".cursor", "mcp.json"), "utf8")).toBe(userConfig);
    expect(await readFile(join(repo, ".cursor", "mcp.json"), "utf8")).toBe(projectConfig);
  });
});
