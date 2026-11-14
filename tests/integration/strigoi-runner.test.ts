import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseStrigoiGate, validateStrigoiGate } from "../../scripts/run-live-strigoi-gate.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("isolated lifecycle runner (no provider calls)", () => {
  it("requires mode, cwd, model, private state and explicit inference authorization", () => {
    expect(() => parseStrigoiGate([])).toThrow("Required");
    expect(() => parseStrigoiGate(["--mode", "lifecycle", "--state-directory", "/tmp/g", "--cwd", "/tmp", "--model", "fixture"])).toThrow("allow-inference");
    expect(() => parseStrigoiGate(["--mode", "lifecycle", "--state-directory", "/tmp/g", "--cwd", "relative", "--model", "fixture", "--validate-only"])).toThrow("absolute");
  });
  it("validates without creating state and refuses active state/socket, nonempty state, and aliases", async () => {
    const root = await mkdtemp("/tmp/sg-"); roots.push(root);
    const active = join(root, "active"), gate = join(root, "gate"), socket = join(root, "broker.sock"); await mkdir(active);
    const o = parseStrigoiGate(["--mode", "lifecycle", "--state-directory", gate, "--cwd", root, "--model", "fixture", "--validate-only"]);
    await expect(validateStrigoiGate(o, { state: active, socket })).resolves.toBeUndefined();
    await expect(validateStrigoiGate({ ...o, stateDirectory: active }, { state: active, socket })).rejects.toThrow("active broker state");
    await writeFile(socket, "socket sentinel");
    await expect(validateStrigoiGate(o, { state: active, socket })).rejects.toThrow("active broker socket");
    await rm(socket); await symlink(active, gate);
    await expect(validateStrigoiGate(o, { state: active, socket })).rejects.toThrow("symlink");
    await rm(gate); await mkdir(gate); await writeFile(join(gate, "evidence"), "keep");
    await expect(validateStrigoiGate(o, { state: active, socket })).rejects.toThrow("evidence is preserved");
  });
});
