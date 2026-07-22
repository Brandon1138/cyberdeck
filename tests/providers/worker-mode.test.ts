import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyWorkerMode } from "../../src/providers/worker-mode.js";

describe("provider-neutral worker mode", () => {
  it("leaves normal worker instructions byte-exact", () => {
    expect(applyWorkerMode("Answer precisely.", "normal", {})).toBe("Answer precisely.");
  });

  it("loads the optional Caveman skill and keeps the worker task intact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-worker-mode-"));
    const skillPath = join(directory, "SKILL.md");
    await writeFile(skillPath, "---\nname: caveman\n---\nDrop articles. Keep code exact.\n");

    const instruction = applyWorkerMode("Answer precisely.", "caveman", {
      CYBERDECK_CAVEMAN_SKILL: skillPath,
    });
    expect(instruction).toContain("CAVEMAN MODE ACTIVE");
    expect(instruction).toContain("Drop articles. Keep code exact.");
    expect(instruction).not.toContain("name: caveman");
    expect(instruction).toContain("WORKER TASK\nAnswer precisely.");
  });

  it("falls back to a built-in policy when the optional box skill is absent", () => {
    const instruction = applyWorkerMode("Answer precisely.", "caveman", {
      CYBERDECK_CAVEMAN_SKILL: "/definitely/missing/caveman-skill.md",
    });
    expect(instruction).toContain("CAVEMAN MODE ACTIVE");
    expect(instruction).toContain("Keep code, commands, API names");
  });
});
