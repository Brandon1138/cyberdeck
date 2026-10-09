import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * The operator's voice preference, exactly as Claude's `/voice` persisted it.
 *
 * `/voice` writes `voiceEnabled` and `voice` to *user* settings, and nowhere else. An orchestrator
 * launches with `--setting-sources project,local`, so it never reads that file: `/voice` inside it
 * printed "Voice mode enabled" on every run (the toggle never saw its own write), and the
 * hold-to-talk handler's first guard returned on every space, so a held space was typed as spaces.
 * These two keys are copied into the orchestrator's `--settings` file instead of re-admitting user
 * scope, which is the token budget `addOrchestratorIsolation` exists to protect.
 *
 * `voice` is carried whole rather than field by field, so `mode`, `autoSubmit` and whatever Claude
 * adds next keep meaning what the operator set them to.
 */
export interface ClaudeOperatorVoice {
  voiceEnabled?: boolean;
  voice?: Record<string, unknown>;
}

const OperatorVoiceSchema = z.object({
  voiceEnabled: z.boolean().optional(),
  voice: z.record(z.string(), z.unknown()).optional(),
});

/** Claude's user settings file, which `CLAUDE_CONFIG_DIR` relocates along with the rest of `~/.claude`. */
export function claudeUserSettingsPath(environment: Readonly<NodeJS.ProcessEnv>): string {
  return join(environment.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}

/**
 * A missing, unreadable, or malformed file, or one with no voice keys, carries nothing: the
 * orchestrator then has voice off, which is what it had before, and never a failed launch.
 */
export async function readClaudeOperatorVoice(
  path: string,
): Promise<ClaudeOperatorVoice | undefined> {
  try {
    const parsed = OperatorVoiceSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) return undefined;
    const { voiceEnabled, voice } = parsed.data;
    if (voiceEnabled === undefined && voice === undefined) return undefined;
    return {
      ...(voiceEnabled === undefined ? {} : { voiceEnabled }),
      ...(voice === undefined ? {} : { voice }),
    };
  } catch {
    return undefined;
  }
}
