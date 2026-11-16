import { unlink } from "node:fs/promises";
import { join } from "node:path";

export async function pruneLegacyTranscript(
  stateDirectory: string,
  confirmed: boolean,
): Promise<{ path: string; removed: boolean }> {
  const path = join(stateDirectory, "threads", "transcript.jsonl");
  if (!confirmed) {
    throw new Error("Legacy transcript prune requires --confirm-delete-legacy-transcript");
  }
  try {
    await unlink(path);
    return { path, removed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, removed: false };
    throw error;
  }
}
