import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCavemanWorkerContext,
  hookOutput,
} from "../../scripts/caveman-workers-session-start.mjs";

describe("Caveman worker SessionStart hook", () => {
  it("stays silent outside opted-in Cyberdeck workers", () => {
    expect(buildCavemanWorkerContext({})).toBeUndefined();
    expect(buildCavemanWorkerContext({
      CYBERDECK_PROCESS_ROLE: "orchestrator",
      CYBERDECK_WORKER_MODE: "caveman",
    })).toBeUndefined();
    expect(buildCavemanWorkerContext({
      CYBERDECK_PROCESS_ROLE: "worker",
      CYBERDECK_WORKER_MODE: "normal",
    })).toBeUndefined();
  });

  it("injects skill content only for an opted-in worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-caveman-hook-"));
    const skillPath = join(directory, "SKILL.md");
    await writeFile(skillPath, "---\nname: caveman\n---\nKeep code exact. Speak terse.\n");

    const context = buildCavemanWorkerContext({
      CYBERDECK_PROCESS_ROLE: "worker",
      CYBERDECK_WORKER_MODE: "caveman",
      CYBERDECK_CAVEMAN_SKILL: skillPath,
    });
    expect(context).toContain("Keep code exact. Speak terse.");
    expect(context).not.toContain("name: caveman");
    expect(JSON.parse(hookOutput(context!))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: expect.stringContaining("CAVEMAN MODE ACTIVE"),
      },
    });
  });
});
