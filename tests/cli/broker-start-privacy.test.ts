import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ state: "", inspect: () => {} }));
vi.mock("../../src/broker/app-paths.js", () => ({
  get appStateDirectory() { return fixture.state; },
  brokerSocketPath: "/unused-test-socket",
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, existsSync: (path: string) => path.endsWith("/dist/src/broker/main.js") || fs.existsSync(path) };
});
vi.mock("node:child_process", () => ({ spawn: () => {
  fixture.inspect();
  throw new Error("simulated child startup failure");
} }));

import { startDetachedBroker } from "../../src/cli/broker-process.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("detached broker startup privacy", () => {
  it.each([false, true])("protects state and log before spawning, including early failure (existing=%s)", async (existing) => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-start-privacy-"));
    directories.push(root);
    fixture.state = join(root, "state");
    const log = join(fixture.state, "broker.log");
    if (existing) {
      await mkdir(fixture.state, { mode: 0o755 });
      await writeFile(log, "prior log\n", { mode: 0o644 });
      await chmod(fixture.state, 0o755);
      await chmod(log, 0o644);
    }
    fixture.inspect = () => {
      expect(statSync(fixture.state).mode & 0o777).toBe(0o700);
      expect(statSync(log).mode & 0o777).toBe(0o600);
    };
    await expect(startDetachedBroker(false)).rejects.toThrow("simulated child startup failure");
    expect((await stat(log)).mode & 0o777).toBe(0o600);
    expect(await readFile(log, "utf8")).toBe(existing ? "prior log\n" : "");
  });
});
