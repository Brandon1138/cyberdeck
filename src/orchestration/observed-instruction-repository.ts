import type { InstructionRecord } from "../domain/instruction.js";
import type { InstructionRepository } from "./session/session-ports.js";

/** Observe only successful writes; observation cannot change the persisted outcome. */
export function observeInstructionRepository(
  store: InstructionRepository,
  onPut: (record: InstructionRecord) => void,
): InstructionRepository {
  return {
    list: (targetSessionId) => store.list(targetSessionId),
    async put(record) {
      await store.put(record);
      try { await onPut(record); } catch { /* Listener failures never undo a successful write. */ }
    },
  };
}
