#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", () => resolve(""));
  });
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/u, "");
}

export function buildCavemanWorkerContext(env = process.env) {
  if (env.CYBERDECK_PROCESS_ROLE !== "worker" || env.CYBERDECK_WORKER_MODE !== "caveman") {
    return undefined;
  }

  const skillPath = env.CYBERDECK_CAVEMAN_SKILL
    ?? join(homedir(), ".local", "share", "cyberdeck", "caveman", "SKILL.md");
  const skill = stripFrontmatter(readFileSync(skillPath, "utf8")).trim();
  return `CAVEMAN MODE ACTIVE — worker policy.\n\n${skill}`;
}

export function hookOutput(context, hookEventName = "SessionStart") {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: context,
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = await readStdin();
  let input = {};
  try {
    input = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  try {
    const context = buildCavemanWorkerContext();
    if (context !== undefined) {
      process.stdout.write(hookOutput(context, input.hook_event_name ?? "SessionStart"));
    }
  } catch (error) {
    if (process.env.CYBERDECK_CAVEMAN_DEBUG === "1") {
      process.stderr.write(`[cyberdeck-caveman] ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
