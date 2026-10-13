import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import { readCodexDeveloperInstructions } from "../../src/providers/codex/effective-instructions.js";
import { codexDeveloperInstructions } from "../../src/providers/codex/native-session-identity.js";
import { prepareCodexThreadMcp } from "../../src/providers/codex/remote-mcp-bridge.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixtureServer = `
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
if (process.env.FIXTURE_MODE?.startsWith('resistant')) {
  process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
  writeFileSync(process.env.FIXTURE_PID, String(process.pid));
}
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ ...request, home: process.env.CODEX_HOME, processCwd: process.cwd() }) + '\\n');
  if (request.method === 'initialize') console.log(JSON.stringify({ id: request.id, result: {} }));
  else if (request.method === 'config/read') {
    if (process.env.FIXTURE_MODE?.endsWith('timeout')) return;
    if (process.env.FIXTURE_MODE === 'error') console.log(JSON.stringify({ id: request.id, error: { message: 'secret config value' } }));
    else console.log(JSON.stringify({ id: request.id, result: { config: { developer_instructions: process.env.FIXTURE_INSTRUCTIONS ?? null } } }));
  }
});`;

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "codex-config-reader-")); roots.push(cwd);
  return { cwd, env: { ...process.env, CODEX_HOME: join(cwd, "home"), FIXTURE_LOG: join(cwd, "requests.jsonl") } };
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { id: "11111111-1111-4111-8111-111111111111", provider: "codex", kind: "worker", cwd: "/fixture/project",
    sandbox: "read-only", createdAt: "2026-10-13T10:00:00Z", ...overrides } as SessionRecord;
}
const command = { executable: process.execPath, args: ["--input-type=module", "-e", fixtureServer] };

describe("effective Codex developer instructions", () => {
  it.each([undefined, "effective project and profile guidance"])("reads native config without starting a thread (%s)", async instructions => {
    const options = await fixture();
    if (instructions !== undefined) Object.assign(options.env, { FIXTURE_INSTRUCTIONS: instructions });
    expect(await readCodexDeveloperInstructions(options, command)).toBe(instructions);
    const requests = (await readFile(options.env.FIXTURE_LOG, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.map(value => value.method)).toEqual(["initialize", "initialized", "config/read"]);
    expect(requests.at(-1)).toMatchObject({ params: { cwd: options.cwd, includeLayers: false },
      home: options.env.CODEX_HOME, processCwd: await realpath(options.cwd) });
  });

  it.each(["error", "timeout"])("refuses unreadable effective config without leaking values (%s)", async mode => {
    const options = await fixture(); Object.assign(options.env, { FIXTURE_MODE: mode });
    await expect(readCodexDeveloperInstructions(options, { ...command, timeoutMs: 300 })).rejects.toMatchObject({
      code: "CODEX_CONFIG_UNAVAILABLE", message: "Could not read effective Codex developer instructions",
    });
  });

  it.each(["success", "timeout"])("reaps its own SIGTERM-resistant child before settling (%s)", async mode => {
    const options = await fixture(), pidPath = join(options.cwd, "reader.pid");
    Object.assign(options.env, { FIXTURE_MODE: `resistant-${mode}`, FIXTURE_PID: pidPath,
      FIXTURE_INSTRUCTIONS: "preserved" });
    let pid: number | undefined;
    try {
      const result = readCodexDeveloperInstructions(options, { ...command, timeoutMs: 1000 });
      if (mode === "success") expect(await result).toBe("preserved");
      else await expect(result).rejects.toMatchObject({ code: "CODEX_CONFIG_UNAVAILABLE" });
      pid = Number(await readFile(pidPath, "utf8"));
      expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      pid ??= Number(await readFile(pidPath, "utf8").catch(() => "0"));
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ } }
    }
  });

  it.each(["launch", "resume"] as const)("preserves effective instructions and exact identity at actual %s preparation", async operation => {
    const resolveDeveloperInstructions = vi.fn(async () => "inherited native guidance");
    const adapter = new CodexProviderAdapter({ sourceEnvironment: { CODEX_HOME: "/fixture/home" },
      nativeSessionId: "native-thread", resolveDeveloperInstructions });
    const session = record();
    const spec = operation === "launch" ? adapter.buildLaunchSpec(session, "initial task") : adapter.buildResumeSpec(session);
    expect(spec.args.some(value => value.startsWith("developer_instructions="))).toBe(false);
    await adapter.prepareLaunch(session, spec);
    expect(resolveDeveloperInstructions).toHaveBeenCalledWith({ cwd: session.cwd, env: spec.env });
    expect(spec.args).toContain(`developer_instructions=${JSON.stringify(codexDeveloperInstructions(session.id, "inherited native guidance"))}`);
    if (operation === "launch") expect(spec.args.slice(-2)).toEqual(["--", "initial task"]);
    else { expect(spec.args[0]).toBe("resume"); expect(spec.args.at(-1)).toBe("native-thread"); }
    await adapter.prepareLaunch(session, spec);
    expect(spec.args.filter(value => value.startsWith("developer_instructions="))).toHaveLength(1);
  });

  it("loads the prepared orchestrator home rather than the worker home", async () => {
    let prepared = false;
    const resolveDeveloperInstructions = vi.fn(async ({ env }: { env: NodeJS.ProcessEnv }) => {
      expect(prepared).toBe(true); expect(env.CODEX_HOME).toBe("/fixture/orchestrator-home"); return "orchestrator inherited rules";
    });
    const adapter = new CodexProviderAdapter({ resolveDeveloperInstructions, sourceEnvironment: { CODEX_HOME: "/fixture/home" },
      orchestratorHome: { directory: "/fixture/orchestrator-home", prepare: async () => { prepared = true; } },
      runCommand: async () => JSON.stringify({ status: "connected" }) });
    const session = record({ kind: "orchestrator" }), spec = adapter.buildLaunchSpec(session);
    await adapter.prepareLaunch(session, spec);
    expect(resolveDeveloperInstructions).toHaveBeenCalledOnce();
    expect(spec.args).toContain(`developer_instructions=${JSON.stringify(codexDeveloperInstructions(session.id, "orchestrator inherited rules"))}`);
  });

  it("keeps explicit instructions authoritative and never imports host config into a container", async () => {
    const resolveDeveloperInstructions = vi.fn(async () => "must not be loaded");
    const adapter = new CodexProviderAdapter({ resolveDeveloperInstructions });
    for (const session of [record({ providerInstructions: "explicit guidance" }), record({ executor: "orbstack-container" })]) {
      const spec = adapter.buildLaunchSpec(session); await adapter.prepareLaunch(session, spec);
      if (session.providerInstructions) expect(spec.args).toContain(`developer_instructions=${JSON.stringify(codexDeveloperInstructions(session.id, "explicit guidance"))}`);
      else expect(spec.args.some(value => value.startsWith("developer_instructions="))).toBe(false);
    }
    expect(resolveDeveloperInstructions).not.toHaveBeenCalled();
  });

  it("refuses launch if effective config cannot be read instead of silently dropping it", async () => {
    const adapter = new CodexProviderAdapter({ resolveDeveloperInstructions: async () => { throw new Error("native config unavailable"); } });
    const session = record(), spec = adapter.buildLaunchSpec(session);
    await expect(adapter.prepareLaunch(session, spec)).rejects.toThrow("native config unavailable");
    expect(spec.args.some(value => value.startsWith("developer_instructions="))).toBe(false);
  });

  it("preserves a prompt beginning with a config key as user input", async () => {
    const adapter = new CodexProviderAdapter({ resolveDeveloperInstructions: async () => "inherited rules" });
    const session = record(), prompt = 'developer_instructions="Example" is the setting I need reviewed.';
    const spec = adapter.buildLaunchSpec(session, prompt); await adapter.prepareLaunch(session, spec);
    expect(spec.args.slice(-2)).toEqual(["--", prompt]);
    expect(spec.args.slice(0, spec.args.indexOf("--"))).toContain(
      `developer_instructions=${JSON.stringify(codexDeveloperInstructions(session.id, "inherited rules"))}`);
  });

  it.each(["thread/start", "thread/resume", "thread/fork"])("preserves inherited remote instructions at %s", async method => {
    const resolveDeveloperInstructions = vi.fn(async () => "remote native guidance");
    const options = { sessionId: record().id, homeDirectory: "/fixture/home", cwd: "/fallback/project",
      mcp: { nodePath: "/node", cliPath: "/cli" }, resolveDeveloperInstructions };
    const original = Buffer.from(JSON.stringify({ id: 9, method, params: { cwd: "/actual/project" } }));
    const result = JSON.parse((await prepareCodexThreadMcp(original, options)).toString());
    expect(resolveDeveloperInstructions).toHaveBeenCalledWith("/actual/project");
    expect(result.params.developerInstructions).toBe(codexDeveloperInstructions(record().id, "remote native guidance"));
    const explicit = Buffer.from(JSON.stringify({ id: 10, method, params: { developerInstructions: "explicit remote guidance" } }));
    expect(JSON.parse((await prepareCodexThreadMcp(explicit, options)).toString()).params.developerInstructions)
      .toBe(codexDeveloperInstructions(record().id, "explicit remote guidance"));
    expect(resolveDeveloperInstructions).toHaveBeenCalledOnce();
  });
});
