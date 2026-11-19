import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStrigoiPrompt, strigoiPrompt } from "../../src/orchestration/strigoi-prompt.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "strigoi-alfred-")); roots.push(root);
  return { root, path: join(root, "SKILL.md"), onError: vi.fn() };
}

describe("resident Alfred instructions", () => {
  it("preserves the installed skill verbatim alongside exact recovery instructions and rereads on launch", async () => {
    const f = await fixture();
    const state = { latestPacket: { artifactId: "packet", coverageId: "coverage", sha256: "a".repeat(64) } };
    const content = "\uFEFF---\r\nname: alfred\r\n---\r\nLook after the house — and its commitments.\r\n";
    await writeFile(f.path, content);
    const prompt = await loadStrigoiPrompt(state, { alfredSkillPath: f.path, onError: f.onError });
    expect(prompt.startsWith(strigoiPrompt(state))).toBe(true);
    expect(prompt).toContain(content);
    expect(f.onError).not.toHaveBeenCalled();
    await writeFile(f.path, "Updated operator-approved guidance.\n");
    const next = await loadStrigoiPrompt(state, { alfredSkillPath: f.path });
    expect(next).toContain("Updated operator-approved guidance.");
    expect(next).not.toContain(content);
  });

  it.each(["missing", "empty", "directory", "oversized", "invalid-utf8"])("reports %s content without losing resident guidance or claiming activation", async kind => {
    const f = await fixture();
    if (kind === "empty") await writeFile(f.path, " \n\t");
    if (kind === "oversized") await writeFile(f.path, Buffer.alloc(64 * 1024 + 1, 65));
    if (kind === "invalid-utf8") await writeFile(f.path, Buffer.from([0xff]));
    const path = kind === "directory" ? f.root : f.path;
    const prompt = await loadStrigoiPrompt({}, { alfredSkillPath: path, onError: f.onError });
    expect(prompt.startsWith(strigoiPrompt({}))).toBe(true);
    expect(prompt).toContain("The Alfred skill was not loaded.");
    expect(prompt).not.toContain("Resident skill: Alfred");
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "STRIGOI_ALFRED_UNAVAILABLE", message: expect.stringContaining(path) }));
  });
});
