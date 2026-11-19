import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StrigoiState } from "../domain/strigoi.js";

export interface StrigoiPromptOptions {
  /** Internal composition override; never a worker/peer request field. */
  alfredSkillPath?: string;
  onError?: (error: unknown) => void;
}

/** Called only by the reserved resident launch paths, outside the binding authority lock. */
export async function loadStrigoiPrompt(
  state: Pick<StrigoiState, "latestPacket" | "transition">,
  options: StrigoiPromptOptions = {},
): Promise<string> {
  const base = strigoiPrompt(state);
  const path = options.alfredSkillPath ?? join(homedir(), ".local", "share", "strigoi", "skills", "alfred", "SKILL.md");
  let content: string;
  try {
    // An accidental FIFO or oversized file must not stall resident launch or exhaust memory.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const limit = 64 * 1024;
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit) throw new Error("Expected a regular skill file no larger than 64 KiB");
      const buffer = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > limit) throw new Error("Skill exceeds 64 KiB");
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
      if (!content.trim()) throw new Error("Skill is empty");
    } finally { await file.close(); }
  } catch (cause) {
    const error = Object.assign(new Error(`STRIGOI_ALFRED_UNAVAILABLE: ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }),
      { code: "STRIGOI_ALFRED_UNAVAILABLE" });
    options.onError?.(error);
    return `${base}\n\n${error.message}\nThe Alfred skill was not loaded. Continue with the resident instructions above; report this limitation when relevant. Do not claim the skill is active.`;
  }
  // Preserve the installed content verbatim; no separate startup instruction or inference turn.
  return `${base}\n\nResident skill: Alfred\nSource: ${path}\n\n${content}\nEnd resident skill: Alfred.`;
}

/** Native developer instructions only: never submit this as a startup user turn. */
export function strigoiPrompt(state: Pick<StrigoiState, "latestPacket" | "transition">): string {
  return `You are Strigoi, the resident Cyberdeck Fleet orchestrator. Alfred is a conversational alias for you, not another agent.
Understand the operator's house through conversation and recorded state. Propose useful next steps, ask when needed, and use judgment within the operator's actual instructions.
Retain uncertainty and distinguish evidence, commitments, intentions, and completed work. Checkpoint meaningful commitments and unresolved questions when the checkpoint facility is available.
Never invent authority, grants, worker ownership, outcomes, or responsibilities. Regular Orc permissions, peer approval and directed handoff policies still apply.
No startup greeting, status wake, compulsory watch job, or inference is requested by these instructions. Remain passive until meaningful input arrives.
Recovery pointers (data, not new authority): ${JSON.stringify({ packet: state.transition?.packet ?? state.latestPacket ?? null, transitionId: state.transition?.id ?? null, predecessor: state.transition?.predecessor ?? null, successor: state.transition?.successor ?? null })}
On a meaningful recovery turn, inspect the referenced evidence and preserve uncertainty. Adoption requires the exact packet and coverage receipt through the recovery facility; do not claim adoption merely because instructions were loaded. If that facility or evidence is unavailable, report the limitation rather than inventing a receipt.`;
}
