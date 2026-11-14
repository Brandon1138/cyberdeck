import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { parseStrigoiGate, validateStrigoiGate, runStrigoiGate } from "../../scripts/run-live-strigoi-gate.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("isolated lifecycle runner (no provider calls)", () => {
  it.each([["crash", "passive"], ["crash", "reserved-launch"], ["semantic", "three-handoffs"]])("validates executable %s case %s without creating state", async (mode, caseId) => {
    const root = await mkdtemp("/tmp/sg-"); roots.push(root);
    const stateDirectory = join(root, "gate"), write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runStrigoiGate(parseStrigoiGate(["--mode", mode!, "--case", caseId!, "--state-directory", stateDirectory,
        "--cwd", root, "--model", "FIXTURE_VALIDATION_ONLY", "--validate-only"]));
      expect(JSON.parse(String(write.mock.calls.at(-1)![0])).status).toBe("VALIDATED");
      await expect(access(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { write.mockRestore(); }
  });
  it("requires mode, cwd, model, private state and explicit inference authorization", () => {
    expect(() => parseStrigoiGate([])).toThrow("Required");
    expect(() => parseStrigoiGate(["--mode", "lifecycle", "--state-directory", "/tmp/g", "--cwd", "/tmp", "--model", "fixture"])).toThrow("allow-inference");
    expect(() => parseStrigoiGate(["--mode", "lifecycle", "--state-directory", "/tmp/g", "--cwd", "relative", "--model", "fixture", "--validate-only"])).toThrow("absolute");
  });
  it("validate-only emits the production plan without state, process or inference effects", async () => {
    const root = await mkdtemp("/tmp/sg-"); roots.push(root);
    const stateDirectory = join(root, "gate");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runStrigoiGate(parseStrigoiGate(["--mode", "lifecycle", "--state-directory", stateDirectory,
        "--cwd", root, "--model", "FIXTURE_VALIDATION_ONLY", "--validate-only"]));
      const result = JSON.parse(String(write.mock.calls.at(-1)![0]));
      expect(result).toMatchObject({ status: "VALIDATED", live: "NOT RUN", plan: { participants: "production Task7/8", primaryContact: false, nvim: false, idleMilliseconds: 600000,
        inferenceRequests: { observed: null } } });
      await expect(access(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { write.mockRestore(); }
  });
  it("validates without creating state and refuses active state and allows a distinct primary socket, nonempty state, and aliases", async () => {
    const root = await mkdtemp("/tmp/sg-"); roots.push(root);
    const active = join(root, "active"), gate = join(root, "gate"), socket = join(root, "broker.sock"); await mkdir(active);
    const o = parseStrigoiGate(["--mode", "lifecycle", "--state-directory", gate, "--cwd", root, "--model", "fixture", "--validate-only"]);
    await expect(validateStrigoiGate(o, { state: active, socket })).resolves.toBeUndefined();
    await expect(validateStrigoiGate({ ...o, stateDirectory: active }, { state: active, socket })).rejects.toThrow("active broker state");
    await writeFile(socket, "socket sentinel");
    await expect(validateStrigoiGate(o, { state: active, socket })).resolves.toBeUndefined();
    expect(await (await import("node:fs/promises")).readFile(socket, "utf8")).toBe("socket sentinel");
    await rm(socket); await symlink(active, gate);
    await expect(validateStrigoiGate(o, { state: active, socket })).rejects.toThrow("symlink");
    await rm(gate); await mkdir(gate); await writeFile(join(gate, "evidence"), "keep");
    await expect(validateStrigoiGate(o, { state: active, socket })).rejects.toThrow("evidence is preserved");
  });
});
