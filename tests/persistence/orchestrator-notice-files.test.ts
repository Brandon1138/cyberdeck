import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoticeFileSchema, type NoticeFile } from "../../src/domain/orchestrator-notice-file.js";
import { OrchestratorNoticeFiles } from "../../src/persistence/orchestrator-notice-files.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const file: NoticeFile = {
  schemaVersion: 1, controllerId: "controller", sessionId: SESSION, cursor: 2,
  noticedCursor: 0, pending: 2, dropped: 0, text: "cyberdeck: pending",
  writtenAt: "2026-10-07T10:00:00.000Z",
};

describe("OrchestratorNoticeFiles", () => {
  let directory: string;
  let files: OrchestratorNoticeFiles;
  const sessionDirectory = () => join(directory, "orchestrators", SESSION);
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cyberdeck-notice-files-"));
    files = new OrchestratorNoticeFiles(directory);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("atomically writes and replaces validated private files at the hook path", async () => {
    await files.write(SESSION, file);
    await files.write(SESSION, { ...file, cursor: 3, noticedCursor: 2 });
    const path = join(sessionDirectory(), "notice.json");
    expect(NoticeFileSchema.parse(JSON.parse(await readFile(path, "utf8"))))
      .toEqual({ ...file, cursor: 3, noticedCursor: 2 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(sessionDirectory())).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "orchestrators"))).mode & 0o777).toBe(0o700);
    expect(await readdir(sessionDirectory())).toEqual(["notice.json"]);
  });

  it("removes only the notice and tolerates an absent directory or file", async () => {
    await files.remove(SESSION);
    await files.write(SESSION, file);
    await writeFile(join(sessionDirectory(), "notice-shown.json"), "{}");
    await files.remove(SESSION);
    await files.remove(SESSION);
    expect(await readdir(sessionDirectory())).toEqual(["notice-shown.json"]);
  });

  it("reads a valid sidecar and ignores missing, malformed or schema-invalid content", async () => {
    expect(await files.readShown(SESSION)).toBeUndefined();
    await files.write(SESSION, file);
    expect(await files.readShown(SESSION)).toBeUndefined();
    const path = join(sessionDirectory(), "notice-shown.json");
    const shown = { schemaVersion: 1, cursor: 2, shownAt: file.writtenAt, via: "codex" };
    await writeFile(path, JSON.stringify(shown));
    expect(await files.readShown(SESSION)).toEqual(shown);
    for (const malformed of ["{", "null", '{"schemaVersion":1,"cursor":-1}', "{}"] ) {
      await writeFile(path, malformed);
      expect(await files.readShown(SESSION)).toBeUndefined();
    }
  });

  it("rejects mismatched owners and invalid session paths before writing", async () => {
    await expect(files.write("../../elsewhere", file)).rejects.toThrow();
    await expect(files.write(SESSION, { ...file, sessionId: "22222222-2222-4222-8222-222222222222" }))
      .rejects.toThrow("Notice session does not match file owner");
    expect(await readdir(directory)).toEqual([]);
  });
});
