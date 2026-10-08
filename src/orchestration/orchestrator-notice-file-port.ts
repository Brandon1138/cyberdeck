import type { NoticeFile, NoticeShownFile } from "../domain/orchestrator-notice-file.js";

/** Session-scoped hook state; application services never depend on its filesystem adapter. */
export interface NoticeFilePort {
  write(sessionId: string, file: NoticeFile): Promise<void>;
  remove(sessionId: string): Promise<void>;
  readShown(sessionId: string): Promise<NoticeShownFile | undefined>;
}
