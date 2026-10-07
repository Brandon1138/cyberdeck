import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ValidatedJournal } from "../../src/persistence/validated-journal.js";
import { FleetPreferenceStore } from "../../src/persistence/fleet-preference-store.js";
import { OrchestratorStore } from "../../src/persistence/orchestrator-store.js";
import { grantAllows } from "../../src/domain/capability.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "cyberdeck-projection-")); directories.push(path); return path; }

it("reuses validation only while the current file is unchanged, including same-size replacement", async () => {
  const path = join(await directory(), "journal.jsonl");
  const parse = vi.fn((text: string) => text.split("\n").slice(0, -1).map((line) => JSON.parse(line)));
  const journal = new ValidatedJournal(path, parse);
  await journal.append({ enabled: true });
  expect(await journal.read()).toEqual([{ enabled: true }]);
  await journal.read(); await journal.read();
  expect(parse).toHaveBeenCalledTimes(1);
  await writeFile(`${path}.new`, '{"enabled":null}\n');
  await rename(`${path}.new`, path);
  expect(await journal.read()).toEqual([{ enabled: null }]);
  await writeFile(path, '{"enabled":true}\n');
  expect(await journal.read()).toEqual([{ enabled: true }]);
  await appendFile(path, '{"enabled":false}\n');
  expect(await journal.read()).toHaveLength(2);
  await writeFile(path, '{broken journal}\n');
  await expect(journal.read()).rejects.toThrow();
  await expect(journal.read()).rejects.toThrow();
  await rm(path);
  expect(await journal.read()).toEqual([]);
  await journal.append({ repaired: true });
  expect(await journal.read()).toEqual([{ repaired: true }]);
});

it("serializes durable appends and observes another writer before returning preferences", async () => {
  const path = await directory();
  const first = new FleetPreferenceStore(path), external = new FleetPreferenceStore(path);
  await Promise.all([first.setProject("/one", true), first.setProject("/two", true)]);
  expect(await first.listProjects()).toEqual(["/one", "/two"]);
  await external.setProject("/one", false);
  expect(await first.listProjects()).toEqual(["/two"]);
  await external.setNvimLayout(false);
  expect(await first.nvimLayoutEnabled()).toBe(false);
  await appendFile(first.path, '{invalid}\n');
  await expect(first.listProjects()).rejects.toThrow("Invalid Fleet preference at line 5");
});

it("never authorizes from a cached revoked grant or a caller-mutated binding", async () => {
  const path = await directory(), first = new OrchestratorStore(path), external = new OrchestratorStore(path);
  const sessionId = "11111111-1111-4111-8111-111111111111", scope = { kind: "fleet" as const };
  await first.put({ key: "fleet", kind: "primary", sessionId, provider: "claude", model: "fixture", cwd: "/repo", sandbox: "read-only", scope,
    grant: { subjectSessionId: sessionId, capabilities: ["thread.read"], scope }, createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z" });
  const binding = (await first.findBySessionId(sessionId))!;
  binding.grant.capabilities.length = 0;
  expect(grantAllows((await first.findBySessionId(sessionId))!.grant, "thread.read")).toBe(true);
  await external.put(binding);
  expect(grantAllows((await first.findBySessionId(sessionId))!.grant, "thread.read")).toBe(false);
  await external.reset("fleet");
  expect(await first.findBySessionId(sessionId)).toBeUndefined();
  await appendFile(first.path, '{corrupt authority}\n');
  await expect(first.findBySessionId(sessionId)).rejects.toThrow();
});
