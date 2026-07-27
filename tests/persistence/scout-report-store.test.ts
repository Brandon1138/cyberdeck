import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScoutReportStore } from "../../src/persistence/scout-report-store.js";
import {
  SCOUT_REPORT_BEGIN,
  SCOUT_REPORT_END,
} from "../../src/orchestration/worker-profiles.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

const report = {
  findings: [{
    finding: "Cursor plan mode is selected for read-only sessions",
    evidence: [{
      path: "src/providers/cursor/commands.ts",
      symbol: "cursorSafetyArgs",
      lineRange: { start: 57, end: 67 },
    }],
  }],
  coverage: {
    searched: ["src/providers/cursor/**"],
    methods: ["rg for sandbox and mode; read command builder"],
  },
  uncertainties: ["No live Cursor call made"],
  suggestedFollowUpProbes: ["Run provider canary"],
};

describe("ScoutReportStore", () => {
  it("allocates one private drop box outside worktree and canonicalizes valid reports", async () => {
    const repo = await directory("cyberdeck-scout-repo-");
    const state = await directory("cyberdeck-scout-state-");
    const store = new ScoutReportStore(state);
    const runtime = await store.initialize("11111111-1111-4111-8111-111111111111", repo);

    expect(runtime.dropBoxPath.startsWith(repo)).toBe(false);
    expect(runtime.reportPath).toBe(join(runtime.dropBoxPath, "report.json"));
    const capture = await store.capture(
      runtime,
      `${SCOUT_REPORT_BEGIN}\n${JSON.stringify(report)}\n${SCOUT_REPORT_END}`,
    );

    expect(capture).toMatchObject({ state: "complete", report });
    expect(JSON.parse(await readFile(runtime.reportPath, "utf8"))).toEqual(report);
  });

  it("preserves partial report bytes and marks framed contract violations invalid", async () => {
    const repo = await directory("cyberdeck-scout-repo-");
    const state = await directory("cyberdeck-scout-state-");
    const store = new ScoutReportStore(state);
    const runtime = await store.initialize("22222222-2222-4222-8222-222222222222", repo);

    await expect(store.capture(runtime, `${SCOUT_REPORT_BEGIN}\n{"findings":[`))
      .resolves.toMatchObject({ state: "partial" });
    expect(await store.collect(runtime)).toEqual({
      state: "partial",
      text: '{"findings":[',
    });

    await expect(store.capture(
      runtime,
      `${SCOUT_REPORT_BEGIN}\n{"findings":[]}\n${SCOUT_REPORT_END}`,
    )).resolves.toMatchObject({ state: "invalid" });
  });

  it("does not promote complete JSON without closing frame marker after restart", async () => {
    const repo = await directory("cyberdeck-scout-repo-");
    const state = await directory("cyberdeck-scout-state-");
    const store = new ScoutReportStore(state);
    const runtime = await store.initialize("44444444-4444-4444-8444-444444444444", repo);
    const text = JSON.stringify(report);

    await expect(store.capture(runtime, `${SCOUT_REPORT_BEGIN}\n${text}`))
      .resolves.toMatchObject({ state: "partial", text });
    await expect(store.collect({ ...runtime, reportState: "missing" }))
      .resolves.toEqual({ state: "partial", text });
  });

  it("accepts fenced JSON while ignoring prompt contract placeholder", async () => {
    const repo = await directory("cyberdeck-scout-repo-");
    const state = await directory("cyberdeck-scout-state-");
    const store = new ScoutReportStore(state);
    const runtime = await store.initialize("33333333-3333-4333-8333-333333333333", repo);

    await expect(store.capture(
      runtime,
      [
        SCOUT_REPORT_BEGIN,
        "<JSON matching ScoutReportSchema>",
        SCOUT_REPORT_END,
        SCOUT_REPORT_BEGIN,
        "```json",
        JSON.stringify(report),
        "```",
        SCOUT_REPORT_END,
      ].join("\n"),
    )).resolves.toMatchObject({ state: "complete", report });
  });

  it("rejects drop-box state that overlaps the worker worktree", async () => {
    const state = await directory("cyberdeck-scout-overlap-");
    const repo = join(state, "scouts", "session", "worktree");
    await mkdir(repo, { recursive: true });

    await expect(new ScoutReportStore(state).initialize("session", repo))
      .rejects.toThrow("must not overlap");
  });

  it("never follows a replaced canonical report symlink", async () => {
    const repo = await directory("cyberdeck-scout-repo-");
    const state = await directory("cyberdeck-scout-state-");
    const store = new ScoutReportStore(state);
    const runtime = await store.initialize("55555555-5555-4555-8555-555555555555", repo);
    const target = join(repo, "protected.txt");
    await writeFile(target, "unchanged");
    await symlink(target, runtime.reportPath);

    await expect(store.capture(
      runtime,
      `${SCOUT_REPORT_BEGIN}\n${JSON.stringify(report)}\n${SCOUT_REPORT_END}`,
    )).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("unchanged");
  });

  it("removes only the named Scout drop box", async () => {
    const repo = await directory("cyberdeck-scout-repo-");
    const state = await directory("cyberdeck-scout-state-");
    const store = new ScoutReportStore(state);
    const first = await store.initialize("66666666-6666-4666-8666-666666666666", repo);
    const second = await store.initialize("77777777-7777-4777-8777-777777777777", repo);

    await store.remove("66666666-6666-4666-8666-666666666666");

    await expect(readFile(first.reportPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.collect(second)).resolves.toEqual({ state: "missing" });
    await expect(store.remove("../outside")).rejects.toThrow("must stay inside");
  });
});
