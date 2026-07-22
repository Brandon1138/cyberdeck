import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkerMode } from "../domain/session.js";

const MARKER = "CAVEMAN MODE ACTIVE — Cyberdeck worker output policy.";
const FALLBACK_POLICY = [
  "Respond terse like smart caveman. Keep all technical substance.",
  "Drop articles, filler, pleasantries, and hedging. Fragments are fine.",
  "Keep code, commands, API names, technical terms, and error strings exact.",
  "Apply this policy to every response for this worker session.",
].join("\n");

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/u, "");
}

/** Load the optional box skill, with a small built-in policy so enabled mode never silently no-ops. */
export function cavemanWorkerPolicy(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.CYBERDECK_CAVEMAN_SKILL
    ?? join(homedir(), ".local", "share", "cyberdeck", "caveman", "SKILL.md");
  try {
    const skill = stripFrontmatter(readFileSync(path, "utf8")).trim();
    if (skill !== "") return `${MARKER}\n\n${skill}`;
  } catch {
    // Caveman is optional. Enabled mode retains deterministic baseline behavior without the skill.
  }
  return `${MARKER}\n\n${FALLBACK_POLICY}`;
}

/** Add worker-only output policy to the provider's actual task input, independent of hook support. */
export function applyWorkerMode(
  instruction: string,
  mode: WorkerMode | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (mode !== "caveman" || instruction.includes(MARKER)) return instruction;
  return `${cavemanWorkerPolicy(env)}\n\nWORKER TASK\n${instruction}`;
}
