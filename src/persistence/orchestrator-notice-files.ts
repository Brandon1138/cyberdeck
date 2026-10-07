import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  NOTICE_FILE_NAME, NOTICE_SHOWN_FILE_NAME, NoticeFileSchema, NoticeShownFileSchema,
  type NoticeFile, type NoticeShownFile,
} from "../domain/orchestrator-notice-file.js";
import type { NoticeFilePort } from "../orchestration/orchestrator-notice-file-port.js";
import { ensurePrivateDirectory } from "./private-files.js";

export class OrchestratorNoticeFiles implements NoticeFilePort {
  constructor(private readonly stateDirectory: string) {}

  private directory(sessionId: string): string {
    // These paths match the hook CLI without importing the delivery layer.
    return join(this.stateDirectory, "orchestrators", z.uuid().parse(sessionId));
  }

  async write(sessionId: string, file: NoticeFile): Promise<void> {
    const parsed = NoticeFileSchema.parse(file);
    if (parsed.sessionId !== sessionId) throw new Error("Notice session does not match file owner");
    const directory = this.directory(sessionId);
    await ensurePrivateDirectory(join(this.stateDirectory, "orchestrators"));
    await ensurePrivateDirectory(directory);
    const temporary = join(directory, `.${NOTICE_FILE_NAME}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(parsed), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, join(directory, NOTICE_FILE_NAME));
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async remove(sessionId: string): Promise<void> {
    await unlink(join(this.directory(sessionId), NOTICE_FILE_NAME)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async readShown(sessionId: string): Promise<NoticeShownFile | undefined> {
    try {
      const parsed = NoticeShownFileSchema.safeParse(JSON.parse(
        await readFile(join(this.directory(sessionId), NOTICE_SHOWN_FILE_NAME), "utf8"),
      ));
      return parsed.success ? parsed.data : undefined;
    } catch { return undefined; }
  }
}
